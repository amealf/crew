import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execute } from './adapters/process.js';
import { projectPath } from './paths.js';

const require = createRequire(import.meta.url);
const MAX_COMMAND_MS = 10 * 60 * 1000;

export function commandInvocation(command, platform = process.platform) {
  if (platform !== 'win32') return { command: '/bin/sh', args: ['-s'], prompt: `${command}\n` };
  // Only a fixed UTF-8 reader is passed as an argument. The configured command
  // goes through stdin, preserving Chinese, quotes, and multiline scripts.
  const reader = '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))';
  const prompt = `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n$global:LASTEXITCODE = 0\ntry {\n& {\n${command}\n}\n$commandSucceeded = $?\nif (-not $commandSucceeded) { exit 1 }\nexit $global:LASTEXITCODE\n} catch {\n[Console]::Error.WriteLine($_.ToString())\nexit 1\n}\n`;
  return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', reader], prompt };
}

function tail(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-200).join('\n');
}

async function loadPlaywright(cwd) {
  const projectRequire = createRequire(path.join(cwd, 'package.json'));
  try { return projectRequire('playwright'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require('playwright');
  }
}

async function targetUrl(cwd, value) {
  if (path.isAbsolute(value)) return pathToFileURL(await projectPath(cwd, value)).href;
  const url = new URL(value, pathToFileURL(`${path.resolve(cwd)}${path.sep}`));
  if (url.protocol === 'file:') {
    await projectPath(cwd, fileURLToPath(url));
    return url.href;
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('截图 URL 只支持项目内文件或 HTTP/HTTPS 地址。');
  return url.href;
}

function shotName(value, index) {
  let name;
  try { name = path.posix.basename(new URL(value, 'https://crew.invalid/').pathname); }
  catch { name = path.basename(value); }
  try { name = decodeURIComponent(name || 'page'); } catch { name ||= 'page'; }
  name = name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 70);
  return name || `page-${index + 1}`;
}

export async function runChecks({ cwd, checks = {}, runDir, round, signal, timeoutMs = MAX_COMMAND_MS, playwrightLoader = loadPlaywright }) {
  if (!Number.isInteger(round) || round < 1) throw new Error('检查轮次 round 必须是正整数。');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('检查 timeoutMs 必须是正数。');
  const directory = await projectPath(cwd, runDir);
  const checkDir = await projectPath(cwd, path.join(directory, 'checks'));
  const shotsDir = await projectPath(cwd, path.join(directory, 'shots'));
  await mkdir(checkDir, { recursive: true });
  const result = { passed: true, commands: [], screenshots: [] };
  for (const cmd of checks.commands ?? []) {
    if (signal?.aborted) {
      result.commands.push({ cmd, exitCode: null, durationMs: 0, outputTail: '运行已中断。', interrupted: true });
      break;
    }
    const invocation = commandInvocation(cmd);
    const raw = await execute(invocation.command, invocation.args, {
      cwd, prompt: invocation.prompt, signal, timeoutMs: Math.min(MAX_COMMAND_MS, timeoutMs),
    });
    const combined = [raw.stdout, raw.stderr, raw.error].filter(Boolean).join('\n');
    result.commands.push({ cmd, exitCode: raw.exitCode, durationMs: raw.durationMs, outputTail: tail(combined),
      ...(raw.timedOut ? { timedOut: true } : {}), ...(raw.interrupted ? { interrupted: true } : {}) });
    if (raw.interrupted) break;
  }
  result.passed = result.commands.every(command => command.exitCode === 0 && !command.timedOut && !command.interrupted);

  const configuredShots = checks.screenshots ?? [];
  if (configuredShots.length) {
    await mkdir(shotsDir, { recursive: true });
    let browser, loaderError;
    const closeBrowser = () => browser?.close().catch(() => {});
    const abort = () => { void closeBrowser(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      let playwright;
      if (!signal?.aborted) {
        try { playwright = await playwrightLoader(cwd); }
        catch (error) { loaderError = error; }
      }
      if (playwright && !signal?.aborted) {
        try { browser = await playwright.chromium.launch({ headless: true, timeout: Math.min(timeoutMs, 30_000) }); }
        catch (error) { loaderError = error; }
      }
      const usedNames = new Set();
      for (let index = 0; index < configuredShots.length; index++) {
        const item = configuredShots[index];
        let stem = `r${round}-${shotName(item.url, index)}-${item.width}`;
        if (usedNames.has(stem)) stem += `-${index + 1}`;
        usedNames.add(stem);
        const file = await projectPath(cwd, path.join(shotsDir, `${stem}.png`));
        const record = { path: path.relative(cwd, file).split(path.sep).join('/'), ok: false };
        if (signal?.aborted) {
          result.screenshots.push({ ...record, skipped: true, reason: '运行已中断。' });
          continue;
        }
        if (!browser) {
          const missing = loaderError?.code === 'MODULE_NOT_FOUND';
          result.screenshots.push({ ...record, ...(missing ? { skipped: true } : {}),
            reason: missing ? '未安装 Playwright，已跳过截图；需要时在项目中安装 playwright。' : `无法启动截图浏览器：${loaderError?.message ?? 'Playwright 未返回浏览器。'}` });
          continue;
        }
        let page;
        try {
          const url = await targetUrl(cwd, item.url);
          page = await browser.newPage({ viewport: { width: item.width, height: 900 } });
          await page.goto(url, { waitUntil: 'load', timeout: Math.min(timeoutMs, 30_000) });
          if (signal?.aborted) throw new Error('运行已中断。');
          await page.screenshot({ path: file, fullPage: true, timeout: Math.min(timeoutMs, 30_000) });
          result.screenshots.push({ ...record, ok: true });
        } catch (error) {
          result.screenshots.push({ ...record, reason: signal?.aborted ? '运行已中断。' : `截图失败：${error.message}` });
        } finally { await page?.close().catch(() => {}); }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      await closeBrowser();
    }
  }
  if (signal?.aborted) result.interrupted = true;
  const file = await projectPath(cwd, path.join(checkDir, `check-${round}.json`));
  await writeFile(file, JSON.stringify(result, null, 2), 'utf8');
  return result;
}
