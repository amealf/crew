import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { toolNames } from './adapters/index.js';
import { projectPath } from './paths.js';

export const meetingExample = `# 省略 model 时使用工具的默认型号。
participants:
  - { tool: claude }
  - { tool: codex }
  - { tool: agy }
# 省略 summarizer 时由第一位参会者总结。
# summarizer: { tool: codex }
timeout_minutes: 15
`;

function fail(field, message) { throw new Error(`会审 ${field}：${message}`); }
function mapping(value, field, allowed, warn) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, '必须是对象。');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) warn(`警告：会审 ${field}.${key} 是未知字段，请检查拼写。`);
  }
}

function worker(value, field, warn) {
  mapping(value, field, ['tool', 'model'], warn);
  if (!toolNames.includes(value.tool)) fail(`${field}.tool`, '只能是 claude、codex、agy 或 mock。');
  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim())) {
    fail(`${field}.model`, '必须是非空文字。');
  }
  return { tool: value.tool, model: value.model?.trim() ?? null };
}

export function parseWorker(value, field) {
  const [tool, ...parts] = value.trim().split(':');
  return worker({ tool: tool.trim(), ...(parts.length ? { model: parts.join(':') } : {}) }, field, () => {});
}

function participants(list, field, warn, parse) {
  if (!Array.isArray(list) || !list.length) fail(field, '至少需要一位参会者。');
  const members = list.map((value, i) => parse(value, `${field}[${i}]`, warn));
  const ids = new Set();
  return members.map(({ tool, model }, i) => {
    const repeated = members.some((item, index) => index !== i && item.tool === tool);
    const id = repeated ? `${tool}-${(model ?? 'default').replace(/[^a-zA-Z0-9.-]/g, '-')}` : tool;
    if (ids.has(id.toLowerCase())) fail(field, `参会者编号重复：${id}。请使用不同型号。`);
    ids.add(id.toLowerCase());
    return { id, tool, model };
  });
}

export async function loadMeetingConfig(cwd, withTools, warn = console.warn) {
  const file = await projectPath(cwd, '.crew/meeting.yaml');
  let source;
  try { source = await readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let data = {};
  if (source !== undefined) {
    const doc = parseDocument(source, { uniqueKeys: true });
    if (doc.errors.length) fail('.crew/meeting.yaml', doc.errors[0].message);
    for (const warning of doc.warnings) warn(`警告：会审 YAML：${warning.message}`);
    data = doc.toJS({ maxAliasCount: 100 });
    mapping(data, '.crew/meeting.yaml', ['participants', 'summarizer', 'timeout_minutes'], warn);
  }
  const members = withTools === undefined
    ? participants(data.participants === undefined ? toolNames.slice(0, 3).map(tool => ({ tool })) : data.participants, 'participants', warn, worker)
    : participants(withTools.split(','), '--with', warn, parseWorker);
  const { tool, model } = members[0];
  const summarizer = data.summarizer === undefined ? { tool, model } : worker(data.summarizer, 'summarizer', warn);
  const timeoutMinutes = data.timeout_minutes === undefined ? 15 : data.timeout_minutes;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || timeoutMinutes * 60_000 > 2 ** 31 - 1) {
    fail('timeout_minutes', '必须是大于 0 且在定时器范围内的分钟数。');
  }
  return { participants: members, summarizer, timeoutMinutes };
}
