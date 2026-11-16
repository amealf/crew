import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execute, prepareStep, saveResult, outcome, probeCommand } from './process.js';

export function invocation({ mode, model }, directory) {
  const args = ['exec', '-s', mode === 'read' ? 'read-only' : 'workspace-write', '--ephemeral',
    '--color', 'never', '--output-last-message', path.join(directory, 'last-message.txt')];
  if (model) args.push('-m', model);
  args.push('-');
  return args;
}

export async function run(options) {
  const settings = { timeoutMs: 3_600_000, ...options };
  const directory = await prepareStep(settings);
  await writeFile(path.join(directory, 'last-message.txt'), '', 'utf8');
  // A standalone CLI has no desktop AppX package identity. These inherited
  // hints request the desktop-only runner and break its normal Windows sandbox.
  // Keep the explicit read-only/workspace-write policy and all auth settings.
  const env = { ...process.env };
  delete env.CODEX_WINDOWS_REGISTERED_CORE;
  delete env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY;
  const raw = await execute('codex', invocation(settings, directory), { ...settings, env });
  let text = '';
  if (!raw.timedOut && !raw.interrupted && !raw.error) {
    try { text = await readFile(path.join(directory, 'last-message.txt'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return saveResult(directory, outcome(raw, text), raw,
    { tool: 'codex', model: settings.model ?? null, mode: settings.mode });
}

export const probe = () => probeCommand('codex');
