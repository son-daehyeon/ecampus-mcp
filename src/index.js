#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createInterface } from 'node:readline/promises';
import { Client, CREDENTIALS_FILE, writePrivate } from './client.js';
import * as e from './ecampus.js';

if (process.argv[2] === 'login') {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  process.stdout.write('eCampus 아이디: ');
  const id = (await lines.next()).value?.trim();
  process.stdout.write('비밀번호: ');
  rl._writeToOutput = () => {};
  const pw = (await lines.next()).value;
  rl.close();
  process.stdout.write('\n로그인 확인 중...\n');
  try {
    await new Client(id, pw).login();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  writePrivate(CREDENTIALS_FILE, { id, pw });
  console.log(`로그인 성공. ${CREDENTIALS_FILE} 에 저장했습니다.`);
  process.exit(0);
}

process.on('unhandledRejection', (err) => console.error(err));

let client;
const getClient = () => (client ||= new Client());

const server = new McpServer({ name: 'ecampus', version: '0.1.0' });

const courseId = z.number().int().describe('강좌 ID (list_courses의 id)');
const saveDir = z.string().optional().describe('저장할 폴더. 기본값 ~/Downloads/ecampus');

function tool(name, description, inputSchema, run, { readOnly = true } = {}) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, openWorldHint: true } }, async (args) => {
    try {
      const result = await run(getClient(), args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  });
}

tool('list_courses', '수강 중인 강좌 목록. include_past=true면 과거 학기 강좌까지 모두 반환한다.',
  { include_past: z.boolean().optional() },
  (c, a) => e.courses(c, { all: a.include_past }));

tool('get_course', '강좌의 주차별 구성(자료 파일, 동영상, 과제, 퀴즈, 게시판, 링크)과 각 활동의 완료 여부.',
  { course_id: courseId },
  (c, a) => e.courseContents(c, a.course_id));

tool('get_todo', '마감 기한이 있는 할 일(과제, 동영상, 퀴즈, 설문)을 마감순으로 반환한다. done은 제출/수강 완료 여부, 동영상은 진도율과 출석 상태 포함.',
  {
    course_id: courseId.optional().describe('특정 강좌만 볼 때'),
    days: z.number().int().positive().optional().describe('앞으로 N일 안에 마감되는 것만'),
    include_past: z.boolean().optional().describe('마감이 지난 항목도 포함'),
  },
  (c, a) => e.todo(c, { courseId: a.course_id, days: a.days, includePast: a.include_past }));

tool('get_video_progress', '강좌의 동영상별 진도현황: 영상 길이, 누적 최대 학습구간, 누적 열람시간, 진도율, 출석(O/X).',
  { course_id: courseId },
  (c, a) => e.videoProgress(c, a.course_id));

tool('get_assignment', '과제 상세: 본문, 첨부파일, 기한, 내 제출 상태와 제출 파일, 점수와 피드백.',
  { cmid: z.number().int().describe('과제 cmid (get_course/get_todo의 cmid)') },
  (c, a) => e.assignment(c, a.cmid));

tool('get_grades', '성적. course_id가 있으면 그 강좌의 성적 항목별 점수, 없으면 전체 강좌 성적 요약.',
  { course_id: courseId.optional() },
  (c, a) => e.grades(c, a.course_id));

tool('list_boards', '게시판 목록. course_id가 있으면 강좌 게시판(공지사항, Q&A 등), 없으면 사이트 전체 게시판.',
  { course_id: courseId.optional() },
  (c, a) => e.boards(c, a.course_id));

tool('list_posts', '게시판 글 목록 (페이지 단위). comments는 댓글 수.',
  {
    board_id: z.number().int().describe('list_boards의 board_id'),
    page: z.number().int().positive().optional(),
    keyword: z.string().optional().describe('제목 검색어'),
  },
  (c, a) => e.posts(c, a.board_id, { page: a.page, keyword: a.keyword }));

tool('read_post', '게시글 본문, 첨부파일, 댓글.',
  { board_id: z.number().int(), post_id: z.number().int().describe('list_posts의 post_id') },
  (c, a) => e.post(c, a.board_id, a.post_id));

tool('get_notifications', '최근 eCampus 알림.',
  { limit: z.number().int().positive().max(50).optional() },
  (c, a) => e.notifications(c, a.limit));

tool('get_syllabus', '강의계획서를 PDF로 저장하고 텍스트(주차별 수업계획, 평가방법 등)를 반환한다. 과거 학기 강좌도 가능.',
  { course_id: courseId, save_dir: saveDir },
  (c, a) => e.syllabus(c, a.course_id, a.save_dir), { readOnly: false });

tool('download_file', 'eCampus 파일 URL(강의자료, 과제 첨부, 게시판 첨부, 내 제출 파일)을 내려받는다.',
  { url: z.string().url(), save_dir: saveDir, filename: z.string().optional() },
  (c, a) => e.download(c, a.url, a.save_dir, a.filename), { readOnly: false });

tool('download_course_files', '강좌의 모든 자료 파일과 과제 첨부파일을 주차별 폴더로 내려받는다. 이미 받은 파일은 건너뛴다.',
  { course_id: courseId, save_dir: saveDir },
  (c, a) => e.downloadCourseFiles(c, a.course_id, a.save_dir), { readOnly: false });

tool('download_video', '동영상 원본(mp4)을 내려받는다. 플레이어를 실행하지 않으므로 진도는 기록되지 않지만, 동영상 열람 페이지 접근 기록은 남을 수 있다.',
  { cmid: z.number().int().describe('동영상 cmid'), save_dir: saveDir },
  (c, a) => e.downloadVideo(c, a.cmid, a.save_dir), { readOnly: false });

await server.connect(new StdioServerTransport());
