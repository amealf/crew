import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadTaskSheet, validateTaskSheet } from '../src/tasksheet.js';
import { parseVerdict } from '../src/verdict.js';
import { renderPrompt } from '../src/prompts.js';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, '.local', 'tests'), { recursive: true });
const area = await mkdtemp(path.join(root, '.local', 'tests', 'inputs-'));
const valid = () => ({ goal: '实现计时器', roles: { builder: { tool: 'mock' }, reviewer: { tool: 'mock', model: 'review' } }, flow: [{ loop: ['build', 'check', 'review'] }] });
const validate = input => validateTaskSheet(input, { warn: () => {} });

test('任务单填默认值，读取 UTF-8 YAML，并保持输入独立', async () => {
  const input = valid();
  const result = validate(input);
  assert.deepEqual(result.stop_when, { max_hours: 24, max_rounds: null, step_timeout_minutes: 60, stall_rounds: 2 });
  assert.deepEqual(result.checks, { commands: [], screenshots: [] });
  assert.deepEqual(result.review_checklist, []);
  assert.equal(result.human_review, false);
  result.roles.builder.tool = 'claude';
  assert.equal(input.roles.builder.tool, 'mock');
  const file = path.join(area, 'task.yaml');
  await writeFile(file, 'goal: 中文多行\nroles:\n  builder: {tool: mock}\n  reviewer: {tool: codex}\nflow:\n  - loop: [build, review]\n', 'utf8');
  assert.equal((await loadTaskSheet(file)).goal, '中文多行');
  assert.deepEqual(Object.keys(result).sort(), ['checks', 'flow', 'goal', 'human_review', 'review_checklist', 'roles', 'stop_when']);
});

test('任务单错误包含字段，拒绝缺失角色、错误步骤与错误字段类型', () => {
  for (const [mutate, field] of [
    [task => { delete task.goal; }, 'goal'],
    [task => { task.goal = ' '; }, 'goal'],
    [task => { task.human_review = 'true'; }, 'human_review'],
    [task => { task.human_review = null; }, 'human_review'],
    [task => { task.human_review = 0; }, 'human_review'],
    [task => { task.roles.builder.tool = 'unknown'; }, 'roles.builder.tool'],
    [task => { delete task.roles.builder; }, 'roles.builder'],
    [task => { delete task.roles.reviewer; }, 'roles.reviewer'],
    [task => { task.flow = ['design', ...task.flow]; }, 'roles.designer'],
    [task => { task.flow[0].loop = ['build']; }, 'flow[0].loop'],
    [task => { task.flow[0].loop = ['review', 'build']; }, 'flow[0].loop'],
    [task => { task.flow[0].loop = ['build', ['review']]; }, 'flow[0].loop'],
    [task => { task.flow.push({ loop: ['build', 'review'] }); }, 'flow[1].loop'],
    [task => { task.flow.push('approve'); }, 'flow[1]'],
    [task => { task.flow = ['approve', 'approve', ...task.flow]; }, 'flow[1]'],
    [task => { task.flow = [{ typo: [] }]; }, 'flow[0]'],
    [task => { task.checks = { commands: [''] }; }, 'checks.commands[0]'],
    [task => { task.checks = { screenshots: [{ url: 'index.html', width: 0 }] }; }, 'checks.screenshots[0].width'],
    [task => { task.stop_when = { max_hours: null }; }, 'stop_when.max_hours'],
    [task => { task.stop_when = { max_rounds: 1.5 }; }, 'stop_when.max_rounds'],
  ]) {
    const task = valid(); mutate(task);
    assert.throws(() => validate(task), error => error.message.includes(field), field);
  }
  assert.throws(() => validate(null), /根节点/);
});

test('human_review 接受明确布尔值，作为已知字段且缺省为自动模式', () => {
  for (const value of [true, false]) {
    const warnings = [];
    const result = validateTaskSheet({ ...valid(), human_review: value }, { warn: warning => warnings.push(warning) });
    assert.equal(result.human_review, value);
    assert.equal(warnings.length, 0);
  }
  assert.equal(validate(valid()).human_review, false);
});

