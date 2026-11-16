import { execute, prepareStep, saveResult, outcome, probeCommand, parseJsonResult } from './process.js';

export function invocation({ mode, model }) {
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'];
  if (model) args.push('--model', model);
  if (mode === 'read') args.push('--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob');
  else args.push('--permission-mode', 'acceptEdits', '--tools', 'Read,Grep,Glob,Edit,Write,Bash',
    '--allowedTools', 'Read,Grep,Glob,Edit,Write,Bash(node --test*),Bash(npm test*)');
  return args;
}

export async function run(options) {
  const settings = { timeoutMs: 3_600_000, ...options };
  const directory = await prepareStep(settings);
  const raw = await execute('claude', invocation(settings), settings);
  let parsed = { text: '' }, parseError = null;
  if (!raw.timedOut && !raw.interrupted && !raw.error && raw.stdout.trim()) {
    try { parsed = parseJsonResult(raw.stdout); } catch (error) { parseError = `无法解析 Claude 回答：${error.message}`; }
  }
  return saveResult(directory, outcome(raw, parsed.text, parseError, parsed.quotaHit, parsed.toolError), raw,
    { tool: 'claude', model: settings.model ?? null, mode: settings.mode });
}

export const probe = () => probeCommand('claude');
