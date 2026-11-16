import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { stringify } from 'yaml';
import { execute } from '../src/adapters/process.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = path.join(root, 'bin', 'crew.js');
await mkdir(path.join(root, '.local', 'tests'), { recursive: true });
const area = await mkdtemp(path.join(root, '.local', 'tests', 'cli-'));
const build = value => ({ text: '实现完成', files: { 'value.txt': `${value}\n` } });
const approved = { text: '### 必须修改\n无\nVERDICT: APPROVED' };

async function git(cwd, args) {
  const result = await execute('git', args, { cwd, timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function fixture({ sheet: changes = {}, entries = [build('one'), approved], gitRepo = true, secondTask = false } = {}) {
  const cwd = await mkdtemp(path.join(area, 'project-'));
  await mkdir(path.join(cwd, '.local'), { recursive: true });
  await mkdir(path.join(cwd, '.crew', 'tasks'), { recursive: true });
  await writeFile(path.join(cwd, '.gitignore'), '.local/\n.crew/runs/\n', 'utf8');
  await writeFile(path.join(cwd, 'DECISIONS.md'), '', 'utf8');
  const sheet = {
    goal: '离线 CLI 测试目标',
    roles: { builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: [{ loop: ['build', 'review'] }], ...changes,
  };
  await writeFile(path.join(cwd, '.crew', 'tasks', 'task.yaml'), stringify(sheet), 'utf8');
  if (secondTask) await writeFile(path.join(cwd, '.crew', 'tasks', 'second.yaml'), stringify({ ...sheet, goal: '第二个离线任务' }), 'utf8');
  const script = path.join(cwd, '.local', 'mock.json');
  await writeFile(script, JSON.stringify(entries), 'utf8');
  if (gitRepo) {
    await git(cwd, ['init', '-b', 'main']);
    await git(cwd, ['config', 'user.name', 'Crew CLI Test']);
    await git(cwd, ['config', 'user.email', 'crew-cli-test@example.invalid']);
    await git(cwd, ['config', 'core.autocrlf', 'false']);
    await git(cwd, ['add', '-A']);
    await git(cwd, ['commit', '-m', 'initial']);
  }
  const cli = (args, env = {}) => execute(process.execPath, [entry, ...args], {
    cwd, env: { ...process.env, CREW_MOCK_SCRIPT: script, ...env }, timeoutMs: 40_000,
  });
  return { cwd, cli, script };
}

async function stateFor(cwd, task) {
  const runs = path.join(cwd, '.crew', 'runs');
  const names = (await readdir(runs, { withFileTypes: true })).filter(item => item.isDirectory() && item.name.startsWith(`${task}-`)).map(item => item.name).sort();
  assert.ok(names.length > 0, `没有 ${task} 的运行记录`);
  const runDir = path.join(runs, names.at(-1));
  return { state: JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8')), runDir };
}

test('CLI init 幂等，保留手写任务和既有 gitignore 内容', async () => {
  const { cwd, cli } = await fixture({ gitRepo: false });
  const first = await cli(['init']);
  assert.equal(first.exitCode, 0, first.stderr);
  const example = path.join(cwd, '.crew', 'tasks', 'example.yaml');
  assert.match(await readFile(example, 'utf8'), /# 一个最小任务单/);
  await writeFile(example, '# 手写任务，必须保留\ngoal: 保留我的内容\n', 'utf8');
  const second = await cli(['init']);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(await readFile(example, 'utf8'), '# 手写任务，必须保留\ngoal: 保留我的内容\n');
  const ignore = await readFile(path.join(cwd, '.gitignore'), 'utf8');
  assert.ok(ignore.includes('.local/'));
  assert.equal(ignore.split(/\r?\n/).filter(line => line === '.crew/runs/').length, 1);
  await access(path.join(cwd, '.crew', 'prompts'));
});

test('CLI validate 打印默认值，字段错误返回 1 和中文错误', async () => {
  const { cwd, cli } = await fixture({ gitRepo: false });
  const valid = await cli(['validate', 'task']);
  assert.equal(valid.exitCode, 0, valid.stderr);
  const output = JSON.parse(valid.stdout);
  assert.equal(output.goal, '离线 CLI 测试目标');
  assert.deepEqual(output.stop_when, { max_hours: 24, max_rounds: null, step_timeout_minutes: 60, stall_rounds: 2 });
  assert.deepEqual(output.checks, { commands: [], screenshots: [] });
  await writeFile(path.join(cwd, '.crew', 'tasks', 'bad.yaml'), 'roles: {}\nflow: []\n', 'utf8');
  const bad = await cli(['validate', 'bad']);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /错误：.*goal/);
});

test('CLI dry-run 在工具不可发现时仍可预览，且不创建运行目录或消耗脚本', async () => {
  const { cwd, cli, script } = await fixture({ gitRepo: false, sheet: {
    roles: { designer: { tool: 'claude' }, builder: { tool: 'codex' }, reviewer: { tool: 'agy' } },
    flow: ['design', { loop: ['build', 'check', 'review'] }],
  } });
  // The Node executable is absolute; no worker or git can be discovered via PATH.
  const result = await cli(['run', 'task', '--dry-run'], { PATH: '' });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /离线 CLI 测试目标/);
  assert.match(result.stdout, /design.*build.*check.*review/);
  assert.match(result.stdout, /首棒：designer/);
  await assert.rejects(access(path.join(cwd, '.crew', 'runs')), { code: 'ENOENT' });
  await assert.rejects(access(`${script}.cursor.json`), { code: 'ENOENT' });
});

test('CLI mock run 完成，status 默认选择最近运行，也支持明确运行编号', async () => {
  const { cwd, cli } = await fixture({ secondTask: true, entries: [build('one'), approved, build('two'), approved] });
  const first = await cli(['run', 'task']);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const old = await stateFor(cwd, 'task');
  assert.equal(old.state.status, 'approved');
  const next = await cli(['run', 'second']);
  assert.equal(next.exitCode, 0, next.stderr || next.stdout);
  const recent = await stateFor(cwd, 'second');
  assert.equal(recent.state.status, 'approved');
  const status = await cli(['status']);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.ok(status.stdout.includes(recent.state.runId));
  assert.match(status.stdout, /状态：approved/);
  assert.match(status.stdout, /第 1 轮：APPROVED/);
  const specific = await cli(['status', old.state.runId]);
  assert.equal(specific.exitCode, 0, specific.stderr);
  assert.ok(specific.stdout.includes(old.state.runId));
  assert.ok(!specific.stdout.includes(recent.state.runId));
});

test('CLI approve 恢复 waiting_approval，设计结果不被重复消费', async () => {
  const { cwd, cli, script } = await fixture({ entries: [{ text: '请按此设计实现' }, build('approved'), approved], sheet: {
    roles: { designer: { tool: 'mock', model: 'designer' }, builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: ['design', 'approve', { loop: ['build', 'review'] }],
  } });
  const first = await cli(['run', 'task']);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const pending = await stateFor(cwd, 'task');
  assert.equal(pending.state.status, 'waiting_approval');
  assert.equal(JSON.parse(await readFile(`${script}.cursor.json`, 'utf8')).index, 1);
  const resumed = await cli(['approve', pending.state.runId]);
  assert.equal(resumed.exitCode, 0, resumed.stderr || resumed.stdout);
  assert.equal((await stateFor(cwd, 'task')).state.status, 'approved');
  assert.equal(JSON.parse(await readFile(`${script}.cursor.json`, 'utf8')).index, 3);
  const again = await cli(['approve']);
  assert.equal(again.exitCode, 1);
  assert.match(again.stderr, /没有等待审批/);
});

test('CLI resume --extend-hours 扩展时间并续跑，拒绝无效小时参数', async () => {
  const { cwd, cli, script } = await fixture({ sheet: { stop_when: { max_hours: 1 / 3_600_000 } } });
  const first = await cli(['run', 'task']);
  assert.equal(first.exitCode, 2, first.stderr || first.stdout);
  const stopped = await stateFor(cwd, 'task');
  assert.equal(stopped.state.stopReason, 'max_hours');
  await assert.rejects(access(`${script}.cursor.json`), { code: 'ENOENT' });
  for (const args of [['resume', '--extend-hours', '0'], ['resume', '--extend-hours'], ['resume', '--extend-hours', '-1'], ['resume', '--extend-hours', 'one']]) {
    const invalid = await cli(args);
    assert.equal(invalid.exitCode, 1, args.join(' '));
    assert.match(invalid.stderr, /extend-hours/);
  }
  const resumed = await cli(['resume', '--extend-hours', '1']);
  assert.equal(resumed.exitCode, 0, resumed.stderr || resumed.stdout);
  const completed = await stateFor(cwd, 'task');
  assert.equal(completed.state.status, 'approved');
  assert.equal(completed.state.extendedHours, 1);
});

test('CLI 未知命令、参数和目录穿越任务名返回 1', async () => {
  const { cli } = await fixture({ gitRepo: false });
  for (const args of [['unknown'], ['init', 'unexpected'], ['run'], ['run', 'task', '--other'], ['validate', '../task'], ['status', '--other'], ['resume', '--other'], ['approve', '--extend-hours', '1']]) {
    const result = await cli(args);
    assert.equal(result.exitCode, 1, args.join(' '));
    assert.match(result.stderr, /错误：/);
  }
  const help = await cli(['--help']);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /crew resume/);
});
