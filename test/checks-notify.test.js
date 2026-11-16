import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runChecks, commandInvocation } from '../src/checks.js';
import { notify, notificationScript } from '../src/notify.js';
import { execute } from '../src/adapters/process.js';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, '.local', 'tests'), { recursive: true });
const area = await mkdtemp(path.join(root, '.local', 'tests', 'checks-'));
async function project(name) {
  const cwd = await mkdtemp(path.join(area, `${name}-`));
  await writeFile(path.join(cwd, 'emit.cjs'), `for (let n=1;n<=230;n++) console.log('line-'+n); console.log('中文输出');`, 'utf8');
  await writeFile(path.join(cwd, 'fail.cjs'), `console.error('failure output'); process.exit(7);`, 'utf8');
  await writeFile(path.join(cwd, 'wait.cjs'), `setInterval(()=>{},1000);`, 'utf8');
  await writeFile(path.join(cwd, 'ok.cjs'), `console.log('ok');`, 'utf8');
  return { cwd, runDir: path.join(cwd, '.crew', 'runs', 'test') };
}
const missingLoader = async () => { throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' }); };

test('命令依次执行，保留退出码与最后200行中文输出，并写JSON', async () => {
  const options = await project('commands');
  const result = await runChecks({ ...options, round: 1,
    checks: { commands: ['node emit.cjs', 'node fail.cjs', 'node ok.cjs'] } });
  assert.equal(result.passed, false);
  assert.deepEqual(result.commands.map(command => command.exitCode), [0, 7, 0]);
  const lines = result.commands[0].outputTail.split('\n');
  assert.equal(lines.length, 200);
  assert.equal(lines[0], 'line-32');
  assert.equal(lines.at(-1), '中文输出');
  assert.match(result.commands[1].outputTail, /failure output/);
  assert.deepEqual(JSON.parse(await readFile(path.join(options.runDir, 'checks', 'check-1.json'), 'utf8')), result);
});

test('命令超时和取消都能结束检查并保留结果', async () => {
  const options = await project('timeouts');
  const timedOut = await runChecks({ ...options, round: 2, timeoutMs: 500, checks: { commands: ['node wait.cjs'] } });
  assert.equal(timedOut.passed, false);
  assert.equal(timedOut.commands[0].timedOut, true);
  const controller = new AbortController();
  const pending = runChecks({ ...options, round: 3, signal: controller.signal, checks: { commands: ['node wait.cjs', 'node ok.cjs'] } });
  setTimeout(() => controller.abort(), 500);
  const canceled = await pending;
  assert.equal(canceled.interrupted, true);
  assert.equal(canceled.commands[0].interrupted, true);
  assert.equal(canceled.commands.length, 1);
});

test('PowerShell 只在参数里放固定读取器，配置命令通过stdin保留', () => {
  const command = 'Write-Output "中文"\nnode test.cjs';
  const invocation = commandInvocation(command, 'win32');
  assert.equal(invocation.command, 'powershell.exe');
  assert.ok(invocation.prompt.includes(command));
  assert.ok(!invocation.args.some(argument => argument.includes('中文')));
});

test('Playwright未安装时跳过截图，命令通过决定passed', async () => {
  const options = await project('missing-playwright');
  const result = await runChecks({ ...options, round: 1, playwrightLoader: missingLoader,
    checks: { commands: ['node ok.cjs'], screenshots: [{ url: 'index.html', width: 1280 }, { url: 'index.html', width: 390 }] } });
  assert.equal(result.passed, true);
  assert.equal(result.screenshots.length, 2);
  assert.ok(result.screenshots.every(shot => shot.skipped && !shot.ok && shot.reason.includes('未安装')));
});

function fakePlaywright({ failGoto = false, waitForAbort = false } = {}) {
  const state = { pages: [], closed: 0, launch: null };
  let interrupt;
  const browser = {
    async newPage(options) {
      const record = { options, closed: 0 };
      state.pages.push(record);
      return {
        async goto(url, options) {
          record.url = url; record.goto = options;
          if (failGoto) throw new Error('navigation failed');
          if (waitForAbort) await new Promise((resolve, reject) => { interrupt = () => reject(new Error('browser closed')); });
        },
        async screenshot(options) { record.shot = options; await writeFile(options.path, 'fake image', 'utf8'); },
        async close() { record.closed++; },
      };
    },
    async close() { state.closed++; interrupt?.(); },
  };
  return { state, loader: async () => ({ chromium: { async launch(options) { state.launch = options; return browser; } } }) };
}

test('截图按两种宽度打开本地文件并完整截图，重名加编号，浏览器最终关闭', async () => {
  const options = await project('shots');
  const fake = fakePlaywright();
  const result = await runChecks({ ...options, round: 4, playwrightLoader: fake.loader,
    checks: { screenshots: [{ url: 'index.html', width: 1280 }, { url: 'index.html', width: 390 }, { url: 'index.html', width: 390 }] } });
  assert.equal(result.passed, true);
  assert.ok(result.screenshots.every(shot => shot.ok));
  assert.deepEqual(fake.state.pages.map(page => page.options.viewport.width), [1280, 390, 390]);
  assert.ok(fake.state.pages.every(page => page.url.startsWith('file:') && page.goto.waitUntil === 'load' && page.shot.fullPage && page.closed === 1));
  assert.equal(new Set(result.screenshots.map(shot => shot.path)).size, 3);
  assert.ok(result.screenshots[0].path.endsWith('r4-index-1280.png'));
  assert.equal(fake.state.closed, 1);
});

test('截图导航失败、目录越界和取消都记录原因并关闭浏览器', async () => {
  const options = await project('shot-failure');
  const failed = fakePlaywright({ failGoto: true });
  const result = await runChecks({ ...options, round: 1, playwrightLoader: failed.loader,
    checks: { screenshots: [{ url: 'https://example.invalid/', width: 390 }, { url: '../outside.html', width: 390 }] } });
  assert.equal(result.passed, true);
  assert.match(result.screenshots[0].reason, /navigation failed/);
  assert.match(result.screenshots[1].reason, /项目目录内/);
  assert.equal(failed.state.closed, 1);
  const canceled = fakePlaywright({ waitForAbort: true });
  const controller = new AbortController();
  const pending = runChecks({ ...options, round: 2, signal: controller.signal, playwrightLoader: canceled.loader,
    checks: { screenshots: [{ url: 'index.html', width: 390 }] } });
  setTimeout(() => controller.abort(), 100);
  const aborted = await pending;
  assert.equal(aborted.interrupted, true);
  assert.match(aborted.screenshots[0].reason, /中断/);
  assert.ok(canceled.state.closed >= 1);
});

test('通知内容以Base64 XML传入，失败安全返回，非Windows跳过', async () => {
  const task = `task '<>&\n$([malicious])`;
  const script = notificationScript({ task, status: 'approved' });
  const payload = script.match(/FromBase64String\('([^']+)'\)/)[1];
  const xml = Buffer.from(payload, 'base64').toString('utf8');
  assert.ok(xml.includes('&lt;&gt;&amp;'));
  assert.ok(xml.includes('approved'));
  assert.ok(!script.includes(task));
  assert.ok(script.includes("CreateToastNotifier('Microsoft.WindowsTerminal_8wekyb3d8bbwe!App')"));
  assert.ok(script.includes('$notifier.get_Setting()'));
  assert.ok(!script.includes('$notifier.Setting.ToString()'));
  const calls = [];
  const good = await notify({ cwd: area, task, status: 'stopped', platform: 'win32', executeCommand: async (...args) => {
    calls.push(args); return { exitCode: 0, stderr: '', timedOut: false };
  } });
  assert.equal(good.ok, true);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.ok(calls[0][2].prompt.includes('CreateToastNotifier'));
  assert.ok(!calls[0][1].some(argument => argument.includes(task)));
  const failed = await notify({ cwd: area, task, status: 'stopped', platform: 'win32', executeCommand: async () => { throw new Error('unavailable'); } });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /unavailable/);
  const skipped = await notify({ cwd: area, task, status: 'stopped', platform: 'linux' });
  assert.equal(skipped.skipped, true);
});

test('通知的PowerShell错误以UTF-8返回中文', { skip: process.platform !== 'win32' }, async () => {
  const result = await notify({ cwd: area, task: '编码检查', status: 'stopped',
    executeCommand: (command, args, options) => execute(command, args, { ...options, prompt: "throw '通知中文错误';" }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('通知中文错误'), result.error);
});
