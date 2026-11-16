import { execute, prepareStep, saveResult, outcome, probeCommand, quotaPattern } from './process.js';

export function invocation({ mode, model }) {
  const args = ['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (model) args.push('--model', model);
  // plan is a prompt prefix, not a permission boundary. Deny writes and
  // command/MCP side effects in session-only settings (agy 1.5.9+).
  if (mode === 'read') args.push('--sandbox', '--mode', 'plan', '--settings', JSON.stringify({
    permissions: { deny: ['write_file(*)', 'command(*)', 'mcp(*)', 'execute_url(*)', 'download_url(*)'] },
  }));
  else args.push('--sandbox', '--mode', 'auto');
  return args;
}

export function parseResponse(stdout) {
  const events = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const results = events.filter(event => event.event === 'result');
  if (results.length !== 1 || typeof results[0].result?.response !== 'string') {
    throw new Error('流式输出必须包含一个 result.response 最终回答，请核实 agy 版本。');
  }
  const result = results[0].result;
  const toolError = result.status !== 'SUCCESS';
  return { text: result.response, toolError, quotaHit: toolError && quotaPattern.test(result.error ?? '') };
}

export async function run(options) {
  const settings = { timeoutMs: 3_600_000, ...options };
  const directory = await prepareStep(settings);
  const input = `${JSON.stringify({ event: 'user', message: { content: settings.prompt } })}\n`;
  const raw = await execute('agy', invocation(settings), { ...settings, prompt: input });
  let parsed = { text: '' }, parseError = null;
  if (!raw.timedOut && !raw.interrupted && !raw.error && raw.stdout.trim()) {
    try { parsed = parseResponse(raw.stdout); } catch (error) { parseError = `无法解析 agy 回答：${error.message}`; }
  }
  return saveResult(directory, outcome(raw, parsed.text, parseError, parsed.quotaHit, parsed.toolError), raw,
    { tool: 'agy', model: settings.model ?? null, mode: settings.mode });
}

export const probe = () => probeCommand('agy');
