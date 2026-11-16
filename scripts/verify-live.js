// Explicitly invoked only. npm test never starts a real model.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, access } from 'node:fs/promises';
import { getAdapter } from '../src/adapters/index.js';
import { execute } from '../src/adapters/process.js';

const args = process.argv.slice(2);
const tool = args[0];
if (!['claude', 'codex', 'agy'].includes(tool) || (args.length > 1 && (args[1] !== '--model' || args.length !== 3))) {
  console.error('用法：npm run verify:live -- <claude|codex|agy> [--model <型号>]');
  process.exit(1);
}
const model = args[2];
const root = fileURLToPath(new URL('..', import.meta.url));
const parent = path.join(root, '.local', 'live-tests');
await mkdir(parent, { recursive: true });
const cwd = await mkdtemp(path.join(parent, `${tool}-`));
await execute('git', ['init'], { cwd, timeoutMs: 10_000 });
await copyFile(new URL('../test/fixtures/vision.png', import.meta.url), path.join(cwd, 'vision.png'));
const adapter = getAdapter(tool);
const checks = [];
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

async function call(name, mode, prompt, timeoutMs = 120_000) {
  console.log(`${tool} · ${name} 开始`);
  const result = await adapter.run({ cwd, model, mode, prompt, timeoutMs, stepDir: path.join(cwd, '.crew', 'runs', name), signal: controller.signal });
  console.log(`${tool} · ${name} ${result.ok ? '完成' : result.error}`);
  return result;
}
async function exists(name) { try { await access(path.join(cwd, name)); return true; } catch { return false; } }

const connection = await call('connection', 'read', '连接测试。\n请只回答：CREW_OK 中文正常\n不要调用任何工具。');
checks.push({ name: '中文和换行输入', passed: connection.ok && connection.text.includes('CREW_OK 中文正常'), result: connection });
if (connection.ok) {
  const readonly = await call('read-only', 'read', '权限测试：请用文件写入工具在当前项目根目录新建 readonly-probe.txt，内容为 CREW_WRITE。请实际尝试写入，权限拒绝就报告拒绝。只处理这个项目目录内的文件。');
  const readRaw = await readFile(path.join(cwd, '.crew', 'runs', 'read-only', 'raw.log'), 'utf8');
  const refusal = /只读|read.only|拒绝|denied/i.test(readonly.text) || /"denied_actions"|permission check failed|sandbox violation/.test(readRaw);
  checks.push({ name: '只读模式拒绝写入', passed: readonly.exitCode === 0 && !readonly.timedOut && refusal && !await exists('readonly-probe.txt'), result: readonly });
  if (checks.at(-1).passed) {
    const write = await call('write', 'write', '权限测试：请用文件写入工具在当前项目根目录新建 write-probe.txt，内容为 CREW_WRITE。不要改其他文件，不要运行命令或创建计划，完成后回答 DONE。');
    checks.push({ name: '可写模式创建文件', passed: write.ok && await exists('write-probe.txt') && (await readFile(path.join(cwd, 'write-probe.txt'), 'utf8')).trim() === 'CREW_WRITE', result: write });
    const image = await call('image', 'read', '请用图片读取工具打开当前目录的 vision.png。它是两个彩色图形。请回答左边图形的颜色和形状，右边图形的颜色和形状。不要只读取字节，不要修改文件。');
    checks.push({ name: '只读模式读取图片', passed: image.ok && /red|红/i.test(image.text) && /blue|蓝/i.test(image.text) && /square|rectangle|方|矩形/i.test(image.text) && /circle|圆/i.test(image.text), result: image });
    const timeout = await call('timeout', 'write', '长任务超时测试：请运行一个等待 90 秒的命令（Windows PowerShell Start-Sleep -Seconds 90），等命令完成再回答 DONE。不要修改任何文件。', 5000);
    const meta = JSON.parse(await readFile(path.join(cwd, '.crew', 'runs', 'timeout', 'meta.json'), 'utf8'));
    const clean = meta.treeKill?.exitCode === 0 && (process.platform !== 'win32' || meta.treeKill.remainingPids.length === 0);
    checks.push({ name: '五秒超时', passed: timeout.timedOut && timeout.durationMs < 15_000 && clean, result: timeout, treeKill: meta.treeKill });
  }
}
await writeFile(path.join(cwd, 'verification.json'), JSON.stringify({ tool, model: model ?? null, checkedAt: new Date().toISOString(), cwd, checks }, null, 2), 'utf8');
for (const check of checks) console.log(`${check.passed ? '✓' : '✗'} ${check.name}`);
console.log(`记录：${path.join(cwd, 'verification.json')}`);
process.exitCode = checks.length === 5 && checks.every(check => check.passed) ? 0 : 1;
