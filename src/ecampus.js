import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as cheerio from 'cheerio';
import { BASE, EcampusError } from './client.js';

const DOWNLOAD_DIR = process.env.ECAMPUS_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'ecampus');
const TERMS = { 10: '1학기', 11: '여름학기', 20: '2학기', 21: '겨울학기' };
const SITE_BOARDS = [
  { board_id: 1, name: '공지사항' },
  { board_id: 2, name: 'Q&A' },
  { board_id: 4, name: 'FAQ' },
];

const now = () => Math.floor(Date.now() / 1000);
const kst = (sec) => (sec ? new Date(sec * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) : null);
const safeName = (s) => s.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 150).replace(/^\.*$/, '_');
const resolveDir = (dir = DOWNLOAD_DIR) => path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
const customdata = (m) => {
  try {
    return JSON.parse(m.customdata || '{}');
  } catch {
    return {};
  }
};

function freePath(file, taken = new Set()) {
  const { dir, name, ext } = path.parse(file);
  let candidate = file;
  for (let i = 2; taken.has(candidate) || fs.existsSync(candidate); i++) candidate = path.join(dir, `${name} (${i})${ext}`);
  taken.add(candidate);
  return candidate;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function htmlToText(html) {
  if (!html) return '';
  const $ = cheerio.load(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n'));
  return $.root().text().replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function parseCourse(c) {
  const m = c.shortname.match(/\((\d{4})-(\d{2}), (\w+?)_(\d+)_/);
  return {
    id: c.id,
    name: c.fullname,
    ...(m && { year: +m[1], term: TERMS[m[2]] || m[2], code: `${m[3]}-${m[4]}`, termCode: m[2] }),
    current: !c.enddate || c.enddate > now(),
    start: kst(c.startdate)?.slice(0, 10),
    end: kst(c.enddate)?.slice(0, 10),
  };
}

export async function courses(c, { all = false } = {}) {
  const list = (await c.ws('core_enrol_get_users_courses', { userid: c.userid }))
    .map(parseCourse)
    .sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  return (all ? list : list.filter((x) => x.current)).map(({ termCode, ...x }) => x);
}

async function findCourse(c, courseId) {
  const list = (await c.ws('core_enrol_get_users_courses', { userid: c.userid })).map(parseCourse);
  const course = list.find((x) => x.id === courseId);
  if (!course) throw new EcampusError(`수강 중이거나 수강했던 강좌가 아닙니다: ${courseId}`);
  return course;
}

function videoInfo(m) {
  const d = customdata(m);
  return {
    length_sec: +d.playtime || null,
    open: kst(+d.timeopen),
    due: kst(+d.timeclose),
    late_until: +d.timelateness > +d.timeclose ? kst(+d.timelateness) : undefined,
    required_pct: +d.completionprogress || undefined,
    attendance_tracked: d.progress === '1',
  };
}

function moduleInfo(m) {
  const files = (m.contents || []).filter((f) => f.type === 'file').map((f) => ({ name: f.filename, url: f.fileurl, bytes: f.filesize }));
  return {
    cmid: m.id,
    type: m.modname,
    name: m.name,
    ...(m.completiondata && { done: m.completiondata.state > 0 }),
    ...(m.modname === 'label' && { text: htmlToText(m.description) }),
    ...(m.modname === 'url' && { link: m.contents?.[0]?.fileurl }),
    ...(m.modname === 'xncommons' && { video: videoInfo(m) }),
    ...(m.modname !== 'url' && files.length && { files }),
  };
}

export async function courseContents(c, courseId) {
  const sections = await c.ws('core_course_get_contents', { courseid: courseId });
  return sections
    .filter((s) => s.modules.length || s.summary)
    .map((s) => ({ section: s.name, ...(s.summary && { summary: htmlToText(s.summary) }), modules: s.modules.map(moduleInfo) }));
}

export async function videoProgress(c, courseId) {
  const $ = cheerio.load(await c.page(`/local/ubonattend/my_status.php?id=${courseId}`));
  const table = $('table').first();
  const headers = table.find('tr').first().children('th').map((_, th) => $(th).text().replace(/\s+/g, '')).get();
  const nameCol = headers.indexOf('강의자료');
  if (nameCol < 0 && table.length) throw new EcampusError('진도현황 표 형식을 인식하지 못했습니다.');
  let week = null;
  const rows = [];
  table.find('tr').each((_, tr) => {
    const tds = $(tr).children('td');
    const link = tds.find('a[href*="xncommons/view.php"]').first();
    if (!link.length) return;
    const i = tds.index(link.closest('td'));
    if (i > 0) week = tds.eq(0).text().trim();
    const cell = (header) => {
      const k = headers.indexOf(header);
      return k < 0 ? null : tds.eq(i + k - nameCol);
    };
    const sec = (header) => (cell(header) ? +cell(header).attr('title') || 0 : undefined);
    const progressText = cell('진도율')?.text().replace(/\s+/g, ' ').trim();
    rows.push({
      week,
      cmid: +new URL(link.attr('href'), BASE).searchParams.get('id'),
      name: link.text().trim(),
      length_sec: sec('콘텐츠길이'),
      required_sec: sec('출석인정요구시간'),
      max_position_sec: sec('누적최대학습구간'),
      watched_sec: sec('누적열람시간'),
      progress_pct: progressText ? parseFloat(progressText) || 0 : undefined,
      attendance: progressText?.match(/\(([^)]+)\)/)?.[1] || cell('출결상태')?.text().trim() || null,
      week_attendance: cell('주차출결상태')?.text().trim() || undefined,
    });
  });
  return rows;
}

export async function todo(c, { courseId, days, includePast = false } = {}) {
  const list = courseId ? [await findCourse(c, courseId)] : await courses(c);
  const ids = list.map((x) => x.id);
  const nameOf = Object.fromEntries(list.map((x) => [x.id, x.name]));
  const [assigns, quizzes, feedbacks, contents] = await Promise.all([
    c.ws('mod_assign_get_assignments', { courseids: ids }),
    c.ws('mod_quiz_get_quizzes_by_courses', { courseids: ids }),
    c.ws('mod_feedback_get_feedbacks_by_courses', { courseids: ids }),
    Promise.all(ids.map((id) => c.ws('core_course_get_contents', { courseid: id }).then((s) => [id, s]))),
  ]);

  const items = [];
  const tasks = [];
  for (const course of assigns.courses) {
    for (const a of course.assignments.filter((a) => a.duedate)) {
      tasks.push(c.ws('mod_assign_get_submission_status', { assignid: a.id }).then((s) => {
        const sub = s.lastattempt?.teamsubmission || s.lastattempt?.submission;
        items.push({
          type: '과제', course: nameOf[course.id], name: a.name, cmid: a.cmid,
          due: kst(s.lastattempt?.extensionduedate || a.duedate), dueTs: s.lastattempt?.extensionduedate || a.duedate,
          done: sub?.status === 'submitted', status: sub?.status,
          ...(s.feedback?.gradefordisplay && { grade: htmlToText(s.feedback.gradefordisplay) }),
        });
      }));
    }
  }
  for (const q of quizzes.quizzes.filter((q) => q.timeclose)) {
    tasks.push(c.ws('mod_quiz_get_user_attempts', { quizid: q.id, status: 'all' }).then((r) => {
      items.push({
        type: '퀴즈', course: nameOf[q.course], name: q.name, cmid: q.coursemodule,
        open: kst(q.timeopen), due: kst(q.timeclose), dueTs: q.timeclose,
        done: r.attempts.some((x) => x.state === 'finished'), attempts: r.attempts.length,
      });
    }));
  }
  for (const f of feedbacks.feedbacks.filter((f) => f.timeclose)) {
    tasks.push(c.ws('mod_feedback_get_last_completed', { feedbackid: f.id }).then(() => true, () => false).then((done) => {
      items.push({ type: '설문', course: nameOf[f.course], name: f.name, cmid: f.coursemodule, due: kst(f.timeclose), dueTs: f.timeclose, done });
    }));
  }
  for (const [id, sections] of contents) {
    const videos = sections.flatMap((s) => s.modules).filter((m) => m.modname === 'xncommons' && +customdata(m).timeclose);
    if (!videos.length) continue;
    tasks.push(videoProgress(c, id).then((progress) => {
      const pct = Object.fromEntries(progress.map((p) => [p.cmid, p]));
      for (const m of videos) {
        const v = videoInfo(m);
        const dueTs = +customdata(m).timeclose;
        items.push({
          type: '동영상', course: nameOf[id], name: m.name, cmid: m.id, open: v.open, due: v.due, dueTs,
          done: m.completiondata ? m.completiondata.state > 0 : pct[m.id]?.attendance === 'O',
          ...(pct[m.id] && { progress_pct: pct[m.id].progress_pct, attendance: pct[m.id].attendance }),
          ...(v.late_until && { late_until: v.late_until }),
        });
      }
    }));
  }
  await Promise.all(tasks);

  const t = now();
  return items
    .filter((x) => includePast || x.dueTs >= t)
    .filter((x) => !days || x.dueTs <= t + days * 86400)
    .sort((a, b) => a.dueTs - b.dueTs)
    .map(({ dueTs, ...x }) => x);
}

export async function assignment(c, cmid) {
  const { cm } = await c.ws('core_course_get_course_module', { cmid });
  const { courses: list } = await c.ws('mod_assign_get_assignments', { courseids: [cm.course] });
  const a = list.flatMap((x) => x.assignments).find((x) => x.cmid === cmid);
  if (!a) throw new EcampusError(`과제를 찾을 수 없습니다: ${cmid}`);
  const s = await c.ws('mod_assign_get_submission_status', { assignid: a.id });
  const sub = s.lastattempt?.teamsubmission || s.lastattempt?.submission;
  const plugins = sub?.plugins || [];
  const feedbackPlugins = s.feedback?.plugins || [];
  return {
    name: a.name,
    opens: kst(a.allowsubmissionsfromdate),
    due: kst(s.lastattempt?.extensionduedate || a.duedate),
    cutoff: kst(a.cutoffdate),
    intro: htmlToText(a.intro),
    attachments: (a.introattachments || []).map((f) => ({ name: f.filename, url: f.fileurl, bytes: f.filesize })),
    submission: {
      status: sub?.status || 'new',
      modified: kst(sub?.timemodified),
      text: htmlToText(plugins.find((p) => p.type === 'onlinetext')?.editorfields?.[0]?.text) || undefined,
      files: plugins.flatMap((p) => p.fileareas || []).flatMap((fa) => fa.files || [])
        .map((f) => ({ name: f.filename, url: f.fileurl, bytes: f.filesize })),
    },
    grade: s.feedback?.gradefordisplay ? htmlToText(s.feedback.gradefordisplay) : null,
    feedback: feedbackPlugins.flatMap((p) => p.editorfields || []).map((e) => htmlToText(e.text)).filter(Boolean).join('\n') || undefined,
  };
}

export async function grades(c, courseId) {
  if (courseId) {
    const { usergrades } = await c.ws('gradereport_user_get_grade_items', { courseid: courseId, userid: c.userid });
    return usergrades[0].gradeitems.map((g) => ({
      name: g.itemname || (g.itemtype === 'course' ? '강좌 총점' : g.itemtype),
      grade: g.gradeformatted,
      range: g.rangeformatted,
      percentage: g.percentageformatted,
      ...(g.feedback && { feedback: htmlToText(g.feedback) }),
    }));
  }
  const [{ grades: list }, all] = await Promise.all([
    c.ws('gradereport_overview_get_course_grades', { userid: c.userid }),
    courses(c, { all: true }),
  ]);
  const byId = Object.fromEntries(all.map((x) => [x.id, x]));
  return list.map((g) => ({ course_id: g.courseid, course: byId[g.courseid]?.name, year: byId[g.courseid]?.year, term: byId[g.courseid]?.term, grade: g.grade }));
}

export async function boards(c, courseId) {
  if (!courseId) return SITE_BOARDS;
  const sections = await c.ws('core_course_get_contents', { courseid: courseId });
  return sections.flatMap((s) => s.modules).filter((m) => m.modname === 'ubboard').map((m) => ({ board_id: m.id, name: m.name }));
}

export async function posts(c, boardId, { page = 1, keyword } = {}) {
  const q = new URLSearchParams({ id: boardId, page, ...(keyword && { keyfield: 'subject', keyword }) });
  const $ = cheerio.load(await c.page(`/mod/ubboard/view.php?${q}`));
  const list = [];
  $('table.table-ubboard-list tbody tr').each((_, tr) => {
    const row = $(tr);
    if (!row.find('td.t-number').length) return;
    const subject = row.find('td.t-subject');
    const href = subject.find('a[href*="bwid="]').attr('href');
    const secret = subject.find('img[alt=secret]').length > 0;
    list.push({
      post_id: href ? +new URL(href, BASE).searchParams.get('bwid') : null,
      notice: row.find('td.t-number').text().trim() === '공지' || undefined,
      title: (subject.find('a').text() || subject.text()).replace(/\s+/g, ' ').replace(/\[\d+\]$/, '').trim(),
      comments: +(subject.text().match(/\[(\d+)\]/)?.[1] || 0),
      ...(secret && { secret: true }),
      author: row.find('td.t-writer').text().trim(),
      date: row.find('td.t-date span').attr('title') || row.find('td.t-date').text().trim(),
      views: +row.find('td.t-viewcount').text().trim() || 0,
    });
  });
  const pages = $('a[href*="page="]').map((_, a) => +new URL($(a).attr('href'), BASE).searchParams.get('page') || 0).get();
  return { board: $('h2').first().text().trim(), page, last_page: Math.max(page, ...pages), posts: list };
}

export async function post(c, boardId, postId) {
  const $ = cheerio.load(await c.page(`/mod/ubboard/article.php?id=${boardId}&bwid=${postId}`));
  if (!$('.article-subject').length) throw new EcampusError('글을 볼 수 없습니다 (비밀글이거나 권한이 없습니다).');
  const info = Object.fromEntries($('.article-info .col-info').map((_, el) => {
    const [k, ...v] = $(el).text().split(':');
    return [[k.trim(), v.join(':').trim()]];
  }).get());
  return {
    title: $('.article-subject h3').text().trim(),
    author: info['작성자'],
    date: info['작성일'],
    views: +info['조회수'] || 0,
    content: htmlToText($('.article-content').html()),
    attachments: $('.article-files a[href]').map((_, a) => ({ name: $(a).text().trim(), url: new URL($(a).attr('href'), BASE).href })).get(),
    comments: $('#ubboard-comment .comment-lists .media').map((_, el) => {
      const m = $(el);
      return {
        author: m.find('.userinfo .info').first().text().trim(),
        date: m.find('.userinfo span[title]').attr('title'),
        ...(parseInt(m.attr('style')?.match(/margin-left:\s*(\d+)/)?.[1] || 0) > 0 && { reply: true }),
        text: htmlToText(m.find('.comment-content').first().html()),
      };
    }).get(),
  };
}

export async function notifications(c, limit = 20) {
  const { notifications: list, unreadcount } = await c.ws('message_popup_get_popup_notifications', { useridto: c.userid, limit, newestfirst: 1 });
  return {
    unread: unreadcount,
    notifications: list.map((n) => ({ subject: n.subject, time: kst(n.timecreated), read: n.read, url: n.contexturl, text: htmlToText(n.smallmessage || n.fullmessage) })),
  };
}

export async function syllabus(c, courseId, dir) {
  const course = await findCourse(c, courseId);
  if (!course.code) throw new EcampusError('정규 교과목만 강의계획서를 조회할 수 있습니다.');
  const [code, section] = course.code.split('-');
  const reportList = `${course.year}${course.termCode}20000${code}${section}`;
  const K = 'https://kep.kookmin.ac.kr/report/';
  const params = Buffer.from(JSON.stringify({ mlangCd: 'ko', reportList, loginYn: 0 })).toString('base64');
  const html = await (await c.request(`${K}callReport.jsp`, {
    method: 'POST',
    form: { filePath: 'sch/sles/slesfm/slesfm0340_prn03', paramType: 'query', reportBtn: 'PEH', reportParams: params },
  })).text();
  const reportkey = html.match(/'uid':'(\w+)'/)?.[1];
  if (!reportkey) throw new EcampusError('강의계획서 리포트를 만들지 못했습니다.');
  const clip = async (type, data) => {
    const res = await c.request(`${K}report_server.jsp`, { method: 'POST', form: { ClipType: type, ClipData: JSON.stringify(data) } });
    return type === 'saveExportDownload' ? Buffer.from(await res.arrayBuffer()) : JSON.parse((await res.text()).trim()).resValue;
  };

  let check;
  for (let i = 0; i < 60 && !(check = await clip('pageCheck', { reportkey, s_time: `t${i}` })).endReport; i++) await sleep(500);
  if (!check.endReport) throw new EcampusError('강의계획서 생성이 시간 안에 끝나지 않았습니다.');
  if (!check.count) throw new EcampusError('강의계획서가 등록되지 않았습니다.');
  const exportData = {
    reportkey, startNum: 1, endNum: check.count, fileName: Buffer.from('syllabus').toString('base64'),
    isIE: false, isEdge: false, exportType: 3, isSmartphone: false,
    option: { userpw: '', textToImage: false, importOriginImage: false, removeHyperlink: false },
  };
  await clip('saveExport', exportData);
  for (let i = 0; i < 60 && !(await clip('fileDownloadCheck', { reportkey, s_time: `d${i}` })).status; i++) await sleep(500);
  const pdf = await clip('saveExportDownload', exportData);
  if (pdf.subarray(0, 4).toString() !== '%PDF') throw new EcampusError('강의계획서 PDF 내보내기에 실패했습니다.');

  const file = path.join(resolveDir(dir), safeName(course.name), `${safeName(course.name)}_강의계획서_${course.year}_${course.term}.pdf`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pdf);
  const text = await promisify(execFile)('pdftotext', ['-layout', file, '-']).then((r) => r.stdout, () => null);
  return { pdf: file, text: text ?? '(텍스트 추출에는 poppler의 pdftotext가 필요합니다: brew install poppler)' };
}

function fileNameFromUrl(url) {
  return decodeURIComponent(new URL(url).pathname.split('/').pop());
}

export async function download(c, url, dir, name) {
  if (new URL(url).origin !== BASE) throw new EcampusError('eCampus 파일 URL만 받을 수 있습니다.');
  return c.download(url, freePath(path.join(resolveDir(dir), safeName(name || fileNameFromUrl(url)))));
}

export async function downloadCourseFiles(c, courseId, dir) {
  const course = await findCourse(c, courseId);
  const [sections, { courses: assignCourses }] = await Promise.all([
    c.ws('core_course_get_contents', { courseid: courseId }),
    c.ws('mod_assign_get_assignments', { courseids: [courseId] }),
  ]);
  const root = path.join(resolveDir(dir), safeName(course.name));
  const jobs = [];
  const used = new Set();
  const add = (url, bytes, folder, filename, owner) => {
    let dest = path.join(root, ...folder.map(safeName), safeName(filename));
    if (used.has(dest)) dest = path.join(root, ...folder.map(safeName), safeName(`${owner}_${filename}`));
    used.add(dest);
    jobs.push({ url, bytes, dest });
  };
  for (const s of sections) {
    for (const m of s.modules) {
      for (const f of (m.contents || []).filter((f) => f.type === 'file' && m.modname !== 'url')) add(f.fileurl, f.filesize, [s.name], f.filename, m.name);
    }
  }
  for (const a of assignCourses.flatMap((x) => x.assignments)) {
    for (const f of a.introattachments || []) add(f.fileurl, f.filesize, ['과제', a.name], f.filename, a.name);
  }
  const result = { folder: root, downloaded: [], skipped: 0, failed: [] };
  for (const job of jobs) {
    if (fs.existsSync(job.dest) && fs.statSync(job.dest).size === job.bytes) { result.skipped++; continue; }
    await c.download(job.url, job.dest).then(
      () => result.downloaded.push(path.relative(root, job.dest)),
      (e) => result.failed.push({ file: path.relative(root, job.dest), error: e.message }),
    );
  }
  return result;
}

export async function downloadVideo(c, cmid, dir) {
  const html = await c.page(`/mod/xncommons/viewer.php?id=${cmid}`);
  const $ = cheerio.load(html);
  const src = $('#ViewerFrame').attr('src');
  const contentId = src && new URL(src, BASE).searchParams.get('content_id');
  if (!contentId) throw new EcampusError('동영상 정보를 찾을 수 없습니다 (열람 기간이 아니거나 접근 권한이 없습니다).');
  const xml = await (await fetch(`https://kcms.kookmin.ac.kr/viewer/ssplayer/uniplayer_support/content.php?content_id=${contentId}`)).text();
  const x = cheerio.load(xml, { xmlMode: true });
  const template = x('media_uri[method=progressive][target=all]').first().text().trim();
  const urls = template
    ? x('main_media_list > main_media').map((_, el) => template.replace('[MEDIA_FILE]', x(el).text().trim())).get()
    : x('main_media > desktop > html5 > media_uri').map((_, el) => x(el).text().trim()).get();
  if (!urls.length) throw new EcampusError('다운로드할 수 있는 영상 파일이 없는 콘텐츠입니다.');
  const title = safeName(x('content_metadata > title').text().trim() || $('title').text().split(':').pop().trim() || contentId);
  const courseName = safeName($('title').text().split(':')[0].replace(/\s*\(.*$/, '').trim() || 'videos');
  const saved = [];
  for (const [i, url] of urls.entries()) {
    const ext = path.extname(new URL(url).pathname) || '.mp4';
    const dest = freePath(path.join(resolveDir(dir), courseName, '동영상', `${title}${urls.length > 1 ? `_${i + 1}` : ''}${ext}`));
    saved.push(await c.download(url, dest));
  }
  return saved;
}
