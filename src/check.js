import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from './client.js';
import * as e from './ecampus.js';

const c = new Client();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecampus-check-'));
const step = async (name, fn) => {
  const t = Date.now();
  const r = await fn();
  console.log(`ok  ${name} (${Date.now() - t}ms)`);
  return r;
};

const current = await step('courses', () => e.courses(c));
assert(current.length > 0 && current.every((x) => x.current));
const all = await step('courses all', () => e.courses(c, { all: true }));
assert(all.length > current.length);
const regular = current.find((x) => x.code);

const contents = await step('courseContents', () => e.courseContents(c, regular.id));
assert(contents.some((s) => s.modules.length));

const items = await step('todo', () => e.todo(c));
assert(items.every((x) => x.due && typeof x.done === 'boolean'));
console.log('    ', items.slice(0, 3).map((x) => `${x.due} [${x.type}] ${x.name} done=${x.done}`).join('\n      '));

const withVideos = await (async () => {
  for (const x of current) if ((await e.videoProgress(c, x.id)).length) return x;
})();
const progress = await step('videoProgress', () => e.videoProgress(c, withVideos.id));
assert(progress.every((p) => p.cmid && p.length_sec >= 0));

const assignCm = contents.flatMap((s) => s.modules).find((m) => m.type === 'assign')
  ?? (await Promise.all(current.map((x) => e.courseContents(c, x.id)))).flat().flatMap((s) => s.modules).find((m) => m.type === 'assign');
const a = await step('assignment', () => e.assignment(c, assignCm.cmid));
assert(a.name && a.submission.status);

await step('grades overview', async () => assert((await e.grades(c)).length > 0));
await step('grades course', async () => assert((await e.grades(c, regular.id)).length > 0));

const boards = await step('boards', () => e.boards(c, regular.id));
const list = await step('posts', () => e.posts(c, 2, { page: 2 }));
assert(list.posts.length > 0 && list.last_page >= 2);
const readable = list.posts.find((x) => x.post_id && x.comments > 0);
assert(readable, 'Q&A 2페이지에 댓글 달린 공개글이 있어야 합니다');
const p = await step('post', () => e.post(c, 2, readable.post_id));
assert(p.comments.length === readable.comments);
assert(p.title && typeof p.content === 'string');
console.log(`     boards=${boards.length}, post "${p.title}" comments=${p.comments.length}`);

await step('notifications', () => e.notifications(c, 5));

const s = await step('syllabus', () => e.syllabus(c, regular.id, tmp));
assert(fs.readFileSync(s.pdf).subarray(0, 4).toString() === '%PDF' && fs.statSync(s.pdf).size > 20000);
assert(s.text.includes('수 업 계 획 서') || s.text.includes('수업계획서') || s.text.includes('pdftotext'));

const file = contents.flatMap((sec) => sec.modules).flatMap((m) => m.files || [])[0];
const d = await step('download', () => e.download(c, file.url, tmp));
assert(d.bytes === file.bytes);

console.log(`\nall checks passed (${tmp})`);
