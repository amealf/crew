import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { runTask } from '../src/engine.js';
import { main } from '../src/cli.js';
import { loadRun } from '../src/runlog.js';
import { execute } from '../src/adapters/process.js';
import { notificationScript } from '../src/notify.js';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, '.local', 'tests'), { recursive: true });
const area = await mkdtemp(path.join(root, '.local', 'tests', 'human-cli-'));
const bin = fileURLToPath(new URL('../bin/crew.js', import.meta.url));
const quiet = { log: () => {}, notifyFn: async () => ({ ok: true }), retryDelayMs: 0 };
const build = n => ({ text: `第${n}轮完成`, files: { 'value.txt': `round ${n}\n` } });
const review = verdict => ({ text: `### 必须修改\n${verdict === 'REVISE' ? '1. 继续修改。' : '无'}\n### 结论\nVERDICT: ${verdict}` });

async function git(cwd, args) {
  const result = await execute('git', args, { cwd, timeoutMs: 20000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(entries, changes, action) {
  const cwd = await mkdtemp(path.join(area, 'project-'));
  await mkdir(path.join(cwd, '.crew', 'tasks'), { recursive: true });
  await mkdir(path.join(cwd, '.local'), { recursive: true });
  await writeFile(path.join(cwd, '.gitignore'), '.crew/runs/\n.local/\n', 'utf8');
  const taskPath = path.join(cwd, '.crew', 'tasks', 'task.yaml');
  const sheet = { goal: '验证人工确认命令。',
    roles: { builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: [{ loop: ['build', 'review'] }], human_review: true, ...changes };
  await writeFile(taskPath, stringify(sheet), 'utf8');
  await git(cwd, ['init', '-b', 'main']);
  await git(cwd, ['config', 'user.name', 'Crew Human CLI Test']);
  await git(cwd, ['config', 'user.email', 'crew-test@example.invalid']);
  await git(cwd, ['config', 'core.autocrlf', 'false']);
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', 'initial']);
  const scriptPath = path.join(cwd, '.local', 'mock.json');
  await writeFile(scriptPath, JSON.stringify(entries), 'utf8');
  const previous = process.env.CREW_MOCK_SCRIPT;
  process.env.CREW_MOCK_SCRIPT = scriptPath;
  const invoke = () => runTask({ ...quiet, cwd, taskName: 'task', taskPath });
  const cli = (args, options = {}) => main(args, { ...quiet, cwd, ...options });
  const persisted = async () => (await loadRun(cwd)).state;
  const consumed = async () => JSON.parse(await readFile(`${scriptPath}.cursor.json`, 'utf8')).index;
  try { await action({ cwd, invoke, cli, persisted, consumed }); }
  finally { if (previous === undefined) delete process.env.CREW_MOCK_SCRIPT; else process.env.CREW_MOCK_SCRIPT = previous; }
}

test('人工审阅确认可用CLI退回带意见，下一轮审阅通过后CLI批准完成', async () => {
  await fixture([build(1), review('APPROVED'), build(2), review('APPROVED')], {}, async ({ invoke, cli, persisted, consumed }) => {
    const initial = await invoke();
    assert.equal(initial.state.status, 'waiting_approval');
    assert.equal(initial.state.approvalStage, 'review');
    const lines = [];
    assert.equal(await cli(['status'], { log: line => lines.push(line) }), 0);
    assert.match(lines.join('\n'), /approvalStage.*review/);
    assert.match(lines.join('\n'), /等待审阅确认/);
    assert.match(lines.join('\n'), /crew approve/);
    assert.match(lines.join('\n'), /crew revise/);
    assert.equal(await cli(['revise', initial.state.runId, '--note', '请增加暂停后继续的边界测试。']), 0);
    const second = await persisted();
    assert.equal(second.status, 'waiting_approval');
    assert.equal(second.approvalStage, 'review');
    assert.equal(second.round, 2);
    assert.equal(await consumed(), 4);
    assert.equal(await cli(['approve']), 0);
    assert.equal((await persisted()).status, 'approved');
    assert.equal(await consumed(), 4);
  });
});

test('人工批准模型REVISE会进入下一轮，保持默认全自动行为', async () => {
  await fixture([build(1), review('REVISE'), build(2), review('APPROVED')], {}, async ({ invoke, cli, persisted, consumed }) => {
    const initial = await invoke();
    assert.equal(initial.state.status, 'waiting_approval');
    assert.equal(initial.state.rounds[0].verdict, 'REVISE');
    assert.equal(await cli(['approve', initial.state.runId]), 0);
    const second = await persisted();
    assert.equal(second.round, 2);
    assert.equal(second.status, 'waiting_approval');
    assert.equal(await consumed(), 4);
    assert.equal(await cli(['approve']), 0);
    assert.equal((await persisted()).status, 'approved');
  });
  await fixture([build(1), review('APPROVED')], { human_review: undefined }, async ({ invoke, consumed }) => {
    assert.equal((await invoke()).state.status, 'approved');
    assert.equal(await consumed(), 2);
  });
});

test('revise缺少意见、错误状态和设计确认阶段均以CLI退出码1拒绝', async () => {
  await fixture([build(1), review('APPROVED')], { human_review: false }, async ({ cwd, invoke, persisted }) => {
    const completed = await invoke();
    for (const args of [
      ['revise'], ['revise', '--note'], ['revise', '--note', '  '],
      ['revise', completed.state.runId, '--note', '请修改'],
    ]) {
      const result = await execute(process.execPath, [bin, ...args], { cwd, timeoutMs: 20000 });
      assert.equal(result.exitCode, 1, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      assert.ok(result.stderr.includes('错误'), result.stderr);
    }
    assert.equal((await persisted()).status, 'approved');
  });
  await fixture([{ text: '设计正文' }, build(1), review('APPROVED')], {
    roles: { designer: { tool: 'mock', model: 'designer' }, builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: ['design', 'approve', { loop: ['build', 'review'] }],
  }, async ({ cwd, invoke, cli, persisted, consumed }) => {
    const waiting = await invoke();
    assert.equal(waiting.state.approvalStage, 'design');
    const lines = [];
    await cli(['status'], { log: line => lines.push(line) });
    assert.match(lines.join('\n'), /等待设计批准/);
    const result = await execute(process.execPath, [bin, 'revise', '--note', '不能在设计阶段退回审阅'], { cwd, timeoutMs: 20000 });
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal((await persisted()).status, 'waiting_approval');
    assert.equal((await persisted()).approvalStage, 'design');
    assert.equal(await consumed(), 1);
  });
});

test('人工确认通知使用同时适用于设计和审阅的文案', () => {
  const script = notificationScript({ task: '人工确认', status: 'waiting_approval' });
  const payload = script.match(/FromBase64String\('([^']+)'\)/)[1];
  const xml = Buffer.from(payload, 'base64').toString('utf8');
  assert.ok(xml.includes('等待人工确认'));
  assert.ok(!xml.includes('等待设计批准'));
});
