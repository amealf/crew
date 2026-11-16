import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, readFile, access, symlink } from 'node:fs/promises';
import { getAdapter } from '../src/adapters/index.js';
import { execute, outcome } from '../src/adapters/process.js';
import { projectPath } from '../src/paths.js';
import { main, doctor } from '../src/cli.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
await mkdir(path.join(root, '.local', 'tests'), { recursive: true });
const area = await mkdtemp(path.join(root, '.local', 'tests', 'adapters-'));
const fakeBin = path.join(area, 'fake-bin');
await mkdir(fakeBin);
const fixture = fileURLToPath(new URL('fixtures/worker.cjs', import.meta.url));
for (const tool of ['claude', 'codex', 'agy']) {
  const launcher = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture}" ${tool} %*\r\n`
    : `#!/usr/bin/env node\nprocess.argv.splice(2,0,${JSON.stringify(tool)});await import(${JSON.stringify(new URL('fixtures/worker.cjs', import.meta.url).href)});\n`;
  await writeFile(path.join(fakeBin, tool + (process.platform === 'win32' ? '.cmd' : '')), launcher, { encoding: 'utf8', mode: 0o755 });
}

async function withFakeWorkers(fn) {
  const previousPath = process.env.PATH;
  const previousBehavior = process.env.CREW_TEST_BEHAVIOR;
  const previousCore = process.env.CODEX_WINDOWS_REGISTERED_CORE;
  const previousPackage = process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  process.env.CODEX_WINDOWS_REGISTERED_CORE = '1';
  process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY = 'fixture-desktop-package';
  try { await fn(); }
  finally {
    process.env.PATH = previousPath;
    if (previousBehavior === undefined) delete process.env.CREW_TEST_BEHAVIOR;
    else process.env.CREW_TEST_BEHAVIOR = previousBehavior;
    if (previousCore === undefined) delete process.env.CODEX_WINDOWS_REGISTERED_CORE;
    else process.env.CODEX_WINDOWS_REGISTERED_CORE = previousCore;
    if (previousPackage === undefined) delete process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY;
    else process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY = previousPackage;
  }
}

test('真实适配器通过假 CLI 接收中文 stdin，隔离过程输出，并保存日志', async () => {
  await withFakeWorkers(async () => {
    const prompt = '中文第一行\nSecond line: "quotes" & shell $ characters';
    for (const tool of ['claude', 'codex', 'agy']) {
      const cwd = await mkdtemp(path.join(area, `${tool}-`));
      const adapter = getAdapter(tool);
      assert.equal((await adapter.probe()).installed, true);
      const result = await adapter.run({ prompt, model: 'fixture-model', mode: 'read', cwd, stepDir: 'step', timeoutMs: 5000 });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.text, 'CREW_OK 中文正常');
      const input = JSON.parse(await readFile(path.join(cwd, `${tool}-input.json`), 'utf8'));
      assert.equal(tool === 'agy' ? JSON.parse(input.input).message.content : input.input, prompt);
      assert.ok(!input.args.some(arg => arg.includes('中文第一行')));
      assert.ok(input.args.includes('fixture-model'));
      if (tool === 'claude') { assert.ok(input.args.includes('dontAsk')); assert.ok(!input.args.includes('Read,Grep,Glob,Edit,Write,Bash')); }
      if (tool === 'codex') {
        assert.ok(input.args.includes('read-only'));
        assert.equal(input.registeredCore, null);
        assert.equal(input.sandboxPackage, null);
        assert.equal(process.env.CODEX_WINDOWS_REGISTERED_CORE, '1');
        assert.equal(process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY, 'fixture-desktop-package');
      }
      if (tool === 'agy') { assert.ok(input.args.includes('plan')); assert.ok(input.args.includes('--sandbox')); }
      assert.equal(await readFile(path.join(cwd, 'step', 'prompt.md'), 'utf8'), prompt);
      for (const name of ['raw.log', 'stderr.log', 'output.md', 'meta.json']) await access(path.join(cwd, 'step', name));
      const writeResult = await adapter.run({ prompt: 'write fixture', mode: 'write', cwd, stepDir: 'write-step', timeoutMs: 5000 });
      assert.equal(writeResult.ok, true);
      const writeInput = JSON.parse(await readFile(path.join(cwd, `${tool}-input.json`), 'utf8'));
      assert.ok(writeInput.args.includes({ claude: 'acceptEdits', codex: 'workspace-write', agy: 'auto' }[tool]));
      if (tool === 'agy') assert.ok(writeInput.args.includes('--sandbox'));
      assert.ok(!writeInput.args.some(arg => /dangerously|bypass/.test(arg)));
    }
  });
});

test('工具失败、空回答、非法 JSON、JSON 中的额度错误均作为失败返回', async () => {
  await withFakeWorkers(async () => {
    for (const tool of ['claude', 'codex', 'agy']) {
      const cwd = await mkdtemp(path.join(area, 'failure-'));
      const adapter = getAdapter(tool);
      for (const behavior of [{ exitCode: 1 }, { empty: true }, { stderr: 'RATE LIMIT' }]) {
        process.env.CREW_TEST_BEHAVIOR = JSON.stringify(behavior);
        const result = await adapter.run({ prompt: 'test', mode: 'read', cwd, stepDir: 'step', timeoutMs: 5000 });
        assert.equal(result.ok, false);
        assert.equal(result.quotaHit, Boolean(behavior.stderr));
        if (behavior.empty) assert.equal(result.text, ''); // A previous Codex answer must not be reused.
      }
      if (tool !== 'codex') {
        process.env.CREW_TEST_BEHAVIOR = JSON.stringify({ invalid: true });
        assert.equal((await adapter.run({ prompt: 'test', mode: 'read', cwd, stepDir: 'invalid', timeoutMs: 5000 })).ok, false);
        process.env.CREW_TEST_BEHAVIOR = JSON.stringify({ toolError: true, text: 'usage limit reached' });
        const quota = await adapter.run({ prompt: 'test', mode: 'read', cwd, stepDir: 'quota', timeoutMs: 5000 });
        assert.equal(quota.ok, false);
        assert.equal(quota.quotaHit, true);
      }
    }
  });
});

