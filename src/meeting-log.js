import path from 'node:path';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { projectPath } from './paths.js';
import { acquireIpcLock, atomicJson, stamp } from './runlog.js';

const meetingIdPattern = /^ask-\d{8}-\d{6}(?:-[1-9]\d*)?$/;
const meetingRoot = cwd => projectPath(cwd, '.crew/meetings');
export const meetingFile = (directory, relative) => projectPath(directory, relative);

export async function createMeeting(cwd, question, config) {
  const root = await meetingRoot(cwd);
  await mkdir(root, { recursive: true });
  const now = new Date();
  const prefix = `ask-${stamp(now)}`;
  for (let attempt = 1; ; attempt += 1) {
    const meetingId = attempt === 1 ? prefix : `${prefix}-${attempt}`;
    const dir = await projectPath(cwd, path.join(root, meetingId));
    try { await mkdir(dir); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    await writeFile(path.join(dir, 'events.log'), '', 'utf8');
    return { dir, state: {
      meetingId, title: Array.from(question.trim().split(/\r?\n/, 1)[0]).slice(0, 40).join(''),
      createdAt: now.toISOString(), updatedAt: now.toISOString(), ...config, rounds: [], decisions: [],
    } };
  }
}

async function readMeeting(cwd, id) {
  const dir = await projectPath(cwd, path.join('.crew', 'meetings', id));
  const state = JSON.parse(await readFile(await meetingFile(dir, 'meeting.json'), 'utf8'));
  if (state?.meetingId !== id || !Array.isArray(state.rounds) || !Array.isArray(state.participants) || !Array.isArray(state.decisions)) {
    throw new Error(`会审 ${id} 的 meeting.json 无效，请检查会审记录。`);
  }
  return { dir, state };
}

export async function listMeetings(cwd) {
  let entries;
  try { entries = await readdir(await meetingRoot(cwd), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const meetings = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !meetingIdPattern.test(entry.name)) continue;
    try { meetings.push(await readMeeting(cwd, entry.name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return meetings.sort((a, b) => Date.parse(b.state.updatedAt) - Date.parse(a.state.updatedAt)
    || Date.parse(b.state.createdAt) - Date.parse(a.state.createdAt)
    || b.state.meetingId.localeCompare(a.state.meetingId, undefined, { numeric: true }));
}

export async function loadMeeting(cwd, id) {
  if (id === undefined) {
    const [latest] = await listMeetings(cwd);
    if (!latest) throw new Error('还没有会审，请先运行 crew ask "问题"。');
    return latest;
  }
  if (!meetingIdPattern.test(id)) throw new Error('会审编号无效，请查看 crew meetings。');
  try { return await readMeeting(cwd, id); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`找不到会审 ${id}，请查看 crew meetings。`); throw error; }
}

export const meetingLock = (cwd, id) => acquireIpcLock(cwd, `meeting:${id}`,
  '这个会审正在进行。请等待当前命令结束后再试。');

export async function withMeeting(cwd, id, action) {
  const selected = id ?? (await loadMeeting(cwd)).state.meetingId;
  const release = await meetingLock(cwd, selected);
  try { return await action(await loadMeeting(cwd, selected)); }
  finally { await release(); }
}

export async function saveMeeting({ dir, state }, save = atomicJson) {
  state.updatedAt = new Date().toISOString();
  await save(await meetingFile(dir, 'meeting.json'), state);
}

export async function meetingEvent({ dir }, data) {
  await appendFile(await meetingFile(dir, 'events.log'), `${JSON.stringify({ time: new Date().toISOString(), ...data })}\n`, 'utf8');
}
