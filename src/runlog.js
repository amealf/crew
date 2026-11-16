import path from 'node:path';
import { mkdir, readFile, writeFile, rename, appendFile, readdir, stat, realpath } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import net from 'node:net';
import { projectPath } from './paths.js';

const writeQueues = new Map();
export async function atomicJson(file, value) {
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const pending = previous.catch(() => {}).then(async () => {
    const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temp, serialized, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, file);
  });
  writeQueues.set(file, pending);
  try { await pending; }
  finally { if (writeQueues.get(file) === pending) writeQueues.delete(file); }
}

async function runFile(runDir, name) {
  const cwd = path.resolve(runDir, '..', '..', '..');
  return projectPath(cwd, path.join(runDir, name));
}

export async function saveState(runDir, state) {
  await atomicJson(await runFile(runDir, 'state.json'), state);
}

export async function event(runDir, data) {
  await appendFile(await runFile(runDir, 'events.log'), `${JSON.stringify({ time: new Date().toISOString(), ...data })}\n`, 'utf8');
}

function stamp(date) {
  const two = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

export async function createRun(cwd, taskName, taskPath, sheet, initialization) {
  if (typeof taskName !== 'string' || !/^[\p{L}\p{N}_.-]+$/u.test(taskName) || ['.', '..'].includes(taskName)) {
    throw new Error('任务名只能包含文字、数字、横线、下划线和点，并且不能是 . 或 ..。');
  }
  if (initialization !== undefined && (!initialization || typeof initialization.originalBranch !== 'string' || !initialization.originalBranch.trim()
    || typeof initialization.baseCommit !== 'string' || !initialization.baseCommit.trim())) {
    throw new Error('初始化记录必须包含 originalBranch 和 baseCommit。');
  }
  const source = await projectPath(cwd, taskPath);
  const snapshot = await readFile(source, 'utf8');
  const runs = await projectPath(cwd, path.join('.crew', 'runs'));
  await mkdir(runs, { recursive: true });
  const prefix = `${taskName}-${stamp(new Date())}`;
  let runId, runDir;
  for (let attempt = 0; ; attempt += 1) {
    runId = attempt ? `${prefix}-${attempt + 1}` : prefix;
    runDir = await projectPath(cwd, path.join(runs, runId));
    try { await mkdir(runDir); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  for (const name of ['reviews', 'checks', 'shots', 'steps']) await mkdir(path.join(runDir, name));
  await writeFile(path.join(runDir, 'task.yaml'), snapshot, 'utf8');
  await writeFile(path.join(runDir, 'events.log'), '', 'utf8');
  const first = sheet.flow[0];
  const initialNextStep = typeof first === 'string' ? first : 'build';
  const state = { runId, task: taskName, status: 'running', stopReason: null,
    startedAt: new Date().toISOString(), elapsedMs: 0, branch: null, baseCommit: null,
    round: 1, nextStep: initialNextStep, stallCount: 0,
    malformedCount: 0, rounds: [], stepSeq: 0 };
  if (initialization !== undefined) {
    Object.assign(state, { originalBranch: initialization.originalBranch, baseCommit: initialization.baseCommit,
      branch: `crew/${runId}`, nextStep: 'initialize', initialNextStep });
  }
  await saveState(runDir, state);
  return { runDir, state };
}

export async function loadRun(cwd, runId) {
  const runs = await projectPath(cwd, path.join('.crew', 'runs'));
  if (runId !== undefined && (!runId || path.basename(runId) !== runId || runId.includes('\\') || runId.includes('/') || runId === '.' || runId === '..')) {
    throw new Error('运行编号无效，请使用 crew status 显示的完整运行编号。');
  }
  let runDir;
  if (runId) runDir = await projectPath(cwd, path.join(runs, runId));
  else {
    let directories;
    try { directories = await readdir(runs, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('还没有运行记录，请先执行 crew run <任务名>。'); throw error; }
    const candidates = [];
    for (const entry of directories) {
      if (!entry.isDirectory()) continue;
      const directory = await projectPath(cwd, path.join(runs, entry.name));
      try {
        await stat(path.join(directory, 'state.json'));
        const details = await stat(directory);
        candidates.push({ directory, created: details.birthtimeMs || details.mtimeMs, name: entry.name });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    candidates.sort((a, b) => b.created - a.created || b.name.localeCompare(a.name));
    if (!candidates.length) throw new Error('还没有运行记录，请先执行 crew run <任务名>。');
    runDir = candidates[0].directory;
  }
  let state;
  try { state = JSON.parse(await readFile(await projectPath(cwd, path.join(runDir, 'state.json')), 'utf8')); }
  catch (error) { throw new Error(`无法读取运行 ${path.basename(runDir)} 的 state.json：${error.message}。请检查运行编号和记录文件。`); }
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.runId !== path.basename(runDir)) throw new Error('state.json 的运行编号无效，请检查运行记录。');
  return { runDir, state, taskPath: await projectPath(cwd, path.join(runDir, 'task.yaml')) };
}

export async function nextStepDir(runDir, state, step) {
  if (!/^[a-z][a-z-]*$/.test(step)) throw new Error('步骤名无效。');
  let directory;
  for (;;) {
    state.stepSeq = (state.stepSeq ?? 0) + 1;
    directory = await runFile(runDir, path.join('steps', `${String(state.stepSeq).padStart(2, '0')}-${step}`));
    try { await mkdir(directory); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  await saveState(runDir, state);
  return directory;
}

export async function acquireLock(cwd) {
  const root = await realpath(cwd);
  const runs = await projectPath(root, path.join('.crew', 'runs'));
  await mkdir(runs, { recursive: true });
  const identity = process.platform === 'win32' ? root.toLowerCase() : root;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 32);
  // Local IPC supplies an atomic OS-owned lease. A killed process releases it
  // automatically, without deleting lock files or racing stale-file takeovers.
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\crew-scheduler-${hash}` : `\0crew-scheduler-${hash}`;
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const fail = error => reject(new Error(error.code === 'EADDRINUSE' ? '这个项目已有 crew 运行中。请先等待它结束，或中断原进程后再继续。' : `无法取得运行锁：${error.message}`));
    server.once('error', fail);
    server.listen(address, () => { server.removeListener('error', fail); resolve(); });
  });
  server.unref();
  const lockPath = await projectPath(root, path.join(runs, 'lock.json'));
  const owner = randomUUID();
  try { await atomicJson(lockPath, { pid: process.pid, owner, acquiredAt: new Date().toISOString() }); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try { await atomicJson(lockPath, null); }
    finally { await new Promise(resolve => server.close(resolve)); }
  };
}