test('进程启动失败与取消得到结构化结果', async () => {
  const missing = await execute('crew-command-that-does-not-exist', [], { cwd: area, timeoutMs: 5000 });
  assert.match(missing.error, /PATH/);
  const controller = new AbortController();
  const run = execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: area, timeoutMs: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  const canceled = await run;
  assert.equal(canceled.interrupted, true);
  assert.equal(outcome(canceled).ok, false);
});

test('遥测事件名称不误判成额度耗尽，实际额度错误仍识别', () => {
  const raw = { stderr: 'expected events: codex_usage_limit_banner_shown, codex_rate_limit_reset_modal_shown',
    exitCode: 0, durationMs: 1, timedOut: false };
  assert.equal(outcome(raw, '实现完成').ok, true);
  for (const error of ['Rate limit reached', 'usage limit exceeded', 'quota exceeded', 'rate_limit_exceeded']) {
    assert.equal(outcome({ ...raw, stderr: error }, '').quotaHit, true);
  }
});

test('超时终止父进程和子进程', async () => {
  const cwd = await mkdtemp(path.join(area, 'timeout-'));
  const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);`;
  const result = await execute(process.execPath, ['-e', script], { cwd, timeoutMs: 1500 });
  assert.equal(result.timedOut, true);
  if (process.platform === 'win32') {
    assert.equal(result.treeKill.exitCode, 0);
    assert.deepEqual(result.treeKill.remainingPids, []);
    assert.ok(result.treeKill.pids.length >= 2);
  }
  for (const pid of JSON.parse(await readFile(path.join(cwd, 'pids.json'), 'utf8'))) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});

test('路径检查拒绝目录穿越与指向项目外的链接', async () => {
  const cwd = await mkdtemp(path.join(area, 'paths-'));
  const external = await mkdtemp(path.join(area, 'outside-'));
  await assert.rejects(projectPath(cwd, '../outside/file.txt'), /项目目录内/);
  await symlink(external, path.join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(projectPath(cwd, 'link/file.txt'), /项目外/);
  await symlink(path.join(external, 'missing-directory'), path.join(cwd, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(projectPath(cwd, 'dangling/file.txt'), /符号链接/);
  await assert.rejects(getAdapter('mock').run({ cwd, mode: 'write', prompt: 'x', stepDir: '../bad', timeoutMs: 5000 }), /项目目录内/);
  assert.throws(() => getAdapter('constructor'), /未知工具/);
});

test('mock 按顺序取回答、拒绝只读写入，并能跨进程恢复游标', async () => {
  const cwd = await mkdtemp(path.join(area, 'mock-'));
  const script = path.join(cwd, 'script.json');
  await writeFile(script, JSON.stringify([
    { text: '实现完成', files: { 'src/hello.txt': '中文内容' } },
    { text: '只读', files: { 'forbidden.txt': 'bad' } },
    { text: '超时', timedOut: true },
    { text: '额度', quotaHit: true },
    { text: '恢复成功' },
  ]), 'utf8');
  const original = process.env.CREW_MOCK_SCRIPT;
  process.env.CREW_MOCK_SCRIPT = script;
  try {
    const mock = getAdapter('mock');
    const run = mode => mock.run({ prompt: 'test', mode, cwd, stepDir: 'step', timeoutMs: 5000 });
    assert.equal((await run('write')).ok, true);
    assert.equal(await readFile(path.join(cwd, 'src/hello.txt'), 'utf8'), '中文内容');
    assert.equal((await run('read')).ok, false);
    await assert.rejects(access(path.join(cwd, 'forbidden.txt')));
    assert.equal((await run('read')).timedOut, true);
    assert.equal((await run('read')).quotaHit, true);
    const invocation = `import {run} from ${JSON.stringify(new URL('../src/adapters/mock.js', import.meta.url).href)}; const r=await run({prompt:'next',mode:'read',cwd:process.cwd(),stepDir:'next',timeoutMs:5000}); console.log(r.text);`;
    const recovered = await execute(process.execPath, ['--input-type=module', '-e', invocation], { cwd, timeoutMs: 5000 });
    assert.equal(recovered.stdout.trim(), '恢复成功');
    await assert.rejects(run('read'), /第 6 条/);
  } finally {
    if (original === undefined) delete process.env.CREW_MOCK_SCRIPT; else process.env.CREW_MOCK_SCRIPT = original;
  }
});

test('doctor --live 用假 CLI 完整走通，命令行拒绝未知选项', async () => {
  await withFakeWorkers(async () => {
    process.env.CREW_TEST_BEHAVIOR = '{}';
    const cwd = await mkdtemp(path.join(area, 'doctor-'));
    const lines = [];
    const result = await doctor({ cwd, live: true, log: line => lines.push(line) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.tools.length, 3);
    assert.equal(lines.filter(line => line.includes('已拿回中文回答')).length, 3);
  });
  await assert.rejects(main(['doctor', '--unknown']), /参数错误/);
  await assert.rejects(main(['unknown-command']), /未知命令/);
});
