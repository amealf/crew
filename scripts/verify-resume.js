// An explicit, offline acceptance check. This script never calls a model.
// It force-kills a real OS process tree; it does not operate a terminal window.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, readFile, readdir, access } from 'node:fs/promises';
import spawn from 'cross-spawn';
import { stringify } from 'yaml';
import { execute, killTree } from '../src/adapters/process.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = path.join(root, 'bin', 'crew.js');
const local = path.join(root, '.local');
await mkdir(local, { recursive: true });
const cwd = await mkdtemp(path.join(local, 'resume-verification-'));
const task = 'resume-proof';
const startedAt = new Date().toISOString();
const verification = {
  kind: 'actual-os-process-tree-termination',
  note: '通过操作系统强制终止实际 CLI 进程树后续跑；没有手工关闭终端窗口，没有调用真实模型。',
  cwd, startedAt, passed: false,
};
let child, closed, launchError, stdout = '', stderr = '';
let watchdog;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function git(args) {
  const result = await execute('git', args, { cwd, timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}
async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    if (launchError) throw launchError;
    await delay(100);
  }
  throw new Error(`等待${description}超时。`);
}
async function findNamed(directory, filename) {
  const matches = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) matches.push(...await findNamed(file, filename));
    else if (item.name === filename) matches.push(file);
  }
  return matches;
}

