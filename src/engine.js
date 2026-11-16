import path from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { loadTaskSheet, validateTaskSheet } from './tasksheet.js';
import { renderPrompt } from './prompts.js';
import { parseVerdict } from './verdict.js';
import { getAdapter } from './adapters/index.js';
import { projectPath } from './paths.js';
import * as gitops from './gitops.js';
import * as runlog from './runlog.js';
import { runChecks } from './checks.js';
import { notify } from './notify.js';

const roleFor = { design: 'designer', build: 'builder', review: 'reviewer' };
const names = { design: '设计', build: '实现', check: '检查', review: '审阅', commit: '提交' };
const hours = 3_600_000;
export function exitCode(state) { return state.status === 'error' ? 1 : state.status === 'stopped' ? 2 : 0; }
export function duration(ms) {
  const seconds = Math.floor(ms / 1000);
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分`
    : seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
}
async function present(file) { try { await access(file); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; } }

export async function promptContext({ cwd, sheet, state, runDir }) {
  const decisions = await projectPath(cwd, 'DECISIONS.md');
  const design = path.join(runDir, 'design.md');
  const previous = state.rounds.find(round => round.n === state.round - 1);
  const current = state.rounds.find(round => round.n === state.round);
  return {
    cwd, goal: sheet.goal, checklist: sheet.review_checklist.map(item => `- ${item}`).join('\n'),
    decisions: await present(decisions) ? decisions : '',
    design_path: await present(design) ? design : '', round: state.round,
    prev_review_path: previous?.reviewPath ?? '', prev_check_path: previous?.checkPath ?? '',
    diff_path: current?.diffPath ?? '', check_path: current?.checkPath ?? '',
    screenshot_paths: (current?.screenshots ?? []).filter(shot => shot.ok).map(shot => shot.path).join('\n'),
    malformed_note: previous?.malformed ? '上一轮审阅没有给出合规结论。请阅读审阅正文和检查结果，解决具体问题；审阅者应在最后一行给出 VERDICT 结论。' : '',
  };
}

function requiredFixCount(text) {
  const section = /^#{1,6}\s*必须修改[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/m.exec(text)?.[1];
  return section ? (section.match(/^\s*\d+[.)、]\s*/gm) ?? []).length : 0;
}

export async function writeReport({ runDir, state, sheet }) {
  const rounds = state.rounds.map(round => `| ${round.n} | ${round.commit?.slice(0, 10) ?? '—'} | ${round.changedFiles ?? '—'} | ${round.checksPassed === null || round.checksPassed === undefined ? '未运行' : round.checksPassed ? '通过' : '失败'} | ${round.verdict ?? '未审阅'} | ${round.requiredFixes ?? '—'} |`).join('\n');
  const original = state.originalBranch;
  const approvalHint = state.approvalStage === 'review'
    ? `阅读本轮审阅与检查记录后运行 crew approve ${state.runId}；要退回修改，运行 crew revise ${state.runId} --note "具体修改意见"。`
    : '阅读 design.md 后运行 crew approve。';
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  const commands = state.branch && state.baseCommit ? `git diff ${state.baseCommit}..${state.branch}\ngit log --oneline ${state.baseCommit}..${state.branch}\n${original && original !== 'HEAD' ? `git switch ${quote(original)}\ngit merge --no-ff ${quote(state.branch)}` : '# 开始时处于 detached HEAD，请先选择目标分支再手动合并。'}` : '# 分支尚未创建。';
  const text = `# crew 运行报告\n\n## 目标\n\n${sheet.goal}\n\n## 结果\n\n任务：${state.task}\n\n运行：${state.runId}\n\n状态：${state.status}\n\n原因：${state.stopReason ?? '无'}\n\n已用时间：${duration(state.elapsedMs)}（${state.elapsedMs} ms）\n\n分支：${state.branch ?? '未创建'}\n\n下一步：${state.nextStep}\n\n## 每轮结果\n\n| 轮次 | 提交 | 改动文件数 | 检查 | 结论 | 必须修改条数 |\n| --- | --- | --- | --- | --- | --- |\n${rounds || '| — | — | — | — | — | — |'}\n\n## 查看改动与手动合并\n\n\`\`\`powershell\n${commands}\n\`\`\`\n\n${state.status === 'waiting_approval' ? approvalHint : state.status === 'stopped' ? `解决停止原因后运行 crew resume ${state.runId}。时间上限可用 --extend-hours 12 增加。` : ''}\n${state.error ? `\n错误：${state.error}\n` : ''}`;
  await writeFile(path.join(runDir, 'REPORT.md'), text, 'utf8');
}

