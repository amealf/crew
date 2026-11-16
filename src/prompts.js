import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { projectPath } from './paths.js';

const placeholders = new Set(['goal', 'decisions', 'checklist', 'design_path', 'round', 'prev_review_path', 'prev_check_path', 'diff_path', 'check_path', 'screenshot_paths', 'malformed_note']);
const pattern = /{{\s*([^{}]*?)\s*}}/g;
const defaultRoot = fileURLToPath(new URL('../prompts/', import.meta.url));

function valueText(value, name) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(item => valueText(item, name)).join('\n');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  throw new Error(`提示词占位符 ${name} 的值必须是文字、数字或文字数组。`);
}

export async function renderPrompt(role, context = {}) {
  if (!['designer', 'builder', 'reviewer'].includes(role)) throw new Error(`未知提示词角色：${role}`);
  const cwd = context.cwd ?? process.cwd();
  const override = await projectPath(cwd, path.join('.crew', 'prompts', `${role}.md`));
  let template;
  try { template = await readFile(override, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    template = await readFile(path.join(defaultRoot, `${role}.md`), 'utf8');
  }
  for (const match of template.matchAll(pattern)) {
    if (!placeholders.has(match[1])) throw new Error(`提示词 ${role} 含未知占位符：${match[1]}`);
  }
  const values = Object.fromEntries([...placeholders].map(name => [name, valueText(context[name], name)]));
  const lines = template.split(/\r?\n/);
  const headings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const fenced = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenced) {
      const marker = fenced[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence) return;
    const heading = /^(#{1,6})\s+/.exec(line);
    if (heading) headings.push({ start: index, level: heading[1].length });
  });
  const removed = new Set();
  lines.forEach((line, index) => {
    const empty = [...line.matchAll(pattern)].some(match => !values[match[1]].trim());
    if (!empty) return;
    const section = headings.filter(heading => heading.start <= index).at(-1);
    const start = section?.start ?? index;
    const end = section ? headings.find(heading => heading.start > index && heading.level <= section.level)?.start ?? lines.length : index + 1;
    for (let n = start; n < end; n += 1) removed.add(n);
  });
  return lines.filter((_, index) => !removed.has(index)).join('\n')
    .replace(pattern, (_, name) => values[name]).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
