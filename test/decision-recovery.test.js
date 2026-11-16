import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { runTask, resumeRun, writeReport } from '../src/engine.js';
import { saveState } from '../src/runlog.js';
import { execute } from '../src/adapters/process.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const parent = path.join(root, '.local', 'tests');
await mkdir(parent, { recursive: true });
const area = await mkdtemp(path.join(parent, 'decision-recovery-'));
const quiet = { notifyFn: async () => ({ ok: true }), retryDelayMs: 0, log: () => {} };

async function git(cwd, args) {
  const result = await execute('git', args, { cwd, timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

test('重放已计数的畸形结论不增加轮数计数，第二轮真实畸形才停止', async () => {
  const cwd = await mkdtemp(path.join(area, 'project-'));
  await mkdir(path.join(cwd, '.crew', 'tasks'), { recursive: true });
  await mkdir(path.join(cwd, '.local'), { recursive: true });
  await writeFile(path.join(cwd, '.gitignore'), '.crew/runs/\n.local/\n', 'utf8');
  const sheet = {
    goal: '验证崩溃后重新判定同一轮审阅时，不会把畸形结论重复计数。',
    human_review: true,
    roles: { builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: [{ loop: ['build', 'check', 'review'] }], checks: { commands: [] },
  };
  const taskPath = path.join(cwd, '.crew', 'tasks', 'decision.yaml');
  await writeFile(taskPath, stringify(sheet), 'utf8');
  const script = path.join(cwd, '.local', 'mock.json');
  const malformedOne = '第一轮审阅已完成，但没有合规的最后一行结论。';
  const malformedTwo = '第二轮审阅也没有合规结论。';
  await writeFile(script, JSON.stringify([
    { text: '构建第一轮完成', files: { 'value.txt': 'round one\n' } },
    { text: malformedOne },
    { text: '构建第二轮完成', files: { 'value.txt': 'round two\n' } },
    { text: malformedTwo },
  ]), 'utf8');
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Crew Decision Recovery Test'],
    ['config', 'user.email', 'crew-decision@example.invalid'], ['config', 'core.autocrlf', 'false'],
    ['add', '-A'], ['commit', '-m', 'initial']]) await git(cwd, args);
  const originalMain = await git(cwd, ['rev-parse', 'main']);
  const previousScript = process.env.CREW_MOCK_SCRIPT;
  process.env.CREW_MOCK_SCRIPT = script;
  const consumed = async () => JSON.parse(await readFile(`${script}.cursor.json`, 'utf8')).index;
  try {
    const first = await runTask({ ...quiet, cwd, taskName: 'decision', taskPath });
    assert.equal(first.state.status, 'waiting_approval');
    assert.equal(first.state.approvalStage, 'review');
    assert.equal(first.state.nextStep, 'review_gate');
    assert.equal(first.state.round, 1);
    assert.equal(first.state.malformedCount, 1);
    assert.equal(first.state.rounds[0].malformed, true);
    assert.equal(await consumed(), 2);
    const firstCommit = await git(cwd, ['rev-parse', 'HEAD']);

    // A heartbeat can persist the count after the verdict is parsed but before
    // nextStep advances. Recreate that durable crash snapshot without a model.
    const crashState = structuredClone(first.state);
    crashState.status = 'running';
    crashState.stopReason = null;
    crashState.nextStep = 'decide';
    crashState.round = 1;
    crashState.malformedCount = 1;
    delete crashState.approvalStage;
    await saveState(first.runDir, crashState);
    const recovered = await resumeRun({ ...quiet, cwd, runId: first.state.runId });
    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.state.status, 'waiting_approval');
    assert.equal(recovered.state.approvalStage, 'review');
    assert.equal(recovered.state.nextStep, 'review_gate');
    assert.equal(recovered.state.round, 1);
    assert.equal(recovered.state.malformedCount, 1);
    assert.equal(recovered.state.stopReason, null);
    assert.equal(recovered.state.rounds.length, 1);
    assert.equal(await consumed(), 2, '重新判定第一轮不会消耗新模型回答');
    assert.equal(await git(cwd, ['rev-parse', 'HEAD']), firstCommit);
    assert.equal(await readFile(recovered.state.rounds[0].reviewPath, 'utf8'), malformedOne);

    const second = await resumeRun({ ...quiet, cwd, runId: first.state.runId, approve: true });
    assert.equal(second.exitCode, 2);
    assert.equal(second.state.status, 'stopped');
    assert.equal(second.state.stopReason, 'review_malformed');
    assert.equal(second.state.round, 2);
    assert.equal(second.state.malformedCount, 2);
    assert.deepEqual(second.state.rounds.map(round => round.malformed), [true, true]);
    assert.equal(await consumed(), 4, '仅两个构建与两个审阅回答被消费');
    assert.equal(await readFile(second.state.rounds[1].reviewPath, 'utf8'), malformedTwo);
    assert.equal(await git(cwd, ['rev-parse', 'main']), originalMain);
    const persisted = JSON.parse(await readFile(path.join(second.runDir, 'state.json'), 'utf8'));
    assert.equal(persisted.stopReason, 'review_malformed');
    assert.equal(persisted.malformedCount, 2);
  } finally {
    if (previousScript === undefined) delete process.env.CREW_MOCK_SCRIPT;
    else process.env.CREW_MOCK_SCRIPT = previousScript;
  }
});

test('detached HEAD 起点的报告提示选择目标分支，不生成无效的HEAD切换命令', async () => {
  const runDir = await mkdtemp(path.join(area, 'report-'));
  const state = {
    runId: 'detached-report', task: 'detached', status: 'approved', stopReason: null,
    elapsedMs: 1000, nextStep: 'done', rounds: [], originalBranch: 'HEAD',
    baseCommit: 'a'.repeat(40), branch: 'crew/detached-report',
  };
  await writeReport({ runDir, state, sheet: { goal: '验证游离提交起点的合并说明。' } });
  const report = await readFile(path.join(runDir, 'REPORT.md'), 'utf8');
  assert.match(report, /detached HEAD/);
  assert.match(report, /先选择目标分支再手动合并/);
  assert.doesNotMatch(report, /git switch ['"]?HEAD/);
  assert.doesNotMatch(report, /git merge --no-ff/);
});