async function toolsReady(sheet) {
  const used = [...new Set(Object.values(sheet.roles).map(role => role.tool))];
  for (const tool of used) if (!(await getAdapter(tool).probe()).installed) {
    throw new Error(`工具 ${tool} 尚未安装，请安装并加入 PATH，再运行 crew doctor。`);
  }
}

async function initializationBranch(cwd, state) {
  const actual = await gitops.currentBranch(cwd);
  if (![state.originalBranch, state.branch].includes(actual) || await gitops.head(cwd) !== state.baseCommit) {
    throw new Error(`初始化尚未完成，请先切回 ${state.originalBranch} 或 ${state.branch}，并确认 HEAD 仍为 ${state.baseCommit}，再执行 crew resume。`);
  }
  return actual;
}

function wait(ms, signal) {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function drive({ cwd, sheet, runDir, state, signal, log = console.log, notifyFn = notify,
  retryDelayMs = 30_000, onStep = async () => {}, playwrightLoader }) {
  const sessionStart = performance.now();
  const initialElapsed = state.elapsedMs;
  let writes = Promise.resolve();
  let heartbeatError;
  const elapsed = () => initialElapsed + Math.round(performance.now() - sessionStart);
  const maximum = () => (sheet.stop_when.max_hours + (state.extendedHours ?? 0)) * hours;
  const remaining = () => Math.max(0, maximum() - elapsed());
  const checkpoint = () => {
    state.elapsedMs = elapsed();
    state.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(state);
    writes = writes.then(() => runlog.saveState(runDir, snapshot));
    return writes;
  };
  const say = text => log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  const record = data => runlog.event(runDir, { round: state.round, ...data });
  const current = () => {
    let round = state.rounds.find(item => item.n === state.round);
    if (!round) { round = { n: state.round, commit: null, changedFiles: null, checksPassed: null, verdict: null }; state.rounds.push(round); }
    return round;
  };
  const finish = async (status, reason = null) => {
    state.status = status;
    state.stopReason = reason;
    state.inFlight = null;
    await checkpoint();
    await record({ step: 'report', result: status, reason, elapsedMs: state.elapsedMs });
    await writeReport({ runDir, state, sheet });
    say(`${state.task} ${status}${reason ? `（${reason}）` : ''} · 已用 ${duration(state.elapsedMs)}`);
    if (['approved', 'waiting_approval', 'stopped'].includes(status)) {
      try {
        const notification = await notifyFn({ cwd, task: state.task, status, runDir });
        if (notification?.ok === false) await record({ step: 'notify', result: 'failed', error: notification.error });
      } catch (error) { await record({ step: 'notify', result: 'failed', error: error.message }); }
    }
    return { state, runDir, exitCode: exitCode(state) };
  };
  const stop = reason => finish('stopped', reason);
  const boundary = async (step, phase) => {
    await onStep({ step, round: state.round, phase, state: structuredClone(state), runDir });
    if (signal?.aborted) return 'interrupted';
    if (remaining() <= 0) return 'max_hours';
    return null;
  };
  const worker = async step => {
    const role = roleFor[step];
    const { tool, model } = sheet.roles[role];
    const mode = step === 'build' ? 'write' : 'read';
    const prompt = await renderPrompt(role, await promptContext({ cwd, sheet, state, runDir }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) return { stop: 'interrupted' };
      if (remaining() <= 0) return { stop: 'max_hours' };
      await gitops.assertBranch(cwd, state.branch);
      if (step === 'build' && (attempt > 0 || state.restoreBuild)) {
        const recovery = path.join(runDir, 'recovery', `r${state.round}-${Date.now()}-attempt-${attempt}`);
        await gitops.restoreRound(cwd, state.roundBaseCommit, recovery);
        state.restoreBuild = false;
      }
      const stepDir = await runlog.nextStepDir(runDir, state, step);
      state.inFlight = { step, attempt, stepDir, startedAt: new Date().toISOString() };
      await checkpoint();
      say(`${step === 'design' ? '' : `第 ${state.round} 轮 `}${names[step]} ${role} (${tool}${model ? ` / ${model}` : ''}) 开始${attempt ? '（重试）' : ''}`);
      await record({ step, role, tool, model: model ?? null, mode, result: 'start', retry: attempt > 0 });
      const limited = await boundary(step, 'start');
      if (limited) return { stop: limited };
      const result = await getAdapter(tool).run({ prompt, model, mode, cwd, stepDir, signal,
        timeoutMs: Math.max(1, Math.min(sheet.stop_when.step_timeout_minutes * 60_000, remaining())) });
      const metadataFile = path.join(stepDir, 'meta.json');
      const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
      await runlog.atomicJson(metadataFile, { ...metadata, retry: attempt > 0, attempt, round: state.round, role });
      await record({ step, result: result.ok ? 'ok' : 'failed', durationMs: result.durationMs,
        exitCode: result.exitCode, timedOut: result.timedOut, quotaHit: result.quotaHit, error: result.error, retry: attempt > 0 });
      say(`${names[step]} ${result.ok ? '完成' : result.error} ${duration(result.durationMs)}`);
      const stopped = await boundary(step, 'end');
      if (stopped) return { stop: stopped };
      if (result.interrupted) return { stop: 'interrupted' };
      if (result.quotaHit) return { stop: 'quota' };
      if (result.ok) { state.inFlight = null; return { text: result.text, stepDir }; }
      if (attempt === 1) return { stop: result.timedOut ? 'step_timeout' : 'step_failed' };
      if (!result.timedOut) {
        say(`30 秒后重试 ${names[step]}。`);
        await wait(Math.min(retryDelayMs, remaining()), signal);
      }
    }
  };

  state.status = 'running'; state.stopReason = null; delete state.error;
  const heartbeat = setInterval(() => { checkpoint().catch(error => { heartbeatError = error; }); }, 2000);
  heartbeat.unref();
  try {
    await checkpoint();
    say(`运行 ${state.runId} · 分支 ${state.branch}`);
    while (true) {
      if (heartbeatError) throw heartbeatError;
      if (signal?.aborted) return await stop('interrupted');
      if (remaining() <= 0) return await stop('max_hours');
      const step = state.nextStep;
      if (step !== 'initialize') await gitops.assertBranch(cwd, state.branch);
      if (step === 'initialize') {
        const limited = await boundary('initialize', 'start');
        if (limited) return await stop(limited);
        const actual = await initializationBranch(cwd, state);
        if (actual !== state.branch) await gitops.createBranch(cwd, state.branch);
        const stopped = await boundary('initialize', 'end');
        if (stopped) return await stop(stopped);
        state.nextStep = state.initialNextStep;
        delete state.initialNextStep;
        await checkpoint();
      } else if (step === 'design') {
        const result = await worker('design');
        if (result.stop) return await stop(result.stop);
        await writeFile(path.join(runDir, 'design.md'), result.text, 'utf8');
        state.nextStep = sheet.flow.includes('approve') ? 'approve' : 'build';
        await checkpoint();
      } else if (step === 'approve') {
        state.nextStep = 'build';
        state.approvalStage = 'design';
        return await finish('waiting_approval');
      } else if (step === 'build') {
        if (sheet.stop_when.max_rounds !== null && state.round > sheet.stop_when.max_rounds) return await stop('max_rounds');
        current();
        state.roundBaseCommit ??= await gitops.head(cwd);
        await checkpoint();
        const result = await worker('build');
        if (result.stop) return await stop(result.stop);
        state.nextStep = 'commit';
        await checkpoint();
      } else if (step === 'commit') {
        await gitops.assertBranch(cwd, state.branch);
        const committed = await gitops.commitBuild(cwd, state.round, { baseCommit: state.roundBaseCommit });
        Object.assign(current(), committed);
        state.stallCount = committed.changedFiles ? 0 : state.stallCount + 1;
        state.nextStep = sheet.flow.find(item => item?.loop)?.loop.includes('check') ? 'check' : 'review';
        await checkpoint();
        await record({ step: 'commit', result: 'ok', ...committed });
        say(`第 ${state.round} 轮已提交 · 改动 ${committed.changedFiles} 个文件`);
        if (state.stallCount >= sheet.stop_when.stall_rounds) return await stop('stalled');
      } else if (step === 'check') {
        state.inFlight = { step: 'check', startedAt: new Date().toISOString() };
        await checkpoint();
        say(`第 ${state.round} 轮 检查 开始`);
        const limited = await boundary('check', 'start');
        if (limited) return await stop(limited);
        const checkController = new AbortController();
        const forwardAbort = () => checkController.abort();
        signal?.addEventListener('abort', forwardAbort, { once: true });
        let budgetExpired = false;
        const checkBudget = setTimeout(() => { budgetExpired = true; checkController.abort(); }, Math.max(1, remaining()));
        let checks;
        try {
          if (signal?.aborted) checkController.abort();
          checks = await runChecks({ cwd, checks: sheet.checks, runDir, round: state.round, signal: checkController.signal,
          timeoutMs: Math.max(1, Math.min(600_000, remaining())), playwrightLoader });
        } finally {
          clearTimeout(checkBudget);
          signal?.removeEventListener('abort', forwardAbort);
        }
        const stopped = await boundary('check', 'end');
        if (stopped || budgetExpired || checks.interrupted) return await stop(stopped ?? (budgetExpired ? 'max_hours' : 'interrupted'));
        Object.assign(current(), { checksPassed: checks.passed, checkPath: path.join(runDir, 'checks', `check-${state.round}.json`), screenshots: checks.screenshots });
        state.inFlight = null;
        state.nextStep = 'review';
        await checkpoint();
        await record({ step: 'check', result: checks.passed ? 'passed' : 'failed' });
        say(`第 ${state.round} 轮 检查 ${checks.passed ? '通过' : '失败'} · 截图 ${checks.screenshots.filter(shot => shot.ok).length} 张`);
        for (const reason of new Set(checks.screenshots.filter(shot => !shot.ok).map(shot => shot.reason))) say(`截图：${reason}`);
      } else if (step === 'review') {
        const diffPath = path.join(runDir, 'checks', `diff-${state.round}.patch`);
        await gitops.writeDiff(cwd, state.baseCommit, diffPath);
        current().diffPath = diffPath;
        const result = await worker('review');
        if (result.stop) return await stop(result.stop);
        const reviewPath = path.join(runDir, 'reviews', `review-${state.round}.md`);
        await writeFile(reviewPath, result.text, 'utf8');
        current().reviewPath = reviewPath;
        state.nextStep = 'decide';
        await checkpoint();
      } else if (step === 'decide') {
        const round = current();
        const text = await readFile(round.reviewPath, 'utf8');
        const parsed = parseVerdict(text);
        round.malformed = parsed.malformed;
        round.verdict = parsed.verdict;
        round.modelVerdict = parsed.verdict;
        round.requiredFixes = requiredFixCount(text);
        // Re-deciding after a crash must not count the same review twice.
        state.malformedCount = 0;
        for (const reviewed of state.rounds.filter(item => item.n <= state.round).sort((a, b) => b.n - a.n)) {
          if (!reviewed.malformed) break;
          state.malformedCount += 1;
        }
        if (parsed.malformed) await record({ step: 'verdict', result: 'malformed', note: '上一轮审阅没有给出合规结论。' });
        if (round.verdict === 'APPROVED' && round.checksPassed === false) {
          round.verdict = 'REVISE';
          round.checkOverride = true;
          await record({ step: 'verdict', result: 'check_override', note: '审阅通过但检查未通过。' });
        }
        await record({ step: 'verdict', result: round.verdict, malformed: parsed.malformed, requiredFixes: round.requiredFixes });
        say(`第 ${state.round} 轮 审阅 ${round.verdict} · 必须修改 ${round.requiredFixes} 条`);
        const reason = round.verdict === 'BLOCKED' ? 'blocked' : state.malformedCount >= 2 ? 'review_malformed' : null;
        if (reason) {
          state.nextStep = 'build'; state.advanceOnResume = true;
          await checkpoint();
          return await stop(reason);
        }
        if (sheet.human_review) { state.nextStep = 'review_gate'; state.approvalStage = 'review'; }
        else if (round.verdict === 'APPROVED') state.nextStep = 'report';
        else { state.round += 1; state.roundBaseCommit = null; state.nextStep = 'build'; }
        await checkpoint();
      } else if (step === 'review_gate') {
        return await finish('waiting_approval');
      } else if (step === 'accept_review') {
        if (current().verdict === 'APPROVED' && current().checksPassed !== false) state.nextStep = 'report';
        else { state.round += 1; state.roundBaseCommit = null; state.nextStep = 'build'; }
        await checkpoint();
      } else if (step === 'report' || step === 'done') {
        state.nextStep = 'done';
        return await finish('approved');
      } else throw new Error(`运行记录 nextStep「${step}」无效，请检查 state.json。`);
    }
  } catch (error) {
    state.error = error.message;
    return await finish('error', 'exception');
  } finally {
    clearInterval(heartbeat);
    await writes;
  }
}

export async function runTask(options) {
  const { cwd = process.cwd(), taskName, taskPath } = options;
  if (!/^[\p{L}\p{N}_.-]+$/u.test(taskName ?? '') || ['.', '..'].includes(taskName)) throw new Error('任务名只能包含文字、数字、横线、下划线和点。');
  const source = await projectPath(cwd, taskPath ?? path.join('.crew', 'tasks', `${taskName}.yaml`));
  const release = await runlog.acquireLock(cwd);
  try {
    const sheet = options.sheet ? validateTaskSheet(options.sheet, { warn: options.log ?? console.warn }) : await loadTaskSheet(source);
    await toolsReady(sheet);
    await gitops.preflight(cwd);
    const originalBranch = await gitops.currentBranch(cwd);
    const baseCommit = await gitops.head(cwd);
    const { runDir, state } = await runlog.createRun(cwd, taskName, source, sheet, { originalBranch, baseCommit });
    return await drive({ ...options, cwd, sheet, runDir, state });
  } finally { await release(); }
}

export async function resumeRun(options = {}) {
  const { cwd = process.cwd(), runId, approve = false, extendHours = 0, revise } = options;
  if (!Number.isFinite(extendHours) || extendHours < 0) throw new Error('--extend-hours 必须是大于 0 的小时数。');
  if (revise !== undefined && (typeof revise !== 'string' || !revise.trim())) throw new Error('人工修改意见必须是非空文字。');
  const release = await runlog.acquireLock(cwd);
  try {
    const { state, runDir, taskPath } = await runlog.loadRun(cwd, runId);
    if (approve ? state.status !== 'waiting_approval' : !['stopped', 'running'].includes(state.status)) {
      throw new Error(approve ? '该运行没有等待审批，请先运行 crew status。' : `该运行状态为 ${state.status}，请用 crew status 查看；等待审批时运行 crew approve。`);
    }
    if (revise !== undefined && (!approve || state.approvalStage !== 'review')) throw new Error('人工退回仅支持等待审阅确认的运行；设计审批请使用 crew approve。');
    if (state.nextStep === 'initialize') await initializationBranch(cwd, state);
    else await gitops.assertBranch(cwd, state.branch);
    const sheet = await loadTaskSheet(taskPath);
    await toolsReady(sheet);
    if (approve) {
      if (state.approvalStage === 'review') {
        const reviewed = state.rounds.find(item => item.n === state.round);
        reviewed.humanVerdict = revise !== undefined ? 'REVISE' : 'CONFIRMED';
        if (revise !== undefined) {
          const round = reviewed;
          const feedback = await projectPath(cwd, path.join(runDir, 'reviews', `human-review-${state.round}.md`));
          round.modelReviewPath ??= round.reviewPath;
          await writeFile(feedback, `# 人工审阅修改意见\n\n模型审阅记录：${round.modelReviewPath}\n\n## 必须修改\n\n1. ${revise.trim()}\n\nVERDICT: REVISE\n`, 'utf8');
          round.reviewPath = feedback;
          round.verdict = 'REVISE';
          round.humanVerdict = 'REVISE';
          round.requiredFixes = Math.max(1, round.requiredFixes ?? 0);
        }
        state.nextStep = 'accept_review';
      }
      delete state.approvalStage;
    }
    if (extendHours) state.extendedHours = (state.extendedHours ?? 0) + extendHours;
    if (state.advanceOnResume) {
      state.round += 1;
      state.roundBaseCommit = null;
      delete state.advanceOnResume;
    }
    state.restoreBuild = state.nextStep === 'build' && Boolean(state.roundBaseCommit);
    state.status = 'running';
    await runlog.saveState(runDir, state);
    await runlog.event(runDir, { step: revise !== undefined ? 'human_revise' : approve ? 'approve' : 'resume', result: 'start', extendedHours: extendHours });
    return await drive({ ...options, cwd, sheet, runDir, state });
  } finally { await release(); }
}
