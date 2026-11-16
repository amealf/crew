import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

const tools = new Set(['claude', 'codex', 'agy', 'mock']);
const roles = new Set(['designer', 'builder', 'reviewer']);
const defaults = { max_hours: 24, max_rounds: null, step_timeout_minutes: 60, stall_rounds: 2 };

function fail(field, message) { throw new Error(`任务单 ${field}：${message}`); }
function mapping(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, '必须是对象。');
}
function text(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(field, '必须是非空文字。');
}
function unknown(value, known, field, warn) {
  for (const key of Object.keys(value)) if (!known.has(key)) warn(`警告：任务单 ${field ? `${field}.` : ''}${key} 是未知字段，请检查拼写。`);
}
function stringArray(value, field) {
  if (!Array.isArray(value)) fail(field, '必须是数组。');
  value.forEach((item, index) => text(item, `${field}[${index}]`));
}

export function validateTaskSheet(input, { warn = console.warn } = {}) {
  mapping(input, '根节点');
  unknown(input, new Set(['goal', 'roles', 'flow', 'checks', 'review_checklist', 'stop_when', 'human_review']), '', warn);
  text(input.goal, 'goal');
  const humanReview = input.human_review === undefined ? false : input.human_review;
  if (typeof humanReview !== 'boolean') fail('human_review', '必须是 true 或 false。');
  mapping(input.roles, 'roles');
  unknown(input.roles, roles, 'roles', warn);
  for (const [role, config] of Object.entries(input.roles)) {
    mapping(config, `roles.${role}`);
    unknown(config, new Set(['tool', 'model']), `roles.${role}`, warn);
    if (!tools.has(config.tool)) fail(`roles.${role}.tool`, '只能是 claude、codex、agy 或 mock。');
    if (config.model !== undefined) text(config.model, `roles.${role}.model`);
  }
  for (const role of ['builder', 'reviewer']) {
    if (!input.roles[role]) fail(`roles.${role}`, '必须指定这个角色。');
  }
  if (!Array.isArray(input.flow) || !input.flow.length) fail('flow', '必须是包含一个 loop 的步骤数组。');
  let sawDesign = false, sawApproval = false, sawLoop = false;
  input.flow.forEach((step, index) => {
    const field = `flow[${index}]`;
    if (typeof step === 'string') {
      if (step !== 'design' && step !== 'approve') fail(field, '只支持 design、approve 和 loop。');
      if (sawLoop) fail(field, 'design 和 approve 必须放在 loop 前面。');
      if (step === 'design') {
        if (sawDesign || sawApproval) fail(field, 'design 只能出现一次，并且必须在 approve 前面。');
        if (!input.roles.designer) fail('roles.designer', 'flow 的 design 步骤需要 designer。');
        sawDesign = true;
      } else {
        if (sawApproval) fail(field, 'approve 只能出现一次。');
        sawApproval = true;
      }
      return;
    }
    mapping(step, field);
    unknown(step, new Set(['loop']), field, warn);
    if (!Object.hasOwn(step, 'loop')) fail(field, '步骤对象必须包含 loop。');
    if (sawLoop) fail(`${field}.loop`, '整个 flow 只能包含一个 loop。');
    if (!Array.isArray(step.loop)) fail(`${field}.loop`, '必须是步骤数组。');
    if (step.loop.some(name => typeof name !== 'string')) fail(`${field}.loop`, '每个步骤必须是文字。');
    const joined = step.loop.join(',');
    if (joined !== 'build,review' && joined !== 'build,check,review') {
      fail(`${field}.loop`, '必须按 build、可选的 check、review 排列，且每个步骤只出现一次。');
    }
    sawLoop = true;
  });
  if (!sawLoop) fail('flow', '必须包含一个 loop。');

  const checks = input.checks === undefined ? {} : input.checks;
  mapping(checks, 'checks');
  unknown(checks, new Set(['commands', 'screenshots']), 'checks', warn);
  const commands = checks.commands === undefined ? [] : checks.commands;
  stringArray(commands, 'checks.commands');
  const screenshots = checks.screenshots === undefined ? [] : checks.screenshots;
  if (!Array.isArray(screenshots)) fail('checks.screenshots', '必须是数组。');
  screenshots.forEach((shot, index) => {
    const field = `checks.screenshots[${index}]`;
    mapping(shot, field);
    unknown(shot, new Set(['url', 'width']), field, warn);
    text(shot.url, `${field}.url`);
    if (!Number.isSafeInteger(shot.width) || shot.width <= 0) fail(`${field}.width`, '必须是正整数。');
  });
  const checklist = input.review_checklist === undefined ? [] : input.review_checklist;
  stringArray(checklist, 'review_checklist');
  const stop = input.stop_when === undefined ? {} : input.stop_when;
  mapping(stop, 'stop_when');
  unknown(stop, new Set(Object.keys(defaults)), 'stop_when', warn);
  const stopWhen = { ...defaults, ...stop };
  for (const key of ['max_hours', 'step_timeout_minutes']) {
    if (!Number.isFinite(stopWhen[key]) || stopWhen[key] <= 0) fail(`stop_when.${key}`, '必须是大于 0 的数字。');
  }
  for (const key of ['max_rounds', 'stall_rounds']) {
    if (key === 'max_rounds' && stopWhen[key] === null) continue;
    if (!Number.isSafeInteger(stopWhen[key]) || stopWhen[key] <= 0) fail(`stop_when.${key}`, '必须是正整数。');
  }
  const builder = input.roles.builder, reviewer = input.roles.reviewer;
  if (builder.tool === reviewer.tool && (builder.model ?? '') === (reviewer.model ?? '')) {
    warn('警告：roles.builder 和 roles.reviewer 使用了相同的工具与型号组合，建议使用独立审阅者。');
  }
  return structuredClone({ ...input, human_review: humanReview, checks: { ...checks, commands, screenshots }, review_checklist: checklist, stop_when: stopWhen });
}

export async function loadTaskSheet(file, options) {
  let source;
  try { source = await readFile(file, 'utf8'); }
  catch (error) { throw new Error(`任务单 path：无法读取 ${file}，请检查文件路径。${error.message}`, { cause: error }); }
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) fail('YAML', document.errors[0].message);
  let data;
  try { data = document.toJS({ maxAliasCount: 100 }); }
  catch (error) { fail('YAML', error.message); }
  for (const warning of document.warnings) (options?.warn ?? console.warn)(`警告：任务单 YAML：${warning.message}`);
  return validateTaskSheet(data, options);
}
