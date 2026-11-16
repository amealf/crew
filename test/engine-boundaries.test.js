import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { runTask, resumeRun } from '../src/engine.js';
import { execute } from '../src/adapters/process.js';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, '.local', 'tests'), { recursive: true });
const area = await mkdtemp(path.join(root, '.local', 'tests', 'boundaries-'));
const quiet = { notifyFn: async () => ({ ok: true }), retryDelayMs: 0, log: () => {} };
const build = { text: '实现完成', files: { 'value.txt': 'built\n' } };
const approved = { text: '### 必须修改\n无\n### 结论\nVERDICT: APPROVED' };

async function git(cwd, args) {
  const result = await execute('git', args, { cwd, timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(entries, changes, action) {
  const cwd = await mkdtemp(path.join(area, 'project-'));
  await mkdir(path.join(cwd, '.local'), { recursive: true });
  await mkdir(path.join(cwd, '.crew', 'tasks'), { recursive: true });
  await writeFile(path.join(cwd, '.gitignore'), '.local/\n.crew/runs/\n', 'utf8');
  await writeFile(path.join(cwd, 'DECISIONS.md'), '', 'utf8');
  await writeFile(path.join(cwd, 'wait.cjs'), `const fs = require('node:fs');
const label = process.argv[2] || 'wait';
fs.writeFileSync('.local/check-' + label + '-started.txt', String(Date.now()));
setTimeout(() => fs.writeFileSync('.local/check-' + label + '-completed.txt', String(Date.now())), 2500);
`, 'utf8');
  await writeFile(path.join(cwd, 'after-check.cjs'), "require('node:fs').writeFileSync('.local/check-after-started.txt', 'ran');\n", 'utf8');
  const sheet = {
    goal: '验证调度器的分支、初始化、续跑和预算边界。',
    roles: { builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: [{ loop: ['build', 'review'] }],
    ...changes,
  };
  const taskPath = path.join(cwd, '.crew', 'tasks', 'task.yaml');
  await writeFile(taskPath, stringify(sheet), 'utf8');
  await git(cwd, ['init', '-b', 'main']);
  await git(cwd, ['config', 'user.name', 'Crew Boundary Test']);
  await git(cwd, ['config', 'user.email', 'crew-test@example.invalid']);
  await git(cwd, ['config', 'core.autocrlf', 'false']);
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', 'initial']);
  const initialCommit = await git(cwd, ['rev-parse', 'HEAD']);
  const scriptPath = path.join(cwd, '.local', 'mock.json');
  await writeFile(scriptPath, JSON.stringify(entries), 'utf8');
  const previousScript = process.env.CREW_MOCK_SCRIPT;
  process.env.CREW_MOCK_SCRIPT = scriptPath;
  const invoke = (options = {}) => runTask({ ...quiet, cwd, taskName: 'task', taskPath, ...options });
  const resume = (result, options = {}) => resumeRun({ ...quiet, cwd, runId: result.state.runId, ...options });
  const consumed = async () => {
    try { return JSON.parse(await readFile(`${scriptPath}.cursor.json`, 'utf8')).index; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  };
  try { await action({ cwd, initialCommit, invoke, resume, consumed }); }
  finally {
    if (previousScript === undefined) delete process.env.CREW_MOCK_SCRIPT;
    else process.env.CREW_MOCK_SCRIPT = previousScript;
  }
}

test('构建后若切回main，提交前拒绝继续且原分支不增加提交', async () => {
  await fixture([build, approved], {}, async ({ cwd, initialCommit, invoke, consumed }) => {
    const result = await invoke({ onStep: async event => {
      if (event.step === 'build' && event.phase === 'end') await git(cwd, ['switch', 'main']);
    } });
    assert.equal(result.state.status, 'error');
    assert.match(result.state.error, /分支/);
    assert.equal(await git(cwd, ['rev-parse', 'main']), initialCommit);
    assert.equal(await git(cwd, ['rev-list', '--count', `${initialCommit}..main`]), '0');
    assert.equal(await consumed(), 1);
  });
});

test('整个检查步骤共享剩余总预算，多条命令不会成倍延长max_hours', async () => {
  await fixture([build, approved], {
    flow: [{ loop: ['build', 'check', 'review'] }],
    checks: { commands: ['node wait.cjs first', 'node wait.cjs second', 'node after-check.cjs'] },
    stop_when: { max_hours: 0.001 },
  }, async ({ cwd, invoke, consumed }) => {
    const result = await invoke();
    assert.equal(result.state.status, 'stopped');
    assert.equal(result.state.stopReason, 'max_hours');
    assert.ok(result.state.elapsedMs >= 3600, `elapsedMs=${result.state.elapsedMs}`);
    // elapsedMs also includes taskkill/process drain time, which depends on
    // concurrent Windows load. Observe the shared deadline's cancellation
    // instead of imposing an unrelated one-second OS-cleanup allowance.
    const check = JSON.parse(await readFile(path.join(result.runDir, 'checks', 'check-1.json'), 'utf8'));
    assert.equal(check.interrupted, true, '整个check必须收到共享预算的取消信号');
    assert.ok(check.commands.length >= 1 && check.commands.length <= 2, '取消后不能继续启动后续命令');
    assert.equal(check.commands.at(-1).interrupted, true, '正在执行的命令必须被共享预算取消');
    assert.ok(check.commands.every(command => command.cmd.startsWith('node wait.cjs ')));
    await assert.rejects(readFile(path.join(cwd, '.local', 'check-second-completed.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(cwd, '.local', 'check-after-started.txt')), { code: 'ENOENT' });
    assert.equal(await consumed(), 1, '预算用尽后不能调用审阅者');
  });
});

test('初始化开始与结束处中断，stopped和异常running记录都可恢复且模型步骤不重复', async () => {
  for (const phase of ['start', 'end']) await fixture([{ text: '设计正文' }, build, approved], {
    roles: { designer: { tool: 'mock', model: 'designer' }, builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: ['design', { loop: ['build', 'review'] }],
  }, async ({ cwd, invoke, resume, consumed }) => {
    const controller = new AbortController();
    const calls = [];
    const interrupted = await invoke({ signal: controller.signal, onStep: async event => {
      if (event.phase === 'start') calls.push(event.step);
      if (event.step !== 'initialize' || event.phase !== phase) return;
      const branch = await git(cwd, ['branch', '--show-current']);
      if (phase === 'start') assert.equal(branch, 'main');
      else assert.equal(branch, event.state.branch);
      controller.abort();
    } });
    assert.equal(interrupted.state.status, 'stopped', phase);
    assert.equal(interrupted.state.stopReason, 'interrupted', phase);
    assert.equal(interrupted.state.nextStep, 'initialize', phase);
    assert.equal(await consumed(), 0, phase);
    if (phase === 'end') {
      // Closing a terminal can leave its last durable record at running.
      const file = path.join(interrupted.runDir, 'state.json');
      const state = JSON.parse(await readFile(file, 'utf8'));
      state.status = 'running'; state.stopReason = null;
      await writeFile(file, JSON.stringify(state), 'utf8');
    }
    const completed = await resume(interrupted, { onStep: event => { if (event.phase === 'start') calls.push(event.step); } });
    assert.equal(completed.state.status, 'approved', phase);
    assert.equal(await consumed(), 3, phase);
    assert.equal(calls.filter(step => step === 'design').length, 1, phase);
    assert.equal(calls.filter(step => step === 'build').length, 1, phase);
    assert.equal(calls.filter(step => step === 'review').length, 1, phase);
  });
});

test('两个续跑请求竞争时只有一个执行，后到请求不能用旧状态覆盖approved', async () => {
  await fixture([{ text: '额度不足', quotaHit: true }, build, approved,
    { text: '第二个续跑不应消费这条\nVERDICT: BLOCKED' }], {}, async ({ invoke, resume, consumed }) => {
    const stopped = await invoke();
    assert.equal(stopped.state.stopReason, 'quota');
    let competitor;
    const first = await resume(stopped, { onStep: event => {
      if (event.step === 'review' && event.phase === 'end' && !competitor) {
        // The durable state is still running/review when the competing request
        // begins. The active runner is about to finish while branch/probe I/O
        // in an incorrectly ordered resume can still be in progress.
        competitor = resume(stopped).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
      }
    } });
    assert.equal(first.state.status, 'approved');
    assert.ok(competitor, '已发出第二个并发resume');
    const second = await competitor;
    assert.equal(second.status, 'rejected');
    assert.match(second.reason.message, /运行中|approved|状态/);
    const persisted = JSON.parse(await readFile(path.join(first.runDir, 'state.json'), 'utf8'));
    assert.equal(persisted.status, 'approved');
    assert.equal(persisted.nextStep, 'done');
    assert.equal(await consumed(), 3, '第二个续跑不能重复调用模型');
  });
});
