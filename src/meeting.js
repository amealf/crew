import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { getAdapter } from './adapters/index.js';
import { projectPath } from './paths.js';
import { renderPrompt } from './prompts.js';
import { notify } from './notify.js';
import { atomicText } from './runlog.js';
import { loadMeetingConfig } from './meeting-config.js';
import { createMeeting, meetingEvent, meetingFile, meetingLock, saveMeeting, withMeeting } from './meeting-log.js';

const interrupted = { status: 'interrupted', output: null, durationMs: 0, error: '运行已中断。' };
const pending = { status: 'pending', output: null, durationMs: null, error: null };
const historyLimit = 60_000;
const readRecord = async (meeting, relative) => readFile(await meetingFile(meeting.dir, relative), 'utf8');
const projectRelative = (cwd, file) => path.relative(cwd, file).split(path.sep).join('/');

async function decisionsPath(cwd) {
  const file = await projectPath(cwd, 'DECISIONS.md');
  try { await stat(file); return file; }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export async function participantHistory(meeting, roundNo, id, cwd) {
  const items = await Promise.all(meeting.state.rounds.filter(round => round.n < roundNo && round.to.includes(id)).map(async round => {
    const question = `### 第 ${round.n} 轮\n问题：${await readRecord(meeting, round.question)}`;
    const output = round.answers[id]?.output;
    return { n: round.n, question, answer: round.answers[id]?.status === 'ok' && output
      ? `\n回答：${await readRecord(meeting, output)}` : '' };
  }));
  const complete = item => item.question + item.answer;
  const all = items.map(complete).join('\n\n');
  if (all.length <= historyLimit || items.length <= 2) return all;
  const record = projectRelative(cwd, await meetingFile(meeting.dir, 'meeting.json'));
  const shortened = cut => {
    const first = items[1].n, last = items[cut - 1].n;
    return [complete(items[0]), `中间第 ${first}–${last} 轮的回答已省略，完整记录见 ${record}。`,
      ...items.slice(1, cut).map(item => item.question), ...items.slice(cut).map(complete)].join('\n\n');
  };
  let cut = 2;
  while (cut < items.length - 1 && shortened(cut).length > historyLimit) cut += 1;
  return shortened(cut);
}

async function attemptDirectory(meeting, base) {
  const directory = await meetingFile(meeting.dir, base);
  try { await mkdir(directory); return base; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  for (let i = 2; ; i += 1) {
    const relative = `${base}/attempt-${i}`;
    try { await mkdir(await meetingFile(meeting.dir, relative)); return relative; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

async function callWorker(meeting, round, member, base, prompt, { cwd, signal, retryDelayMs = 30_000 }) {
  let answer = interrupted;
  for (let attempt = 1; attempt <= 2 && !signal?.aborted; attempt += 1) {
    const relative = await attemptDirectory(meeting, base);
    const stepDir = await meetingFile(meeting.dir, relative);
    if (signal?.aborted) return interrupted;
    const startedAt = performance.now();
    let result;
    try {
      result = await getAdapter(member.tool).run({
        prompt, model: member.model, mode: 'read', cwd, stepDir, signal,
        timeoutMs: (meeting.state.timeoutMinutes ?? 15) * 60_000,
      });
    } catch (error) {
      result = { error: error.message, durationMs: Math.round(performance.now() - startedAt) };
    }
    const status = result.ok ? 'ok' : result.interrupted || signal?.aborted ? 'interrupted'
      : result.quotaHit ? 'quota' : result.timedOut ? 'timeout' : 'failed';
    answer = { status, output: status === 'ok' ? `${relative}/output.md` : null,
      durationMs: result.durationMs, error: result.error ?? null };
    await meetingEvent(meeting, { round: round.n, step: member.id ?? 'summary', attempt, directory: relative, ...answer });
    if (status !== 'failed' && status !== 'timeout') break;
    if (attempt === 1) {
      try { await delay(retryDelayMs, undefined, { signal }); }
      catch (error) { if (!signal?.aborted) throw error; }
    }
  }
  return signal?.aborted && answer.status !== 'ok' && answer.status !== 'quota'
    ? { ...answer, ...interrupted, durationMs: answer.durationMs } : answer;
}

async function runSummary(meeting, round, by, options) {
  const { cwd } = options;
  const answerPaths = await Promise.all(round.to.map(async id => {
    const answer = round.answers[id];
    if (answer.status !== 'ok') return `- ${id}：本轮没有回答（${answer.status}）`;
    const { tool, model } = meeting.state.participants.find(member => member.id === id);
    const file = projectRelative(cwd, await meetingFile(meeting.dir, answer.output));
    return `- ${id}（${tool} ${model ?? '默认'}）：${file}`;
  }));
  const prompt = await renderPrompt('summarizer', { cwd, question: await readRecord(meeting, round.question),
    decisions: await decisionsPath(cwd), answer_paths: answerPaths });
  const result = await callWorker(meeting, round, by, `rounds/r${round.n}/summary`, prompt, options);
  let output = null;
  if (result.status === 'ok') {
    output = `rounds/r${round.n}/summary.md`;
    await atomicText(await meetingFile(meeting.dir, output), await readRecord(meeting, result.output));
  }
  round.summary = { ...result, output, by };
  return result.status === 'ok';
}

export async function printRound(meeting, round, log) {
  log(`第 ${round.n} 轮（${round.status}）\n${await readRecord(meeting, round.question)}`);
  for (const id of round.to) {
    const answer = round.answers[id];
    const text = answer.status === 'ok' ? await readRecord(meeting, answer.output) : answer.error ?? '待回答';
    log(`\n${id}（${answer.status}）\n${text}`);
  }
  if (round.summary?.status === 'ok') log(`\n总结\n${await readRecord(meeting, round.summary.output)}`);
  else if (round.summary) log(`\n总结（${round.summary.status}）：${round.summary.error ?? ''}`);
}

async function runRound(meeting, round, recipients, options) {
  const { cwd, log, signal, notifyFn = notify } = options;
  round.status = 'running';
  for (const id of recipients) round.answers[id] = { ...pending };
  await saveMeeting(meeting);
  const question = await readRecord(meeting, round.question);
  const decisions = await decisionsPath(cwd);
  const inputs = await Promise.all(recipients.map(async id => {
    const member = meeting.state.participants.find(item => item.id === id);
    const history = await participantHistory(meeting, round.n, id, cwd);
    const prompt = await renderPrompt('participant', { cwd, question, decisions, history });
    return { id, member, prompt };
  }));
  log(`会审 ${meeting.state.meetingId} · 第 ${round.n} 轮`);
  const settled = await Promise.allSettled(inputs.map(async ({ id, member, prompt }) => {
    round.answers[id] = await callWorker(meeting, round, member, `rounds/r${round.n}/${id}`, prompt, options);
    await saveMeeting(meeting);
  }));
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const firstSuccess = round.to.find(id => round.answers[id].status === 'ok');
  if (!signal?.aborted && firstSuccess && !round.noSummary && round.summary?.status !== 'ok') {
    try { await runSummary(meeting, round, meeting.state.summarizer, options); }
    finally {
      round.status = signal?.aborted ? 'interrupted' : 'done';
      await saveMeeting(meeting);
    }
  } else {
    round.status = signal?.aborted ? 'interrupted' : firstSuccess ? 'done' : 'failed';
    await saveMeeting(meeting);
  }
  await meetingEvent(meeting, { round: round.n, status: round.status });
  await printRound(meeting, round, log);
  if (round.status === 'interrupted') {
    log(`本轮已中断。运行 crew ask --retry ${meeting.state.meetingId} 补跑。`);
    return 2;
  }
  if (firstSuccess) log(`采纳请用 crew decide ${meeting.state.meetingId} --adopt ${firstSuccess}。`);
  else log(`本轮没有收到回答。请检查步骤日志，再运行 crew ask --retry ${meeting.state.meetingId}。`);
  const task = `会审第 ${round.n} 轮完成`;
  let notice;
  try { notice = await notifyFn({ cwd, task, status: round.status, runDir: meeting.dir }); }
  catch (error) { notice = { ok: false, error: error.message }; }
  if (!notice?.ok) await meetingEvent(meeting, { round: round.n, notification: 'failed', error: notice?.error });
  return firstSuccess ? 0 : 2;
}

async function appendRound(meeting, options) {
  const { state } = meeting;
  const previous = state.rounds.at(-1);
  if (['running', 'interrupted'].includes(previous?.status)) {
    throw new Error('上一轮尚未结束，请先运行 crew ask --retry。');
  }
  if (options.to && !state.participants.some(member => member.id === options.to)) {
    throw new Error(`--to：参会者 ${options.to} 不存在。可选：${state.participants.map(member => member.id).join('、')}。`);
  }
  const n = (previous?.n ?? 0) + 1;
  const to = options.to ? [options.to] : state.participants.map(member => member.id);
  const relative = `rounds/r${n}/question.md`;
  const questionFile = await meetingFile(meeting.dir, relative);
  await mkdir(path.dirname(questionFile), { recursive: true });
  await writeFile(questionFile, options.question, 'utf8');
  const round = { n, to, question: relative, status: 'running',
    answers: Object.fromEntries(to.map(id => [id, { ...pending }])),
    summary: null, noSummary: options.noSummary };
  state.rounds.push(round);
  return runRound(meeting, round, to, options);
}

export async function ask(options) {
  const { cwd, log, retry, meetingId, withTools, to, file } = options;
  if (retry) return withMeeting(cwd, meetingId, async meeting => {
    const round = meeting.state.rounds.at(-1);
    if (!round) throw new Error('这个会审没有可重试的轮次。');
    const recipients = round.to.filter(id => ['pending', 'failed', 'timeout', 'interrupted'].includes(round.answers[id].status));
    const unfinishedSummary = round.status === 'running' || round.status === 'interrupted';
    if (!recipients.length && !unfinishedSummary) {
      log('本轮没有可自动补跑的参会者。额度限制解除后，可发起新一轮。');
      return round.status === 'failed' ? 2 : 0;
    }
    // Any new answers invalidate the previous summary.
    if (recipients.length) round.summary = null;
    return runRound(meeting, round, recipients, options);
  });
  const question = file === undefined ? options.question : await readFile(await projectPath(cwd, file), 'utf8');
  if (!question?.trim()) throw new Error('请提供非空问题，或使用 --file 读取项目内的问题文件。');
  const roundOptions = { ...options, question };
  if (meetingId || to) return withMeeting(cwd, meetingId, meeting => appendRound(meeting, roundOptions));
  const config = await loadMeetingConfig(cwd, withTools, log);
  const meeting = await createMeeting(cwd, question, config);
  const release = await meetingLock(cwd, meeting.state.meetingId);
  try { return await appendRound(meeting, roundOptions); }
  finally { await release(); }
}

export async function summarize(options) {
  return withMeeting(options.cwd, options.meetingId, async meeting => {
    const round = meeting.state.rounds.at(-1);
    if (!round?.to.some(id => round.answers[id].status === 'ok')) throw new Error('最近一轮没有成功回答，无法总结。');
    if (round.status === 'running' || round.status === 'interrupted') {
      throw new Error('最近一轮尚未结束，请先运行 crew ask --retry。');
    }
    const ok = await runSummary(meeting, round, options.by ?? meeting.state.summarizer, options);
    await saveMeeting(meeting);
    await meetingEvent(meeting, { round: round.n, step: 'summary', status: round.summary.status });
    if (ok) options.log(await readRecord(meeting, round.summary.output));
    else options.log(`总结未完成：${round.summary.error}。可运行 crew summarize 重试。`);
    return ok ? 0 : 2;
  });
}
