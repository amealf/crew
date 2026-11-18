import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { projectPath } from '../paths.js';
import { prepareStep, saveResult } from './process.js';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireIpcLock, atomicJson } from '../runlog.js';

async function takeEntry({ cwd, model, signal, timeoutMs }, scriptPath, script, started) {
  const arrayScript = Array.isArray(script);
  const key = model ?? '';
  const entries = arrayScript ? script : script && Object.hasOwn(script, key) ? script[key] : null;
  if (!Array.isArray(entries)) throw new Error(`CREW_MOCK_SCRIPT 缺少型号「${key}」的回答数组。`);
  const cursorPath = await projectPath(cwd, `${scriptPath}.cursor.json`);
  let release;
  while (!release) {
    if (signal?.aborted) return { interrupted: true };
    if (performance.now() - started >= timeoutMs) return { timedOut: true };
    try { release = await acquireIpcLock(cwd, `mock:${cursorPath}`, 'mock 游标正在更新。'); }
    catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      try { await delay(10, undefined, { signal }); }
      catch (error) { if (signal?.aborted) return { interrupted: true }; throw error; }
    }
  }
  try {
    if (signal?.aborted) return { interrupted: true };
    let cursor = {};
    try { cursor = JSON.parse(await readFile(cursorPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const indices = cursor.indices ?? {};
    const index = arrayScript ? cursor.index ?? 0 : Object.hasOwn(indices, key) ? indices[key] : 0;
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('mock 游标无效，请检查脚本旁的 cursor.json。');
    const entry = entries[index];
    if (!entry || typeof entry !== 'object') throw new Error(`mock 脚本第 ${index + 1} 条回答不存在，请补充脚本。`);
    await atomicJson(cursorPath, arrayScript ? { index: index + 1 } : { indices: { ...indices, [key]: index + 1 } });
    return { entry, index };
  } finally { await release(); }
}

export async function run(options) {
  const settings = { timeoutMs: 3_600_000, ...options };
  const started = performance.now();
  const directory = await prepareStep(settings);
  if (!process.env.CREW_MOCK_SCRIPT) throw new Error('请把 CREW_MOCK_SCRIPT 设为项目内的 JSON 脚本路径。');
  const scriptPath = await projectPath(settings.cwd, process.env.CREW_MOCK_SCRIPT);
  const script = JSON.parse(await readFile(scriptPath, 'utf8'));
  const { entry, index, interrupted: cursorInterrupted, timedOut: cursorTimedOut } = await takeEntry(settings, scriptPath, script, started);
  if (!entry) {
    return saveResult(directory, {
      ok: false, text: '', exitCode: 1, durationMs: Math.round(performance.now() - started),
      timedOut: Boolean(cursorTimedOut), quotaHit: false,
      error: cursorInterrupted ? '运行已中断。' : '等待 mock 游标超时。',
      ...(cursorInterrupted ? { interrupted: true } : {}),
    }, { stdout: '', stderr: '' }, { tool: 'mock', model: settings.model ?? null, mode: settings.mode });
  }
  let error = null;
  const writes = Object.entries(entry.files ?? {});
  if (writes.length && settings.mode !== 'write') error = '只读工人不能写入文件。';
  const targets = [];
  if (!error) for (const [name, content] of writes) {
    if (typeof content !== 'string') throw new Error(`mock files.${name} 必须是文字。`);
    targets.push([await projectPath(settings.cwd, name), content]);
  }
  for (const [target, content] of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  let timedOut = Boolean(entry.timedOut), interrupted = Boolean(settings.signal?.aborted);
  const quotaHit = Boolean(entry.quotaHit);
  if (entry.delayMs !== undefined && (!Number.isFinite(entry.delayMs) || entry.delayMs < 0)) throw new Error('mock delayMs 必须是非负毫秒数。');
  const remainingMs = Math.max(0, settings.timeoutMs - (performance.now() - started));
  timedOut ||= remainingMs === 0;
  if (entry.delayMs > 0 && !interrupted && !timedOut && !quotaHit) {
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); settings.signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { interrupted = true; done(); };
      const timer = setTimeout(() => { if (entry.delayMs > remainingMs) timedOut = true; done(); }, Math.min(entry.delayMs, remainingMs));
      settings.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  const text = entry.text ?? '';
  if (typeof text !== 'string') throw new Error('mock text 必须是文字。');
  const exitCode = entry.exitCode ?? (timedOut || interrupted || quotaHit || error ? 1 : 0);
  error ||= entry.error || (interrupted ? '运行已中断。' : timedOut ? '这一棒超时。' : quotaHit ? '额度用完。' : exitCode !== 0 ? '工具执行失败。' : !text.trim() ? '工具没有返回回答。' : null);
  const result = { ok: !error, text, exitCode, durationMs: Math.round(performance.now() - started), timedOut, quotaHit, error, ...(interrupted ? { interrupted: true } : {}) };
  return saveResult(directory, result, { stdout: JSON.stringify(entry), stderr: entry.stderr ?? '' },
    { tool: 'mock', model: settings.model ?? null, mode: settings.mode, scriptIndex: index });
}

export async function probe() { return { installed: true, version: 'mock/1' }; }