try {
  await mkdir(path.join(cwd, '.local'), { recursive: true });
  await mkdir(path.join(cwd, '.crew', 'tasks'), { recursive: true });
  await writeFile(path.join(cwd, '.gitignore'), '.crew/runs/\n.local/\n', 'utf8');
  await writeFile(path.join(cwd, 'DECISIONS.md'), '', 'utf8');
  const sheet = {
    goal: '验证实际进程强制终止后可以恢复构建并完成审阅。',
    roles: { builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: [{ loop: ['build', 'check', 'review'] }],
    checks: { commands: ['node -e "process.exit(0)"'] },
  };
  await writeFile(path.join(cwd, '.crew', 'tasks', `${task}.yaml`), stringify(sheet), 'utf8');
  const script = path.join(cwd, '.local', 'mock.json');
  await writeFile(script, JSON.stringify([
    { text: '构建尚未完成', files: { 'partial.txt': 'partial build content\n' }, delayMs: 60_000 },
    { text: '恢复后构建完成', files: { 'value.txt': 'recovered build\n' } },
    { text: '### 必须修改\n无\nVERDICT: APPROVED' },
  ], null, 2), 'utf8');
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Crew Resume Verification']);
  await git(['config', 'user.email', 'crew-resume@example.invalid']);
  await git(['config', 'core.autocrlf', 'false']);
  await git(['add', '-A']);
  await git(['commit', '-m', 'initial']);
  const initialCommit = await git(['rev-parse', 'HEAD']);
  const env = { ...process.env, CREW_MOCK_SCRIPT: script };
  child = spawn(process.execPath, [entry, 'run', task], {
    cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  verification.initialPid = child.pid;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', error => { launchError = error; });
  child.once('close', (exitCode, signal) => { closed = { exitCode, signal }; });
  watchdog = setTimeout(() => {
    if (child && !closed) killTree(child).catch(error => { launchError = error; });
  }, 35_000);
  const runs = path.join(cwd, '.crew', 'runs');
  const runDir = await waitFor(async () => {
    if (!await exists(runs)) return false;
    const directories = await readdir(runs, { withFileTypes: true });
    const found = directories.find(item => item.isDirectory() && item.name.startsWith(`${task}-`));
    return found ? path.join(runs, found.name) : false;
  }, 20_000, '运行目录');
  verification.runDir = runDir;
  const stateFile = path.join(runDir, 'state.json');
  let firstBuildTimestamp;
  const interruptedState = await waitFor(async () => {
    if (!await exists(stateFile)) return false;
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.status !== 'running' || state.nextStep !== 'build' || !await exists(path.join(cwd, 'partial.txt'))) return false;
    firstBuildTimestamp ??= state.updatedAt;
    // Initial checkpoints may have elapsedMs > 0. Wait for a distinct persisted
    // heartbeat after two seconds, while the mock is still inside its long build.
    return state.elapsedMs >= 2000 && state.updatedAt !== firstBuildTimestamp ? state : false;
  }, 15_000, '构建中间状态与心跳');
  assert.equal(closed, undefined, 'CLI 在强制终止之前已退出。');
  verification.stateBeforeKill = interruptedState;
  verification.treeKill = await killTree(child);
  await waitFor(() => closed, 5000, '原 CLI 进程退出');
  clearTimeout(watchdog);
  const abandonedState = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(abandonedState.status, 'running', '强杀后应留下 running，不能走优雅结束路径。');
  assert.equal(abandonedState.nextStep, 'build');
  assert.ok(abandonedState.elapsedMs >= 2000);
  assert.equal(await exists(path.join(runDir, 'REPORT.md')), false);
  assert.equal(verification.treeKill?.exitCode, 0);
  const killedPids = verification.treeKill.pids;
  assert.equal(killedPids.filter(alive).length, 0, '原进程树仍有存活进程。');
  verification.originalExit = closed;
  verification.stateAfterKill = abandonedState;
  console.log(`已强制终止进程 ${child.pid}，磁盘保留 running/build；开始续跑。`);
  const resumed = await execute(process.execPath, [entry, 'resume'], { cwd, env, timeoutMs: 40_000 });
  verification.resume = {
    exitCode: resumed.exitCode, timedOut: resumed.timedOut, pid: resumed.pid,
    stdout: resumed.stdout, stderr: resumed.stderr,
  };
  assert.equal(resumed.exitCode, 0, resumed.stderr || resumed.stdout);
  assert.equal(resumed.timedOut, false);
  const finalState = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(finalState.status, 'approved');
  assert.equal(finalState.rounds.length, 1);
  assert.equal(finalState.rounds[0].verdict, 'APPROVED');
  assert.equal(await exists(path.join(cwd, 'partial.txt')), false);
  assert.equal(await readFile(path.join(cwd, 'value.txt'), 'utf8'), 'recovered build\n');
  const recoveryFiles = await findNamed(path.join(runDir, 'recovery'), 'partial.txt');
  assert.equal(recoveryFiles.length, 1);
  assert.equal(await readFile(recoveryFiles[0], 'utf8'), 'partial build content\n');
  const cursor = JSON.parse(await readFile(`${script}.cursor.json`, 'utf8'));
  assert.equal(cursor.index, 3, '三条脚本应各消费一次。');
  assert.equal(await git(['rev-parse', 'main']), initialCommit);
  assert.equal(await git(['rev-list', '--count', `${initialCommit}..HEAD`]), '1');
  const events = (await readFile(path.join(runDir, 'events.log'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  const buildStarts = events.filter(event => event.step === 'build' && event.result === 'start').length;
  const reviewStarts = events.filter(event => event.step === 'review' && event.result === 'start').length;
  const completedChecks = events.filter(event => event.step === 'check' && event.result === 'passed').length;
  assert.equal(buildStarts, 2);
  assert.equal(reviewStarts, 1);
  assert.equal(completedChecks, 1);
  verification.finalState = finalState;
  verification.mockEntriesConsumed = cursor.index;
  verification.recoveredPartial = recoveryFiles[0];
  verification.stepCounts = { buildStarts, reviewStarts, completedChecks };
  verification.remainingPids = [...new Set([...killedPids, resumed.pid])].filter(alive);
  assert.deepEqual(verification.remainingPids, []);
  verification.passed = true;
  console.log('续跑已 approved，半截文件已保留到 recovery，原分支未变，进程均已退出。');
} catch (error) {
  verification.error = error.stack ?? error.message;
  process.exitCode = 1;
  console.error(`断点续跑验收失败：${error.message}`);
} finally {
  clearTimeout(watchdog);
  if (child && !closed) {
    verification.cleanup = await killTree(child);
    try { await waitFor(() => closed, 5000, '清理原 CLI 进程'); }
    catch (error) { verification.cleanupError = error.message; process.exitCode = 1; }
  }
  verification.initialStdout = stdout;
  verification.initialStderr = stderr;
  verification.completedAt = new Date().toISOString();
  await writeFile(path.join(cwd, 'verification.json'), JSON.stringify(verification, null, 2), 'utf8');
  console.log(`记录：${path.join(cwd, 'verification.json')}`);
}
