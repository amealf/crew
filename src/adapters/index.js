import * as claude from './claude.js';
import * as codex from './codex.js';
import * as agy from './agy.js';
import * as mock from './mock.js';

export const toolNames = ['claude', 'codex', 'agy', 'mock'];
export function getAdapter(tool) {
  const adapter = { claude, codex, agy, mock }[tool];
  if (!toolNames.includes(tool)) throw new Error(`未知工具 ${tool}，请使用 ${toolNames.join('、')}。`);
  return adapter;
}
