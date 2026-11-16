import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { stringify } from 'yaml';
import { runTask, resumeRun } from '../src/engine.js';
import { execute } from '../src/adapters/process.js';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, '.local', 'tests'), { recursive: true });
const area = await mkdtemp(path.join(root, '.local', 'tests', 'human-review-'));
const quiet = { notifyFn: async () => {}, retryDelayMs: 0, log: () => {} };
const build = n => ({ text: `构建 ${n} 完成`, files: { 'value.txt': `round ${n}\n` } });
const review = verdict => ({ text: `### 验收清单\n通过\n### 必须修改\n${verdict === 'REVISE' ? '1. value.txt 需要修复。' : '无'}\n### 结论\nVERDICT: ${verdict}` });

async function git(cwd, args) {
  const result = await execute('git', args, { cwd, timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(entries, changes, fn) {
  const cwd = await mkdtemp(path.join(area, 'project-'));
  await mkdir(path.join(cwd, '.local'), { recursive: true });
  await mkdir(path.join(cwd, '.crew', 'tasks'), { recursive: true });
  await writeFile(path.join(cwd, '.gitignore'), '.local/\n.crew/runs/\n', 'utf8');
  const sheet = {
    goal: '验证每轮审阅后的人工作业门。', human_review: true,
    roles: { builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: [{ loop: ['build', 'check', 'review'] }], checks: { commands: [] }, ...changes,
  };
  const taskPath = path.join(cwd, '.crew', 'tasks', 'task.yaml');
  await writeFile(taskPath, stringify(sheet), 'utf8');
  const script = path.join(cwd, '.local', 'mock.json');
  await writeFile(script, JSON.stringify(entries), 'utf8');
  await git(cwd, ['init', '-b', 'main']);
  await git(cwd, ['config', 'user.name', 'Crew Human Review Test']);
  await git(cwd, ['config', 'user.email', 'crew-human-review@example.invalid']);
  await git(cwd, ['config', 'core.autocrlf', 'false']);
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', 'initial']);
  const originalScript = process.env.CREW_MOCK_SCRIPT;
  process.env.CREW_MOCK_SCRIPT = script;
  const run = options => runTask({ ...quiet, cwd, taskName: 'task', taskPath, ...options });
  const resume = (result, options = {}) => resumeRun({ ...quiet, cwd, runId: result.state.runId, ...options });
  const count = async () => JSON.parse(await readFile(`${script}.cursor.json`, 'utf8')).index;
  try { await fn({ cwd, run, resume, count }); }
  finally {
    if (originalScript === undefined) delete process.env.CREW_MOCK_SCRIPT;
    else process.env.CREW_MOCK_SCRIPT = originalScript;
  }
}

function assertGate(result, verdict, round = 1) {
  assert.equal(result.exitCode, 0);
  assert.equal(result.state.status, 'waiting_approval');
  assert.equal(result.state.approvalStage, 'review');
  assert.equal(result.state.nextStep, 'review_gate');
  assert.equal(result.state.round, round);
  assert.equal(result.state.rounds.find(item => item.n === round).verdict, verdict);
}

async function builderPrompts(runDir) {
  const prompts = [];
  for (const item of (await readdir(path.join(runDir, 'steps'))).sort()) {
    const step = path.join(runDir, 'steps', item);
    const metadata = JSON.parse(await readFile(path.join(step, 'meta.json'), 'utf8'));
    if (metadata.mode === 'write') prompts.push(await readFile(path.join(step, 'prompt.md'), 'utf8'));
  }
  return prompts;
}

test('自动模式保持一次运行直接通过', async () => {
  await fixture([build(1), review('APPROVED')], { human_review: false }, async ({ run, count }) => {
    const result = await run();
    assert.equal(result.state.status, 'approved');
    assert.equal(result.exitCode, 0);
    assert.equal(await count(), 2);
  });
});

test('人工模式在 APPROVED 后暂停，人工确认后完成且不重复模型审阅', async () => {
  await fixture([build(1), review('APPROVED')], {}, async ({ run, resume, count }) => {
    const pending = await run();
    assertGate(pending, 'APPROVED');
    assert.equal(await count(), 2);
    await assert.rejects(resume(pending), /approve|批准|审批/);
    const result = await resume(pending, { approve: true });
    assert.equal(result.state.status, 'approved');
    assert.equal(await count(), 2);
    assert.equal(result.state.rounds.length, 1);
  });
});

test('模型 REVISE 经人工确认后进入下一轮构建', async () => {
  await fixture([build(1), review('REVISE'), build(2), review('APPROVED')], {}, async ({ run, resume, count }) => {
    const first = await run();
    assertGate(first, 'REVISE');
    const second = await resume(first, { approve: true });
    assertGate(second, 'APPROVED', 2);
    assert.equal(await count(), 4);
    const prompts = await builderPrompts(second.runDir);
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].includes(first.state.rounds[0].reviewPath));
    const result = await resume(second, { approve: true });
    assert.equal(result.state.status, 'approved');
    assert.equal(await count(), 4);
  });
});

test('人工退回意见存盘并交给下一轮 builder，原模型审阅保留', async () => {
  await fixture([build(1), review('APPROVED'), build(2), review('APPROVED')], {}, async ({ run, resume, count }) => {
    const first = await run();
    assertGate(first, 'APPROVED');
    const originalReview = first.state.rounds[0].reviewPath;
    const originalText = await readFile(originalReview, 'utf8');
    const opinion = 'value.txt 需要写明最终值，请按我的修改意见继续。';
    const next = await resume(first, { approve: true, revise: opinion });
    assertGate(next, 'APPROVED', 2);
    const previous = next.state.rounds.find(round => round.n === 1);
    assert.equal(previous.modelReviewPath, originalReview);
    assert.notEqual(previous.reviewPath, originalReview);
    assert.equal(await readFile(originalReview, 'utf8'), originalText);
    assert.match(await readFile(previous.reviewPath, 'utf8'), /value\.txt 需要写明最终值/);
    const prompts = await builderPrompts(next.runDir);
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].includes(previous.reviewPath));
    assert.equal(await count(), 4);
    const result = await resume(next, { approve: true });
    assert.equal(result.state.status, 'approved');
    assert.equal(await count(), 4);
  });
});

