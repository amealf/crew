import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { stringify } from 'yaml';
import { runTask, resumeRun } from '../src/engine.js';
import { execute } from '../src/adapters/process.js';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, '.local', 'tests'), { recursive: true });
const area = await mkdtemp(path.join(root, '.local', 'tests', 'engine-'));
const quiet = { notifyFn: async () => {}, retryDelayMs: 0, log: () => {} };
const builder = (round = 1, extra = {}) => ({ text: `第 ${round} 轮实现完成`, files: { 'value.txt': `round ${round}\n` }, ...extra });
const review = verdict => ({ text: `### 验收清单\n通过：测试通过\n### 必须修改\n${verdict === 'REVISE' ? '1. value.txt：需要下一轮修复。' : '无'}\n### 建议\n无\n### 结论\nVERDICT: ${verdict}` });

async function git(cwd, args) {
  const result = await execute('git', args, { cwd, timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function withProject(entries, changes, fn) {
  const cwd = await mkdtemp(path.join(area, 'project-'));
  await mkdir(path.join(cwd, '.local'), { recursive: true });
  await mkdir(path.join(cwd, '.crew', 'tasks'), { recursive: true });
  await writeFile(path.join(cwd, '.gitignore'), '.local/\n.crew/runs/\n', 'utf8');
  await writeFile(path.join(cwd, 'DECISIONS.md'), '', 'utf8');
  await writeFile(path.join(cwd, 'tracked.txt'), 'initial\n', 'utf8');
  const sheet = {
    goal: '在 value.txt 中实现一轮改动，并接受独立审阅。',
    roles: { builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: [{ loop: ['build', 'check', 'review'] }],
    checks: { commands: ['node -e "process.exit(0)"'] },
    ...changes,
  };
  const taskPath = path.join(cwd, '.crew', 'tasks', 'task.yaml');
  await writeFile(taskPath, stringify(sheet), 'utf8');
  await git(cwd, ['init', '-b', 'main']);
  await git(cwd, ['config', 'user.name', 'Crew Test']);
  await git(cwd, ['config', 'user.email', 'crew-test@example.invalid']);
  await git(cwd, ['config', 'core.autocrlf', 'false']);
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', 'initial']);
  const initialCommit = await git(cwd, ['rev-parse', 'HEAD']);
  const scriptPath = path.join(cwd, '.local', 'mock.json');
  await writeFile(scriptPath, JSON.stringify(entries), 'utf8');
  const previous = process.env.CREW_MOCK_SCRIPT;
  process.env.CREW_MOCK_SCRIPT = scriptPath;
  const invoke = options => runTask({ ...quiet, cwd, taskName: 'task', taskPath, ...options });
  const resume = (result, options) => resumeRun({ ...quiet, cwd, runId: result.state.runId, ...options });
  const consumed = async () => {
    try { return JSON.parse(await readFile(`${scriptPath}.cursor.json`, 'utf8')).index; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  };
  try { await fn({ cwd, sheet, taskPath, initialCommit, invoke, resume, consumed }); }
  finally {
    if (previous === undefined) delete process.env.CREW_MOCK_SCRIPT;
    else process.env.CREW_MOCK_SCRIPT = previous;
  }
}

async function stepRecords(runDir) {
  const result = [];
  for (const name of (await readdir(path.join(runDir, 'steps'))).sort()) {
    const directory = path.join(runDir, 'steps', name);
    const meta = JSON.parse(await readFile(path.join(directory, 'meta.json'), 'utf8'));
    result.push({ directory, meta, prompt: await readFile(path.join(directory, 'prompt.md'), 'utf8') });
  }
  return result;
}

async function findFiles(directory, filename) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findFiles(file, filename));
    else if (entry.name === filename) found.push(file);
  }
  return found;
}

test('引擎一轮通过，提交、报告和运行记录完整，原分支保持不变', async () => {
  await withProject([builder(), review('APPROVED')], {}, async ({ cwd, invoke, initialCommit, consumed }) => {
    const result = await invoke();
    assert.equal(result.exitCode, 0);
    assert.equal(result.state.status, 'approved');
    assert.equal(result.state.stopReason, null);
    assert.equal(result.state.rounds.length, 1);
    assert.equal(result.state.rounds[0].verdict, 'APPROVED');
    assert.equal(result.state.rounds[0].checksPassed, true);
    assert.equal(await consumed(), 2);
    assert.equal(await git(cwd, ['rev-parse', 'main']), initialCommit);
    assert.equal(await git(cwd, ['branch', '--show-current']), result.state.branch);
    assert.equal(await git(cwd, ['rev-list', '--count', `${initialCommit}..HEAD`]), '1');
    assert.equal(await git(cwd, ['log', '-1', '--format=%s']), 'crew: round 1 build');
    for (const name of ['state.json', 'task.yaml', 'events.log', 'REPORT.md', 'reviews/review-1.md', 'checks/check-1.json', 'checks/diff-1.patch']) await access(path.join(result.runDir, name));
    assert.match(await readFile(path.join(result.runDir, 'checks', 'diff-1.patch'), 'utf8'), /value.txt/);
    assert.match(await readFile(path.join(result.runDir, 'REPORT.md'), 'utf8'), /approved/);
    const records = await stepRecords(result.runDir);
    for (const step of records) for (const name of ['raw.log', 'output.md', 'meta.json']) await access(path.join(step.directory, name));
  });
});

test('两次 REVISE 后通过，后续提示词带上一轮路径，每轮只有一个提交', async () => {
  await withProject([builder(1), review('REVISE'), builder(2), review('REVISE'), builder(3), review('APPROVED')], {}, async ({ cwd, invoke, initialCommit }) => {
    const result = await invoke();
    assert.equal(result.state.status, 'approved');
    assert.deepEqual(result.state.rounds.map(round => round.verdict), ['REVISE', 'REVISE', 'APPROVED']);
    const builds = (await stepRecords(result.runDir)).filter(step => step.meta.mode === 'write');
    assert.equal(builds.length, 3);
    for (const index of [1, 2]) {
      assert.ok(builds[index].prompt.includes(`review-${index}.md`));
      assert.ok(builds[index].prompt.includes(`check-${index}.json`));
    }
    assert.equal(await git(cwd, ['rev-list', '--count', `${initialCommit}..HEAD`]), '3');
    assert.equal(await git(cwd, ['rev-parse', 'main']), initialCommit);
    const diff = await readFile(path.join(result.runDir, 'checks', 'diff-3.patch'), 'utf8');
    assert.match(diff, /round 3/);
    assert.doesNotMatch(diff, /round 2/);
  });
});

test('BLOCKED、轮数上限、停滞和连续畸形结论按指定原因停止', async () => {
  const cases = [
    { entries: [builder(), review('BLOCKED')], reason: 'blocked', count: 2 },
    { entries: [builder(), review('REVISE')], changes: { stop_when: { max_rounds: 1 } }, reason: 'max_rounds', count: 2 },
    { entries: [{ text: '无改动' }, review('REVISE'), { text: '仍无改动' }], reason: 'stalled', count: 3 },
    { entries: [builder(), { text: '缺少正式结论' }, builder(2), { text: 'VERDICT: APPROVED\n还有一句话' }], reason: 'review_malformed', count: 4 },
  ];
  for (const item of cases) await withProject(item.entries, item.changes ?? {}, async ({ invoke, consumed }) => {
    const result = await invoke();
    assert.equal(result.exitCode, 2, item.reason);
    assert.equal(result.state.status, 'stopped', item.reason);
    assert.equal(result.state.stopReason, item.reason);
    assert.equal(await consumed(), item.count);
    if (item.reason === 'review_malformed') {
      const builds = (await stepRecords(result.runDir)).filter(step => step.meta.mode === 'write');
      assert.match(builds[1].prompt, /上一轮审阅没有给出合规结论/);
    }
  });
});

test('检查失败时把 APPROVED 改为 REVISE', async () => {
  await withProject([builder(), review('APPROVED')], {
    checks: { commands: ['node -e "process.exit(7)"'] }, stop_when: { max_rounds: 1 },
  }, async ({ invoke }) => {
    const result = await invoke();
    assert.equal(result.state.status, 'stopped');
    assert.equal(result.state.stopReason, 'max_rounds');
    assert.equal(result.state.rounds[0].checksPassed, false);
    assert.equal(result.state.rounds[0].verdict, 'REVISE');
    const check = JSON.parse(await readFile(path.join(result.runDir, 'checks', 'check-1.json'), 'utf8'));
    assert.equal(check.commands[0].exitCode, 7);
  });
});

test('失败构建重试前恢复已有文件并保存半截新文件，第二次成功可继续', async () => {
  await withProject([
    { text: '半截改动', exitCode: 1, files: { 'tracked.txt': 'partial\n', 'partial.txt': 'unfinished\n' } },
    builder(), review('APPROVED'),
  ], {}, async ({ cwd, invoke, consumed, initialCommit }) => {
    const result = await invoke();
    assert.equal(result.state.status, 'approved');
    assert.equal(await consumed(), 3);
    assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'initial\n');
    await assert.rejects(access(path.join(cwd, 'partial.txt')), { code: 'ENOENT' });
    const saved = await findFiles(path.join(result.runDir, 'recovery'), 'partial.txt');
    assert.equal(saved.length, 1);
    assert.equal(await readFile(saved[0], 'utf8'), 'unfinished\n');
    assert.equal(await git(cwd, ['rev-list', '--count', `${initialCommit}..HEAD`]), '1');
  });
});

test('连续失败、连续超时停止；额度不足不重试', async () => {
  for (const [entries, reason, count] of [
    [[{ text: '失败', exitCode: 1 }, { text: '再次失败', exitCode: 1 }], 'step_failed', 2],
    [[{ text: '超时', timedOut: true }, { text: '再次超时', timedOut: true }], 'step_timeout', 2],
    [[{ text: '额度不足', quotaHit: true }, builder(), review('APPROVED')], 'quota', 1],
  ]) await withProject(entries, {}, async ({ invoke, consumed }) => {
    const result = await invoke();
    assert.equal(result.exitCode, 2);
    assert.equal(result.state.status, 'stopped');
    assert.equal(result.state.stopReason, reason);
    assert.equal(await consumed(), count);
  });
});

test('approve 暂停后从 build 开始，设计步骤不重复', async () => {
  await withProject([{ text: '设计正文' }, builder(), review('APPROVED')], {
    roles: { designer: { tool: 'mock', model: 'designer' }, builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: ['design', 'approve', { loop: ['build', 'check', 'review'] }],
  }, async ({ invoke, resume, consumed }) => {
    const pending = await invoke();
    assert.equal(pending.exitCode, 0);
    assert.equal(pending.state.status, 'waiting_approval');
    assert.equal(await consumed(), 1);
    assert.equal(await readFile(path.join(pending.runDir, 'design.md'), 'utf8'), '设计正文');
    await assert.rejects(resume(pending), /approve|批准|审批/);
    const completed = await resume(pending, { approve: true });
    assert.equal(completed.state.status, 'approved');
    assert.equal(await consumed(), 3);
    const records = await stepRecords(completed.runDir);
    assert.equal(records.filter(step => step.meta.model === 'designer').length, 1);
  });
});

test('在 build/check/review 中断后续跑，已完成的步骤不重做', async () => {
  for (const target of ['build', 'check', 'review']) await withProject([{ text: '设计正文' }, builder(), review('APPROVED')], {
    roles: { designer: { tool: 'mock', model: 'designer' }, builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: ['design', { loop: ['build', 'check', 'review'] }],
  }, async ({ invoke, resume, consumed }) => {
    const controller = new AbortController();
    const starts = [];
    const interrupted = await invoke({ signal: controller.signal, onStep: event => {
      if (event.phase !== 'start') return;
      starts.push(event.step);
      if (event.step === target) controller.abort();
    } });
    assert.equal(interrupted.state.status, 'stopped', target);
    assert.equal(interrupted.state.stopReason, 'interrupted', target);
    const completed = await resume(interrupted, { onStep: event => { if (event.phase === 'start') starts.push(event.step); } });
    assert.equal(completed.state.status, 'approved', target);
    assert.equal(await consumed(), 3, target);
    assert.equal(starts.filter(step => step === 'design').length, 1, target);
    assert.equal(starts.filter(step => step === target).length, 2, target);
    if (target !== 'build') assert.equal(starts.filter(step => step === 'build').length, 1, target);
    if (target === 'review') assert.equal(starts.filter(step => step === 'check').length, 1, target);
  });
});

test('max_hours 停止且不消耗脚本，extend-hours 后可续跑', async () => {
  await withProject([builder(), review('APPROVED')], { stop_when: { max_hours: 1 / 3_600_000 } }, async ({ invoke, resume, consumed }) => {
    const stopped = await invoke();
    assert.equal(stopped.state.status, 'stopped');
    assert.equal(stopped.state.stopReason, 'max_hours');
    assert.equal(await consumed(), 0);
    const completed = await resume(stopped, { extendHours: 1 });
    assert.equal(completed.state.status, 'approved');
    assert.equal(await consumed(), 2);
    assert.ok(completed.state.elapsedMs > 0);
  });
});

test('quota 后可续跑，暂停时间不计入时限', async () => {
  await withProject([{ text: '额度不足', quotaHit: true, files: { 'partial.txt': 'unfinished' } }, builder(), review('APPROVED')], {}, async ({ cwd, invoke, resume, consumed }) => {
    const stopped = await invoke();
    assert.equal(stopped.state.stopReason, 'quota');
    assert.equal(await consumed(), 1);
    const stateFile = path.join(stopped.runDir, 'state.json');
    const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
    persisted.startedAt = '2000-01-01T00:00:00.000Z';
    await writeFile(stateFile, JSON.stringify(persisted), 'utf8');
    const completed = await resume(stopped);
    assert.equal(completed.state.status, 'approved');
    assert.equal(await consumed(), 3);
    await assert.rejects(access(path.join(cwd, 'partial.txt')), { code: 'ENOENT' });
  });
});

test('脏工作区拒绝开始；分支不符时拒绝续跑并保留原状态', async () => {
  await withProject([builder(), review('APPROVED')], {}, async ({ cwd, invoke, consumed }) => {
    await writeFile(path.join(cwd, 'dirty.txt'), 'uncommitted', 'utf8');
    await assert.rejects(invoke(), /工作区|干净|未提交/);
    assert.equal(await consumed(), 0);
  });
  await withProject([{ text: '额度不足', quotaHit: true }], {}, async ({ cwd, invoke, resume }) => {
    const stopped = await invoke();
    await git(cwd, ['switch', 'main']);
    const before = await readFile(path.join(stopped.runDir, 'state.json'), 'utf8');
    await assert.rejects(resume(stopped), /分支/);
    assert.equal(await readFile(path.join(stopped.runDir, 'state.json'), 'utf8'), before);
  });
});
