import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getAdapter } from './adapters/index.js';
import { execute } from './adapters/process.js';
import { projectPath } from './paths.js';
import { loadTaskSheet } from './tasksheet.js';
import { loadRun } from './runlog.js';
import { runTask, resumeRun, promptContext, duration } from './engine.js';
import { renderPrompt } from './prompts.js';
import { meetingExample } from './meeting-config.js';
import { meetingCommands, meetingMain } from './meeting-cli.js';

const require = createRequire(import.meta.url);
const help = `crew 命令行调度器

用法：
  crew init                         创建任务目录和示例任务单
  crew doctor         检查 Node、git、三个工人和可选的 Playwright
  crew doctor --live  另发测试提示词，验证能否拿回回答（会消耗额度）
  crew validate <任务名>            校验并显示完整任务单
  crew run <任务名> [--dry-run]      开始运行，或预览步骤和首棒提示词
  crew status [运行编号]            查看最近一次或指定运行
  crew approve [运行编号]           批准设计或确认当前审阅结论并继续
  crew revise [运行编号] --note "人工修改意见"  退回当前审阅，进入下一轮修改
  crew resume [运行编号] [--extend-hours 12]  续跑停止或异常中断的运行
  crew ask ["问题"] [--file 路径] [--with 工具:型号,...] [--no-summary]
  crew ask "追问" [--meeting 会审编号] [--to 参会者]
  crew ask --retry [会审编号]         补跑最近一轮未完成或失败的回答
  crew summarize [会审编号] [--by 工具:型号]  为最近一轮重新总结
  crew decide [会审编号] (--adopt 参会者 | --text "决定") [--title "标题"] [--yes]
  crew meetings                      列出会审
  crew meeting [会审编号] [--json]    查看问答、总结和决议

请在项目的 git 仓库根目录运行。运行记录保存在 .crew/runs/，会审记录保存在 .crew/meetings/。`;

const example = `# 一个最小任务单。保存后把目标和检查命令换成项目实际要求。
goal: |
  按项目现有结构完成一个小功能，并补充必要测试。
roles:
  designer: { tool: claude }
  builder: { tool: codex }
  reviewer: { tool: claude }
flow:
  - design
  # 如果要先看设计，再手动批准，取消下一行的注释。
  # - approve
  - loop: [build, check, review]
# true 表示每轮模型审阅后等待人工确认；false 保持全自动。
human_review: false
checks:
  commands: ["node --test"]
  # screenshots:
  #   - { url: "index.html", width: 1280 }
  #   - { url: "index.html", width: 390 }
review_checklist:
  - 功能符合目标，必要测试通过
stop_when:
  max_hours: 24
  max_rounds: null
  step_timeout_minutes: 60
  stall_rounds: 2
`;