test('检查失败时人工批准不能把模型 APPROVED 强行变成通过', async () => {
  await fixture([build(1), review('APPROVED')], {
    checks: { commands: ['node -e "process.exit(7)"'] }, stop_when: { max_rounds: 1 },
  }, async ({ run, resume, count }) => {
    const first = await run();
    assertGate(first, 'REVISE');
    assert.equal(first.state.rounds[0].checksPassed, false);
    const result = await resume(first, { approve: true });
    assert.equal(result.state.status, 'stopped');
    assert.equal(result.state.stopReason, 'max_rounds');
    assert.equal(result.exitCode, 2);
    assert.equal(result.state.rounds[0].verdict, 'REVISE');
    assert.equal(await count(), 2);
  });
});

test('BLOCKED 和第二次畸形结论直接停止，不等待人工门', async () => {
  await fixture([build(1), review('BLOCKED')], {}, async ({ run, count }) => {
    const result = await run();
    assert.equal(result.state.status, 'stopped');
    assert.equal(result.state.stopReason, 'blocked');
    assert.equal(await count(), 2);
  });
  await fixture([build(1), { text: '未给正式结论' }, build(2), { text: '仍未给结论' }], {}, async ({ run, resume, count }) => {
    const first = await run();
    assertGate(first, 'REVISE');
    const result = await resume(first, { approve: true });
    assert.equal(result.state.status, 'stopped');
    assert.equal(result.state.stopReason, 'review_malformed');
    assert.equal(await count(), 4);
  });
});

test('设计审批与逐轮审阅审批分开，人工 revise 只用于审阅门', async () => {
  await fixture([{ text: '设计正文' }, build(1), review('APPROVED')], {
    roles: { designer: { tool: 'mock', model: 'designer' }, builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: ['design', 'approve', { loop: ['build', 'check', 'review'] }],
  }, async ({ run, resume, count }) => {
    const design = await run();
    assert.equal(design.state.status, 'waiting_approval');
    assert.equal(design.state.approvalStage, 'design');
    assert.equal(await count(), 1);
    await assert.rejects(resume(design, { approve: true, revise: '只允许在审阅后退回' }), /审阅|review/);
    assert.equal(await count(), 1);
    const pendingReview = await resume(design, { approve: true });
    assertGate(pendingReview, 'APPROVED');
    assert.equal(await count(), 3);
    const result = await resume(pendingReview, { approve: true });
    assert.equal(result.state.status, 'approved');
    assert.equal(await count(), 3);
  });
});
