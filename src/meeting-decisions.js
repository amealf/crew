import { readFile } from 'node:fs/promises';
import { projectPath } from './paths.js';
import { acquireIpcLock, atomicText, stamp } from './runlog.js';
import { meetingEvent, meetingFile, saveMeeting, withMeeting } from './meeting-log.js';

const header = /^## (D-\d+)[ \t]+([^\r\n]+)\r?$/gm;
const readRecord = async (meeting, relative) => readFile(await meetingFile(meeting.dir, relative), 'utf8');

function firstLine(text) {
  return text.split(/\r?\n/).find(line => line.trim())?.trim().replace(/^#+\s+/, '') || '会审决议';
}

async function draft(meeting, { adopt, text, title }) {
  const { state } = meeting;
  let round = state.rounds.at(-1);
  if (adopt) {
    if (!state.participants.some(member => member.id === adopt)) throw new Error(`--adopt：参会者 ${adopt} 不存在。`);
    round = state.rounds.findLast(item => item.answers[adopt]?.status === 'ok');
    if (!round) throw new Error(`${adopt} 没有可采纳的成功回答。`);
    text = `采纳自 ${adopt}（第 ${round.n} 轮）\n\n${await readRecord(meeting, round.answers[adopt].output)}`;
  }
  if (!round) throw new Error('这个会审还没有轮次。');
  const summary = round.summary?.status === 'ok' ? await readRecord(meeting, round.summary.output) : '';
  const recommendation = /^#{1,6}\s+决议草稿[^\r\n]*\r?\n\s*(?:\*\*)?标题[：:]\s*(.+)$/m.exec(summary)?.[1].trim().replace(/\*\*$/, '');
  const fallback = adopt ? text.split('\n\n').slice(1).join('\n\n') : text;
  return { title: title ?? (recommendation || firstLine(fallback)), content: text, round: round.n, adoptedFrom: adopt ?? null };
}

function decisionBlock(declaration, id, decision, writtenAt) {
  const date = stamp(new Date(writtenAt)).slice(0, 8).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  return `## ${id} ${decision.title}\n- 状态：Active\n- 日期：${date}\n- 来源：会审 ${declaration} 第 ${decision.round} 轮${decision.adoptedFrom ? `，采纳自 ${decision.adoptedFrom}` : ''}\n\n${decision.content}${decision.content.endsWith('\n') ? '' : '\n'}`;
}

function decisionEntries(ledger) {
  const matches = [...ledger.matchAll(header)].flatMap(match => {
    const [, id, title] = match;
    const tail = ledger.slice(match.index + match[0].length);
    const source = /^\r?\n- 状态：[^\r\n]+\r?\n- 日期：(\d{4}-\d{2}-\d{2})\r?\n- 来源：会审 (ask-[\d-]+) 第 (\d+) 轮(?:，采纳自 ([a-zA-Z0-9.-]+))?\r?\n/.exec(tail);
    if (!source) return [];
    const date = new Date(`${source[1]}T00:00:00`);
    if (!Number.isFinite(date.valueOf())) return [];
    return [{ meetingId: source[2], start: match.index, record: { id, title, round: Number(source[3]),
      adoptedFrom: source[4] ?? null, writtenAt: date.toISOString() } }];
  });
  return matches.map(({ meetingId, start, record }, i) => ({
    meetingId, record, block: ledger.slice(start, matches[i + 1]?.start).trimEnd(),
  }));
}

async function readLedger(cwd) {
  const file = await projectPath(cwd, 'DECISIONS.md');
  try { return { file, ledger: await readFile(file, 'utf8') }; }
  catch (error) { if (error.code === 'ENOENT') return { file, ledger: '' }; throw error; }
}

export function printDecisions(state, round, log, entries) {
  for (const item of state.decisions.filter(decision => decision.round === round)) {
    const body = entries.find(entry => entry.meetingId === state.meetingId && entry.record.id === item.id)?.block;
    log(body ?? `决议 ${item.id} · ${item.title} · 第 ${item.round} 轮 · DECISIONS.md`);
  }
}

export async function readMeetingDecisions(cwd) {
  return decisionEntries((await readLedger(cwd)).ledger);
}

export async function decide(options) {
  const { cwd, meetingId, log, yes, saveMeetingFn } = options;
  return withMeeting(cwd, meetingId, async meeting => {
    const { state } = meeting;
    const release = await acquireIpcLock(cwd, 'decision-book', '决议本正在写入。请等待当前命令结束后再试。');
    try {
      const decision = await draft(meeting, options);
      const { file, ledger } = await readLedger(cwd);
      const known = new Set(state.decisions.map(item => item.id));
      const entries = decisionEntries(ledger).filter(({ meetingId, record }) => {
        if (meetingId !== state.meetingId || known.has(record.id)) return false;
        known.add(record.id);
        return true;
      });
      const normalized = value => value.replace(/\r\n/g, '\n').trimEnd();
      const alreadyWritten = entries.find(({ record, block }) => record.round === decision.round
        && record.adoptedFrom === decision.adoptedFrom && (!options.title || record.title === options.title)
        && normalized(block) === normalized(decisionBlock(state.meetingId, record.id, {
          ...decision, title: record.title,
        }, record.writtenAt)))?.record;
      const max = [...ledger.matchAll(header)].reduce((value, match) => {
        const n = BigInt(match[1].slice(2));
        return n > value ? n : value;
      }, 0n);
      const id = alreadyWritten?.id ?? `D-${String(max + 1n).padStart(3, '0')}`;
      const writtenAt = alreadyWritten?.writtenAt ?? new Date().toISOString();
      const block = decisionBlock(state.meetingId, id, { ...decision, title: alreadyWritten?.title ?? decision.title }, writtenAt);
      log(block);
      if (!yes) { log('确认后请带 --yes 再执行。可用 --text 写入你改过的内容。'); return 0; }
      state.decisions.push(...entries.map(entry => entry.record));
      if (!alreadyWritten) {
        const separator = ledger && !ledger.endsWith('\n\n') ? ledger.endsWith('\n') ? '\n' : '\n\n' : '';
        await atomicText(file, ledger + separator + block);
        state.decisions.push({ id, title: decision.title, round: decision.round, adoptedFrom: decision.adoptedFrom, writtenAt });
      }
      await saveMeeting(meeting, saveMeetingFn);
      await meetingEvent(meeting, { step: 'decide', id, round: decision.round, recovered: Boolean(alreadyWritten) });
      log(alreadyWritten ? `已补记 ${id}。` : `已写入 DECISIONS.md：${id}。`);
      log(`crew run 前请先提交决议：git add DECISIONS.md && git commit -m "Add decision ${id}"`);
      return 0;
    } finally { await release(); }
  });
}