export async function initProject(cwd, log = console.log) {
  for (const directory of ['.crew/tasks', '.crew/prompts']) {
    await mkdir(await projectPath(cwd, directory), { recursive: true });
  }
  const examplePath = await projectPath(cwd, '.crew/tasks/example.yaml');
  try { await writeFile(examplePath, example, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const meetingPath = await projectPath(cwd, '.crew/meeting.yaml');
  try { await writeFile(meetingPath, meetingExample, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const ignorePath = await projectPath(cwd, '.gitignore');
  let ignore = '';
  try { ignore = await readFile(ignorePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rules = ignore.split(/\r?\n/).map(line => line.trim().replace(/^\//, ''));
  const missing = ['.crew/runs/', '.crew/meetings/'].filter(rule => !rules.includes(rule));
  if (missing.length) {
    await writeFile(ignorePath, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, 'utf8');
  }
  log(`任务目录已准备好：${examplePath}\n编辑任务单并提交项目改动后，运行 crew run example。`);
}

async function taskFile(cwd, name) {
  if (!/^[\p{L}\p{N}_.-]+$/u.test(name ?? '') || ['.', '..'].includes(name)) throw new Error('请提供任务名，例如 crew run example；任务名不能包含目录。');
  return projectPath(cwd, path.join('.crew', 'tasks', `${name}.yaml`));
}

async function dryRun(cwd, name, log) {
  const taskPath = await taskFile(cwd, name);
  const sheet = await loadTaskSheet(taskPath, { warn: log });
  const steps = sheet.flow.map(step => typeof step === 'string' ? step : `循环（${step.loop.join(' → ')}）`).join(' → ');
  log(`任务：${name}\n目标：${sheet.goal}\n步骤：${steps} → report`);
  const first = sheet.flow.find(step => step !== 'approve');
  const role = first === 'design' ? 'designer' : 'builder';
  const state = { round: 1, rounds: [] };
  const runDir = await projectPath(cwd, '.crew/runs/<运行编号>');
  const context = await promptContext({ cwd, sheet, state, runDir });
  log(`\n首棒：${role}（${sheet.roles[role].tool}）\n\n${await renderPrompt(role, context)}`);
  if (context.decisions) log(`\n提示词引用的 DECISIONS.md\n\n${await readFile(context.decisions, 'utf8')}`);
}

function runOptions(args, allowExtend) {
  let runId, extendHours = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (allowExtend && arg === '--extend-hours' && !extendHours) {
      extendHours = Number(args[++i]);
      if (!Number.isFinite(extendHours) || extendHours <= 0) throw new Error('--extend-hours 后面需要大于 0 的小时数，例如 --extend-hours 12。');
    } else if (!arg.startsWith('-') && !runId) runId = arg;
    else throw new Error(`参数「${arg}」无效，请运行 crew --help。`);
  }
  return { runId, extendHours };
}

function reviseOptions(args) {
  let runId, note;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--note' && note === undefined) {
      note = args[++index];
      if (typeof note !== 'string' || !note.trim()) throw new Error('请提供人工修改意见，例如 crew revise --note "请修复暂停后剩余时间跳变的问题"。');
    } else if (!argument.startsWith('-') && !runId) runId = argument;
    else throw new Error(`参数「${argument}」无效，请使用 crew revise [运行编号] --note "人工修改意见"。`);
  }
  if (note === undefined) throw new Error('crew revise 需要 --note "人工修改意见"，例如 crew revise --note "请补充边界情况测试"。');
  return { runId, revise: note };
}

export async function doctor({ live = false, cwd = process.cwd(), log = console.log, signal } = {}) {
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
  log(`${nodeOk ? '✓' : '✗'} Node.js ${process.version}${nodeOk ? '' : '；请安装 Node.js 20 以上版本。'}`);
  const git = await execute('git', ['--version'], { cwd, timeoutMs: 10_000, signal });
  log(`${git.exitCode === 0 ? '✓' : '✗'} git ${git.exitCode === 0 ? git.stdout.trim() : '未找到；请安装 git 并加入 PATH。'}`);
  let playwright = false;
  try { require.resolve('playwright', { paths: [cwd, path.dirname(fileURLToPath(import.meta.url))] }); playwright = true; } catch { /* optional */ }
  log(`${playwright ? '✓' : '○'} Playwright ${playwright ? '可用' : '未安装；截图功能可选，需要时在项目中安装 playwright。'}`);
  let failed = !nodeOk || git.exitCode !== 0;
  const tools = [];
  const runDir = path.join(cwd, '.crew', 'runs', `doctor-${Date.now()}`);
  for (const tool of ['claude', 'codex', 'agy']) {
    if (signal?.aborted) break;
    const adapter = getAdapter(tool);
    const probe = await adapter.probe();
    log(`${probe.installed ? '✓' : '✗'} ${tool} ${probe.version ?? '未找到；请安装工具并加入 PATH。'}`);
    failed ||= !probe.installed;
    let result;
    if (live && probe.installed && !signal?.aborted) {
      log(`  ${tool} 连接测试开始……`);
      result = await adapter.run({ prompt: '连接测试。\n请只回答：CREW_OK 中文正常\n不要调用工具，不要修改任何文件。', mode: 'read', cwd,
        timeoutMs: 120_000, stepDir: path.join(runDir, tool), signal });
      const valid = result.ok && result.text.includes('CREW_OK') && result.text.includes('中文正常');
      failed ||= !valid;
      log(`  ${valid ? '✓' : '✗'} ${tool} ${valid ? '已拿回中文回答' : result.error ?? '回答未包含测试文字'}；日志：${path.join(runDir, tool)}`);
    }
    tools.push({ tool, ...probe, ...(result ? { result } : {}) });
  }
  return { exitCode: failed || signal?.aborted ? 1 : 0, tools, playwright };
}

export async function main(args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? console.log;
  if (!args.length || args[0] === '--help' || args[0] === '-h') { log(help); return 0; }
  const [command, ...rest] = args;
  if (command === 'init') {
    if (rest.length) throw new Error('参数错误，请使用 crew init。');
    await initProject(cwd, log); return 0;
  }
  if (command === 'validate') {
    if (rest.length !== 1) throw new Error('参数错误，请使用 crew validate <任务名>。');
    log(JSON.stringify(await loadTaskSheet(await taskFile(cwd, rest[0]), { warn: log }), null, 2)); return 0;
  }
  if (command === 'status') {
    if (rest.length > 1 || rest.some(arg => arg.startsWith('-'))) throw new Error('参数错误，请使用 crew status [运行编号]。');
    const { state, runDir } = await loadRun(cwd, rest[0]);
    log(`运行：${state.runId}\n状态：${state.status}${state.stopReason ? `（${state.stopReason}）` : ''}\n第 ${state.round} 轮 · 下一步 ${state.nextStep}\n已用 ${duration(state.elapsedMs)}\n分支：${state.branch}\n记录：${runDir}`);
    const approvalStage = state.approvalStage ?? (state.status === 'waiting_approval' ? 'design' : null);
    log(`确认阶段（approvalStage）：${approvalStage ?? '无'}`);
    if (state.status === 'waiting_approval') {
      if (approvalStage === 'review') log(`等待审阅确认。运行 crew approve ${state.runId} 确认当前模型结论并继续，或 crew revise ${state.runId} --note "人工修改意见" 退回修改。`);
      else log(`等待设计批准。阅读 design.md 后运行 crew approve ${state.runId} 继续。`);
    }
    for (const round of state.rounds) log(`第 ${round.n} 轮：${round.verdict ?? '未审阅'} · 改动 ${round.changedFiles ?? 0} 个文件 · 检查 ${round.checksPassed === null || round.checksPassed === undefined ? '未运行' : round.checksPassed ? '通过' : '失败'}`);
    return 0;
  }
  if (command === 'run') {
    if (rest.length < 1 || rest.length > 2 || (rest.length === 2 && rest[1] !== '--dry-run')) throw new Error('参数错误，请使用 crew run <任务名> [--dry-run]。');
    if (rest[1] === '--dry-run') { await dryRun(cwd, rest[0], log); return 0; }
    await taskFile(cwd, rest[0]);
  } else if (command === 'doctor') {
    if (rest.some(arg => arg !== '--live') || rest.length > 1) throw new Error('参数错误，请使用 crew doctor 或 crew doctor --live。');
  } else if (!['approve', 'revise', 'resume', ...meetingCommands].includes(command)) throw new Error(`未知命令「${command}」，请运行 crew --help。`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const shared = { ...options, cwd, log, signal: options.signal ?? controller.signal };
    if (meetingCommands.includes(command)) return await meetingMain(command, rest, shared);
    if (command === 'doctor') return (await doctor({ ...shared, live: rest.includes('--live') })).exitCode;
    if (command === 'run') return (await runTask({ ...shared, taskName: rest[0] })).exitCode;
    if (command === 'revise') return (await resumeRun({ ...shared, ...reviseOptions(rest), approve: true })).exitCode;
    return (await resumeRun({ ...shared, ...runOptions(rest, command === 'resume'), approve: command === 'approve' })).exitCode;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
