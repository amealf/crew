import spawn from 'cross-spawn';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectPath } from '../paths.js';

// Codex may print telemetry event names such as codex_usage_limit_banner_shown
// in diagnostics. Match actual messages/error codes, not those event names.
export const quotaPattern = /\brate[\s-]+limit(?:ed|ing)?\b|\bquota\b|\busage[\s-]+limit\b|\b(?:rate_limit_exceeded|insufficient_quota|quota_exceeded|usage_limit_reached)\b/i;

export async function killTree(child) {
  if (!child.pid) return null;
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errorText = '';
      killer.stdout.setEncoding('utf8');
      killer.stderr.setEncoding('utf8');
      killer.stdout.on('data', chunk => { output += chunk; });
      killer.stderr.on('data', chunk => { errorText += chunk; });
      killer.once('error', error => { errorText = error.message; child.kill(); });
      killer.once('close', code => {
        const pids = [...new Set([child.pid, ...output.split(/\r?\n/).map(line => Number(line.match(/\bPID\s+(\d+)/i)?.[1])).filter(Boolean)])];
        const remainingPids = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } });
        resolve({ exitCode: code, pids, remainingPids, error: errorText || null });
      });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
    return { exitCode: 0, pids: [child.pid] };
  }
}

export async function execute(command, args, { cwd, prompt = '', timeoutMs = 60_000, signal, env = process.env } = {}) {
  const start = performance.now();
  if (signal?.aborted) return { stdout: '', stderr: '', exitCode: null, timedOut: false, interrupted: true, durationMs: 0, error: '运行已中断。' };
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false, interrupted = false, failure = null;
    let termination = Promise.resolve();
    let terminating = false;
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      termination = killTree(child);
    };
    const abort = () => { interrupted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { failure = error.code === 'ENOENT' ? `找不到 ${command}，请安装工具并把它加入 PATH。` : error.message; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE' && error.code !== 'EOF') failure = error.message; });
    child.stdin.end(prompt, 'utf8');
    child.once('close', async code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const treeKill = await termination;
      resolve({ stdout, stderr, exitCode: code, timedOut, interrupted,
        durationMs: Math.round(performance.now() - start), error: failure, pid: child.pid, treeKill });
    });
  });
}

export async function prepareStep({ cwd, stepDir, mode, prompt, timeoutMs }) {
  if (!['read', 'write'].includes(mode)) throw new Error('mode 必须是 read 或 write。');
  if (typeof prompt !== 'string') throw new Error('prompt 必须是文字。');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs 必须是正数。');
  const directory = await projectPath(cwd, stepDir);
  await mkdir(directory, { recursive: true });
  for (const name of ['prompt.md', 'raw.log', 'stderr.log', 'output.md', 'meta.json', 'last-message.txt']) {
    await projectPath(cwd, path.join(directory, name));
  }
  await writeFile(path.join(directory, 'prompt.md'), prompt, 'utf8');
  return directory;
}

export async function saveResult(directory, result, raw, metadata) {
  await Promise.all([
    writeFile(path.join(directory, 'raw.log'), `[stdout]\n${raw.stdout}\n[stderr]\n${raw.stderr}`, 'utf8'),
    writeFile(path.join(directory, 'stderr.log'), raw.stderr, 'utf8'),
    writeFile(path.join(directory, 'output.md'), result.text, 'utf8'),
    writeFile(path.join(directory, 'meta.json'), JSON.stringify({ ...metadata, ...result, text: undefined,
      ...(raw.pid ? { pid: raw.pid } : {}), ...(raw.treeKill ? { treeKill: raw.treeKill } : {}) }, null, 2), 'utf8'),
  ]);
  return result;
}

export function outcome(raw, text = '', parseError = null, extraQuota = false, toolError = false) {
  const quotaHit = quotaPattern.test(raw.stderr) || extraQuota;
  const authRequired = /not logged in|authentication required|please (?:run|use) \/login/i.test(`${raw.stderr}\n${text}`);
  const error = raw.error || parseError || (raw.timedOut ? '这一棒超时，请检查日志后重试。'
    : raw.interrupted ? '运行已中断。' : quotaHit ? '工具额度用完或受到限流，请稍后续跑。'
    : authRequired ? '工具尚未登录，请先在自己的终端中登录该工具，再重新运行。'
    : raw.exitCode !== 0 || toolError ? '工具执行失败，请查看 stderr.log 和 raw.log。'
    : !text.trim() ? '工具没有返回回答，请查看 raw.log。' : null);
  return { ok: !error, text, exitCode: raw.exitCode, durationMs: raw.durationMs,
    timedOut: raw.timedOut, quotaHit, error, ...(raw.interrupted ? { interrupted: true } : {}) };
}

export async function probeCommand(command) {
  const raw = await execute(command, ['--version'], { timeoutMs: 10_000 });
  return { installed: raw.exitCode === 0 && !raw.timedOut, version: raw.exitCode === 0 ? (raw.stdout || raw.stderr).trim() : null };
}

export function parseJsonResult(stdout) {
  // Do not scrape a result out of arbitrary process logs; invalid JSON is a failure.
  const data = JSON.parse(stdout.trim());
  if (typeof data.result !== 'string') throw new Error('JSON 输出缺少 result 回答字段，请核实工具版本。');
  return { text: data.result, quotaHit: Boolean(data.is_error && quotaPattern.test(JSON.stringify(data))), toolError: Boolean(data.is_error) };
}
