import { assertProjectRoot } from './gitops.js';
import { ask, printRound, summarize } from './meeting.js';
import { parseWorker } from './meeting-config.js';
import { listMeetings, loadMeeting } from './meeting-log.js';
import { decide, printDecisions, readMeetingDecisions } from './meeting-decisions.js';

export const meetingCommands = ['ask', 'summarize', 'decide', 'meetings', 'meeting'];

const flags = {
  ask: { '--with': 'withTools', '--file': 'file', '--meeting': 'meetingId', '--to': 'to', '--no-summary': true, '--retry': true },
  summarize: { '--by': 'by' },
  decide: { '--adopt': 'adopt', '--text': 'text', '--title': 'title', '--yes': true },
  meeting: { '--json': true },
  meetings: {},
};

function parseOptions(command, args) {
  const parsed = {};
  const usage = `请运行 crew --help 查看 crew ${command} 用法。`;
  let positional;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-') && positional === undefined && command !== 'meetings') {
      positional = arg;
      continue;
    }
    const key = Object.hasOwn(flags[command], arg) ? flags[command][arg] : null;
    const field = key === true ? arg : key;
    if (!field || Object.hasOwn(parsed, field)) throw new Error(`参数「${arg}」无效或重复。${usage}`);
    if (key === true) parsed[field] = true;
    else {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('--')) throw new Error(`${arg} 需要一个非空值。${usage}`);
      parsed[field] = value;
    }
  }
  if (command === 'ask') {
    parsed.retry = Boolean(parsed['--retry']);
    parsed.noSummary = Boolean(parsed['--no-summary']);
    if (parsed.retry) {
      if (parsed.meetingId || parsed.to || parsed.withTools || parsed.file || parsed.noSummary) {
        throw new Error('--retry 只接受可选的会审编号，请使用 crew ask --retry [编号]。');
      }
      parsed.meetingId = positional;
    } else {
      if ((parsed.meetingId || parsed.to) && parsed.withTools) throw new Error('追问不能带 --with，会审沿用原参会者。');
      parsed.question = positional;
    }
  } else parsed.meetingId = positional;
  if (command === 'summarize' && parsed.by) parsed.by = parseWorker(parsed.by, '--by');
  if (command === 'decide') {
    if (Boolean(parsed.adopt) === Boolean(parsed.text)) throw new Error('请用 --adopt 或 --text 二选一。');
    if (parsed.title && /[\r\n]/.test(parsed.title)) throw new Error('--title 需要单行文字。');
    if (parsed.title) parsed.title = parsed.title.trim();
    parsed.yes = Boolean(parsed['--yes']);
  }
  return parsed;
}

export async function meetingMain(command, args, options) {
  const settings = { ...options, ...parseOptions(command, args) };
  const { cwd, log, meetingId } = settings;
  await assertProjectRoot(cwd);
  if (command === 'ask') return ask(settings);
  if (command === 'summarize') return summarize(settings);
  if (command === 'decide') return decide(settings);
  if (command === 'meetings') {
    const list = await listMeetings(cwd);
    if (!list.length) log('还没有会审。');
    for (const { state } of list) log(`${state.meetingId} · ${state.title} · ${state.rounds.length} 轮 · ${state.updatedAt} · ${state.decisions.length} 条决议`);
    return 0;
  }
  const meeting = await loadMeeting(cwd, meetingId);
  if (settings['--json']) log(JSON.stringify(meeting.state, null, 2));
  else {
    log(`${meeting.state.meetingId} · ${meeting.state.title}`);
    const entries = meeting.state.decisions.length ? await readMeetingDecisions(cwd) : [];
    for (const round of meeting.state.rounds) {
      await printRound(meeting, round, log);
      printDecisions(meeting.state, round.n, log, entries);
    }
  }
  return 0;
}