test('未知嵌套字段和重复工具型号给出警告，合法设计审批顺序可用', () => {
  const task = valid();
  task.goal_typo = 'x';
  task.roles.builder.modle = 'x';
  task.roles.reviewer = { tool: 'mock' };
  task.roles.designer = { tool: 'claude' };
  task.flow = ['design', 'approve', { loop: ['build', 'review'], lp: true }];
  task.checks = { commands: [], screenshots: [{ url: 'index.html', width: 390, widht: 12 }], commnads: [] };
  task.stop_when = { max_round: 2 };
  const warnings = [];
  const result = validateTaskSheet(task, { warn: message => warnings.push(message) });
  assert.equal(result.flow[0], 'design');
  for (const field of ['goal_typo', 'roles.builder.modle', 'roles.reviewer', 'flow[2].lp', 'checks.commnads', 'checks.screenshots[0].widht', 'stop_when.max_round']) {
    assert.ok(warnings.some(message => message.includes(field)), field);
  }
});

test('YAML 语法、重复键和读取错误包含可处理的字段信息', async () => {
  for (const source of ['goal: [unfinished', 'goal: one\ngoal: two']) {
    const file = path.join(area, `invalid-${source.length}.yaml`);
    await writeFile(file, source, 'utf8');
    await assert.rejects(loadTaskSheet(file), /YAML/);
  }
  await assert.rejects(loadTaskSheet(path.join(area, 'missing.yaml')), /path/);
});

test('审阅仅识别最后非空行，支持 Markdown 两端符号和大小写', () => {
  for (const verdict of ['APPROVED', 'REVISE', 'BLOCKED']) {
    assert.deepEqual(parseVerdict(`内容\nVERDICT: ${verdict}\n\n`), { verdict, malformed: false });
  }
  assert.deepEqual(parseVerdict('### **`verdict: approved`**  \r\n'), { verdict: 'APPROVED', malformed: false });
  for (const source of ['', '通过', 'VERDICT: APPROVED\n补充说明', 'VERDICT:APPROVED', 'VERDICT: APPROVED.', 'VERDICT:  APPROVED', 'VERDICT: **APPROVED**']) {
    assert.deepEqual(parseVerdict(source), { verdict: 'REVISE', malformed: true }, source);
  }
});

test('默认提示词删除空小节，保留当前和上一轮文件路径', async () => {
  const cwd = await mkdtemp(path.join(area, 'project-'));
  const first = await renderPrompt('builder', { cwd, goal: '实现目标', round: 1 });
  assert.match(first, /第 1 轮/);
  assert.doesNotMatch(first, /上一轮审阅|上一轮检查|## 设计|已有决议|{{/);
  const next = await renderPrompt('builder', { cwd, goal: '实现目标', round: 2, design_path: 'design.md', prev_review_path: 'reviews/review-1.md', prev_check_path: 'checks/check-1.json', malformed_note: '上一轮审阅没有给出合规结论' });
  assert.match(next, /reviews\/review-1.md/);
  assert.match(next, /checks\/check-1.json/);
  assert.match(next, /上一轮审阅没有给出合规结论/);
  const review = await renderPrompt('reviewer', { cwd, goal: '实现目标', round: 2, diff_path: 'diff.patch', screenshot_paths: ['one.png', 'two.png'], checklist: ['测试通过'] });
  assert.match(review, /one.png\ntwo.png/);
  assert.match(review, /测试通过/);
});

test('项目模板优先，拒绝未知占位符和项目外模板链接', async () => {
  const cwd = await mkdtemp(path.join(area, 'override-'));
  await mkdir(path.join(cwd, '.crew', 'prompts'), { recursive: true });
  const file = path.join(cwd, '.crew', 'prompts', 'builder.md');
  await writeFile(file, '# 自定义\n{{goal}}\n## 可选\n{{design_path}}\n### 子节\n也应移除\n## 必须\n{{round}}\n', 'utf8');
  const rendered = await renderPrompt('builder', { cwd, goal: '任务', round: 2 });
  assert.equal(rendered, '# 自定义\n任务\n## 必须\n2\n');
  await writeFile(file, '## 坏模板\n{{missing_name}}\n', 'utf8');
  await assert.rejects(renderPrompt('builder', { cwd }), /missing_name/);
  await assert.rejects(renderPrompt('../outside', { cwd }), /角色/);
  const linked = await mkdtemp(path.join(area, 'linked-'));
  await mkdir(path.join(linked, '.crew'));
  await symlink(path.join(cwd, '.crew', 'prompts'), path.join(linked, '.crew', 'prompts'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(renderPrompt('builder', { cwd: linked }), /项目外/);
});
