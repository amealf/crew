// Explicit real-model acceptance run; never imported by npm test.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { execute } from '../src/adapters/process.js';
import { runTask } from '../src/engine.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const viaAgy = process.argv.slice(2).includes('--claude-via-agy');
if (process.argv.slice(2).some(arg => arg !== '--claude-via-agy')) throw new Error('用法：npm run verify:pilot -- [--claude-via-agy]');
const parent = path.join(root, '.local', 'pilots');
await mkdir(parent, { recursive: true });
const cwd = await mkdtemp(path.join(parent, 'pomodoro-'));
await mkdir(path.join(cwd, '.crew', 'tasks'), { recursive: true });
await writeFile(path.join(cwd, '.gitignore'), '.crew/runs/\nnode_modules/\n', 'utf8');
await writeFile(path.join(cwd, 'DECISIONS.md'), '', 'utf8');
const sheet = {
  goal: `做一个番茄钟网页，只用于验证调度器。
- 双击 index.html 就能运行，纯 HTML、CSS、JavaScript，不用框架和构建工具。
- 25 分钟专注、5 分钟休息，每完成 4 个专注后休息 15 分钟。
- 开始、暂停、重置按钮，显示分:秒和当前阶段。
- 今天完成的专注次数刷新后保留，跨日重新统计。
- 阶段结束自动进入下一阶段，并改变页面标题提醒。
- 用系统时间计算剩余时间，暂停再开始不跳变，切到后台也保持准确。
- timer.js 单独实现计时逻辑，不操作页面元素，node --test 覆盖阶段切换、第4次专注后长休息、暂停恢复和重置。
- 本地 file: 页面能加载脚本，不依赖 HTTP 服务器；选一个浏览器普通 script 与 Node 测试均可使用的模块写法。
- 页面布局只需清晰可读，390 像素宽时没有横向溢出、按钮重叠或截断。`,
  roles: { designer: { tool: 'codex', model: 'gpt-6-astra' },
    builder: viaAgy ? { tool: 'agy', model: 'claude-sonnet-5-5-medium' } : { tool: 'claude', model: 'claude-sonnet-4-6' },
    reviewer: { tool: 'agy', model: 'gemini-4-argon-medium' } },
  flow: ['design', { loop: ['build', 'check', 'review'] }],
  checks: { commands: ['node --test'], screenshots: [{ url: 'index.html', width: 1280 }, { url: 'index.html', width: 390 }] },
  review_checklist: ['node --test 通过并覆盖阶段切换、第4个专注后长休息、暂停恢复和重置',
    '计时按系统时间计算，暂停恢复和后台切换不改变正确的剩余时间', '双击 index.html 可用，今天次数刷新保留并跨日重置',
    '截图中390像素下没有横向滚动、按钮重叠或截断，能看清当前专注或休息阶段'],
  stop_when: { max_hours: 1, max_rounds: 4, step_timeout_minutes: 12, stall_rounds: 2 },
  human_review: false,
};
const taskPath = path.join(cwd, '.crew', 'tasks', 'pomodoro.yaml');
await writeFile(taskPath, stringify(sheet), 'utf8');
for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Crew Acceptance'],
  ['config', 'user.email', 'crew-acceptance@example.invalid'], ['config', 'core.autocrlf', 'false'],
  ['add', '-A'], ['commit', '-m', 'initial pilot specification']]) {
  const result = await execute('git', args, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, '.local', 'browsers');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
console.log(`试点目录：${cwd}`);
let injected = false;
const result = await runTask({ cwd, taskName: 'pomodoro', taskPath, signal: controller.signal,
  onStep: async ({ step, round, phase, state, runDir }) => {
    if (injected || step !== 'build' || round !== 1 || phase !== 'end') return;
    const metadata = JSON.parse(await readFile(path.join(state.inFlight.stepDir, 'meta.json'), 'utf8'));
    if (!metadata.ok) return;
    const page = path.join(cwd, 'index.html');
    const html = await readFile(page, 'utf8');
    await writeFile(page, `${html}\n<!-- CREW_VISUAL_REGRESSION_PROBE: first-round acceptance fault -->\n<style>@media(max-width:500px){body{min-width:780px!important}button{min-width:260px!important}}</style>\n`, 'utf8');
    await writeFile(path.join(runDir, 'visual-regression-probe.json'), JSON.stringify({ injectedAt: new Date().toISOString(), round: 1, kind: 'mobile-width-overflow', viewport: 390 }, null, 2), 'utf8');
    injected = true;
    console.log('已注入首轮窄屏布局问题，验证真实审阅退回与修复循环。');
  },
});
const hasRevision = result.state.rounds.some(round => round.verdict === 'REVISE');
const verifiedLoop = result.state.status === 'approved' && hasRevision && injected;
await writeFile(path.join(cwd, '.crew', 'runs', 'pilot-result.json'), JSON.stringify({
  cwd, runDir: result.runDir, runId: result.state.runId, status: result.state.status, stopReason: result.state.stopReason,
  roles: sheet.roles, injectedVisualRegression: injected, hasRevision, verifiedLoop,
  rounds: result.state.rounds.map(({ n, verdict, modelVerdict, checksPassed, screenshots }) => ({ n, verdict, modelVerdict, checksPassed, screenshots })),
}, null, 2), 'utf8');
process.exitCode = result.exitCode || (verifiedLoop ? 0 : 2);
