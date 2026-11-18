import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { main } from '../src/cli.js';
import { execute } from '../src/adapters/process.js';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, '.local', 'tests'), { recursive: true });
const area = await mkdtemp(path.join(root, '.local', 'tests', 'meeting-'));
const answer = (text, extra = {}) => ({ text, ...extra });
const summary = text => answer(`### 一致\n参会者同意先验证。\n### 分歧\n无\n### 推荐\n${text}\n### 决议草稿\n标题：会审建议\n${text}`);

async function git(cwd, args) {
  const result = await execute('git', args, { cwd, timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(script, options, fn) {
  const cwd = await mkdtemp(path.join(area, 'project-'));
  await mkdir(path.join(cwd, '.local'), { recursive: true });
  await mkdir(path.join(cwd, '.crew', 'tasks'), { recursive: true });
  await writeFile(path.join(cwd, '.gitignore'), '.local/\n.crew/runs/\n.crew/meetings/\n', 'utf8');
  const config = {
    participants: [{ tool: 'mock', model: 'a' }, { tool: 'mock', model: 'b' }, { tool: 'mock', model: 'c' }],
    summarizer: { tool: 'mock', model: 's' }, timeout_minutes: 15, ...options.config,
  };
  await writeFile(path.join(cwd, '.crew', 'meeting.yaml'), stringify(config), 'utf8');
  await writeFile(path.join(cwd, '.crew', 'tasks', 'task.yaml'), stringify({
    goal: '会审进行时仍可运行一个独立接力任务。',
    roles: { builder: { tool: 'mock', model: 'builder' }, reviewer: { tool: 'mock', model: 'reviewer' } },
    flow: [{ loop: ['build', 'review'] }],
  }), 'utf8');
  if (options.decisions !== undefined) await writeFile(path.join(cwd, 'DECISIONS.md'), options.decisions, 'utf8');
  const scriptFile = path.join(cwd, '.local', 'mock.json');
  await writeFile(scriptFile, JSON.stringify(script), 'utf8');
  await git(cwd, ['init', '-b', 'main']);
  await git(cwd, ['config', 'user.name', 'Crew Meeting Test']);
  await git(cwd, ['config', 'user.email', 'crew-meeting-test@example.invalid']);
  await git(cwd, ['config', 'core.autocrlf', 'false']);
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', 'initial']);
  const initialCommit = await git(cwd, ['rev-parse', 'HEAD']);
  const original = process.env.CREW_MOCK_SCRIPT;
  process.env.CREW_MOCK_SCRIPT = scriptFile;
  const cli = async (args, overrides = {}) => {
    const logs = [];
    const code = await main(args, { cwd, log: value => logs.push(String(value)), notifyFn: async () => ({ ok: true }), retryDelayMs: 0, ...overrides });
    return { code, logs, output: logs.join('\n') };
  };
  const cursors = async () => JSON.parse(await readFile(`${scriptFile}.cursor.json`, 'utf8')).indices;
  const meetings = async () => {
    const base = path.join(cwd, '.crew', 'meetings');
    const entries = await readdir(base, { withFileTypes: true });
    const found = [];
    for (const item of entries) {
      if (!item.isDirectory()) continue;
      const directory = path.join(base, item.name);
      const file = path.join(directory, 'meeting.json');
      found.push({ directory, file, state: JSON.parse(await readFile(file, 'utf8')) });
    }
    return found.sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt) || b.state.meetingId.localeCompare(a.state.meetingId));
  };
  const latest = async () => (await meetings())[0];
  try { await fn({ cwd, cli, cursors, meetings, latest, initialCommit }); }
  finally {
    if (original === undefined) delete process.env.CREW_MOCK_SCRIPT;
    else process.env.CREW_MOCK_SCRIPT = original;
  }
}

async function roundFile(meeting, relative) {
  assert.equal(typeof relative, 'string');
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(relative.includes('\\'), false);
  return readFile(path.join(meeting.directory, relative), 'utf8');
}
const outputFile = (meeting, n, participant) => meeting.state.rounds[n - 1].answers[participant].output;
const promptFile = (meeting, n, participant) => path.join(meeting.directory, path.dirname(outputFile(meeting, n, participant)), 'prompt.md');
async function waitUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(20);
  }
  throw new Error('等待会审中间状态超时。');
}

test('5a-1 三位只读参会者并行回答，问题、回答和总结记录完整', async () => {
  await fixture({ a: [answer('A 的独立建议', { delayMs: 1000 })], b: [answer('B 的独立建议', { delayMs: 1000 })], c: [answer('C 的独立建议', { delayMs: 1000 })], s: [summary('先完成验证')] }, {}, async ({ cwd, cli, latest, cursors, initialCommit }) => {
    await writeFile(path.join(cwd, 'dirty.txt'), '会审允许未提交的工作区。', 'utf8');
    const question = '中文会审问题\n第二行仍应保留。';
    const started = performance.now();
    const result = await cli(['ask', question, '--with', 'mock:a,mock:b,mock:c']);
    const elapsedMs = performance.now() - started;
    assert.equal(result.code, 0, result.output);
    assert.ok(elapsedMs < 2750, `三位各等待 1000ms 的参会者应并行，实际总耗时 ${Math.round(elapsedMs)}ms。`);
    const meeting = await latest();
    assert.equal(meeting.state.rounds.length, 1);
    const round = meeting.state.rounds[0];
    assert.equal(round.status, 'done');
    assert.equal(await roundFile(meeting, round.question), question);
    for (const id of ['mock-a', 'mock-b', 'mock-c']) {
      assert.equal(round.answers[id].status, 'ok');
      await roundFile(meeting, round.answers[id].output);
      const step = path.dirname(path.join(meeting.directory, round.answers[id].output));
      for (const filename of ['prompt.md', 'output.md', 'raw.log', 'stderr.log', 'meta.json']) await access(path.join(step, filename));
      assert.equal(JSON.parse(await readFile(path.join(step, 'meta.json'), 'utf8')).mode, 'read');
    }
    assert.equal(round.summary.status, 'ok');
    assert.match(await roundFile(meeting, round.summary.output), /一致[\s\S]*分歧[\s\S]*推荐[\s\S]*决议草稿/);
    await access(path.join(meeting.directory, 'events.log'));
    assert.deepEqual(await cursors(), { a: 1, b: 1, c: 1, s: 1 });
    assert.equal(await git(cwd, ['branch', '--show-current']), 'main');
    assert.equal(await git(cwd, ['rev-parse', 'HEAD']), initialCommit);
  });
});

test('5a-2 超时与额度失败不影响成功回答，总结列出失败状态且额度不重试', async () => {
  await fixture({
    a: [answer('超时', { timedOut: true }), answer('再次超时', { timedOut: true })],
    b: [answer('额度不足', { quotaHit: true })], c: [answer('SUCCESS_C_ONLY')], s: [summary('保留 C 的建议')],
  }, {}, async ({ cli, latest, cursors }) => {
    const result = await cli(['ask', '比较可行方案']);
    assert.equal(result.code, 0, result.output);
    const meeting = await latest();
    const round = meeting.state.rounds[0];
    assert.equal(round.status, 'done');
    assert.equal(round.answers['mock-a'].status, 'timeout');
    assert.equal(round.answers['mock-b'].status, 'quota');
    assert.equal(round.answers['mock-c'].status, 'ok');
    assert.equal(await roundFile(meeting, round.answers['mock-c'].output), 'SUCCESS_C_ONLY');
    const summaryPrompt = await readFile(path.join(meeting.directory, 'rounds', 'r1', 'summary', 'prompt.md'), 'utf8');
    assert.ok(summaryPrompt.includes(round.answers['mock-c'].output) || summaryPrompt.includes(path.basename(path.dirname(round.answers['mock-c'].output))));
    assert.match(summaryPrompt, /mock-a[^\n]*(timeout|超时)/);
    assert.match(summaryPrompt, /mock-b[^\n]*(quota|额度)/);
    assert.doesNotMatch(summaryPrompt, /mock-a[^\n]*output\.md|mock-b[^\n]*output\.md/);
    assert.deepEqual(await cursors(), { a: 2, b: 1, c: 1, s: 1 });
  });
});

test('5a-3 全部失败时状态 failed、退出 2、跳过总结', async () => {
  await fixture({ a: [answer('额度不足', { quotaHit: true })], b: [answer('额度不足', { quotaHit: true })], c: [answer('额度不足', { quotaHit: true })], s: [summary('不应执行')] }, {}, async ({ cli, latest, cursors }) => {
    const result = await cli(['ask', '全部失败问题']);
    assert.equal(result.code, 2);
    const meeting = await latest();
    const round = meeting.state.rounds[0];
    assert.equal(round.status, 'failed');
    assert.ok(!round.summary?.output);
    assert.equal((await cursors()).s, undefined);
    await assert.rejects(access(path.join(meeting.directory, 'rounds', 'r1', 'summary.md')), { code: 'ENOENT' });
  });
});

test('5a-4 --to 可使用最近会审，只追问目标且各人历史互不混入', async () => {
  await fixture({ a: [answer('A_PRIVATE_R1'), answer('A_PRIVATE_R2'), answer('A_PRIVATE_R3')], b: [answer('B_PRIVATE_R1'), answer('B_PRIVATE_R3')], c: [answer('C_PRIVATE_R1'), answer('C_PRIVATE_R3')], s: [summary('初轮总结')] }, {}, async ({ cli, latest, cursors }) => {
    assert.equal((await cli(['ask', 'FIRST_SHARED_QUESTION'])).code, 0);
    const first = await latest();
    assert.equal((await cli(['ask', 'ONLY_A_FOLLOWUP', '--to', 'mock-a', '--no-summary'])).code, 0);
    const second = await latest();
    assert.equal(second.state.meetingId, first.state.meetingId);
    assert.deepEqual(second.state.rounds[1].to, ['mock-a']);
    assert.deepEqual(await cursors(), { a: 2, b: 1, c: 1, s: 1 });
    const prompt = await readFile(promptFile(second, 2, 'mock-a'), 'utf8');
    assert.match(prompt, /FIRST_SHARED_QUESTION/);
    assert.match(prompt, /A_PRIVATE_R1/);
    assert.doesNotMatch(prompt, /B_PRIVATE_R1|C_PRIVATE_R1/);
    assert.equal((await cli(['ask', 'THIRD_SHARED_QUESTION', '--meeting', first.state.meetingId, '--no-summary'])).code, 0);
    const third = await latest();
    for (const id of ['mock-b', 'mock-c']) {
      const otherPrompt = await readFile(promptFile(third, 3, id), 'utf8');
      assert.doesNotMatch(otherPrompt, /ONLY_A_FOLLOWUP|A_PRIVATE_R2/);
      assert.match(otherPrompt, /FIRST_SHARED_QUESTION/);
    }
  });
});

test('5a-5 超过 60000 字符时保留首轮和最近完整回答，中间回答改为问题与记录路径', async () => {
  const firstAnswer = `FIRST_COMPLETE_${'A'.repeat(22000)}`;
  const middleAnswer = `MIDDLE_MUST_BE_OMITTED_${'B'.repeat(25000)}`;
  const recentAnswer = `RECENT_COMPLETE_${'C'.repeat(25000)}`;
  await fixture({ a: [answer(firstAnswer), answer(middleAnswer), answer(recentAnswer), answer('第四轮答案')] }, { config: { participants: [{ tool: 'mock', model: 'a' }] } }, async ({ cli, latest }) => {
    assert.equal((await cli(['ask', 'FIRST_QUESTION', '--no-summary'])).code, 0);
    const meetingId = (await latest()).state.meetingId;
    for (const question of ['MIDDLE_QUESTION', 'RECENT_QUESTION', 'FOURTH_QUESTION']) {
      assert.equal((await cli(['ask', question, '--meeting', meetingId, '--no-summary'])).code, 0);
    }
    const meeting = await latest();
    const prompt = await readFile(promptFile(meeting, 4, 'mock'), 'utf8');
    assert.ok(prompt.includes(firstAnswer));
    assert.ok(prompt.includes(recentAnswer));
    assert.match(prompt, /MIDDLE_QUESTION/);
    assert.doesNotMatch(prompt, /MIDDLE_MUST_BE_OMITTED/);
    assert.match(prompt, /省略/);
    assert.ok(prompt.includes(meetingId));
    assert.match(prompt, /完整记录|完整.*见/);
    assert.ok(prompt.length < 61000, `省略后的提示词长度为 ${prompt.length}`);
  });
});

test('5a-6 中断保留已完成回答，--retry 只补跑未成功者并总结', async () => {
  await fixture({ a: [answer('A_ALREADY_FINISHED', { delayMs: 10 })], b: [answer('B_INTERRUPTED', { delayMs: 5000 }), answer('B_RETRIED')], c: [answer('C_INTERRUPTED', { delayMs: 5000 }), answer('C_RETRIED')], s: [summary('重试后的总结')] }, {}, async ({ cli, latest, cursors }) => {
    const controller = new AbortController();
    let settled = false;
    const running = cli(['ask', '中断恢复问题'], { signal: controller.signal }).finally(() => { settled = true; });
    running.catch(() => {});
    try {
      await waitUntil(async () => {
        let meeting;
        try { meeting = await latest(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        return meeting?.state.rounds[0]?.answers['mock-a']?.status === 'ok';
      });
      controller.abort();
      assert.equal((await running).code, 2);
      const interrupted = await latest();
      assert.equal(interrupted.state.rounds[0].status, 'interrupted');
      assert.equal(interrupted.state.rounds[0].answers['mock-a'].status, 'ok');
      assert.equal((await cli(['ask', '--retry'])).code, 0);
      const completed = await latest();
      assert.equal(completed.state.rounds.length, 1);
      assert.equal(completed.state.rounds[0].status, 'done');
      assert.equal(await roundFile(completed, outputFile(completed, 1, 'mock-a')), 'A_ALREADY_FINISHED');
      assert.equal(completed.state.rounds[0].summary.status, 'ok');
      assert.deepEqual(await cursors(), { a: 1, b: 2, c: 2, s: 1 });
    } finally {
      if (!settled) { controller.abort(); await running.catch(() => {}); }
    }
  });
});

test('5a-7 --with 校验报字段错误，追问名单固定，配置未知字段有警告', async () => {
  await fixture({ a: [answer('A')], b: [answer('B')], c: [answer('C')], s: [summary('总结')] }, { config: { unknown_option: 1 } }, async ({ cli, latest }) => {
    for (const withValue of ['unknown:a', 'mock:a,mock:a', 'mock:a_b,mock:a-b']) {
      await assert.rejects(cli(['ask', '坏参会者', '--with', withValue]), /with|participants|工具|编号|重复/);
    }
    const first = await cli(['ask', '合法参会者']);
    assert.equal(first.code, 0, first.output);
    assert.match(first.output, /unknown_option/);
    const meeting = await latest();
    await assert.rejects(cli(['ask', '追问', '--meeting', meeting.state.meetingId, '--with', 'mock:a']), /with|参会者|名单/);
  });
});

test('5a-8 决议先预览，确认后按最大编号追加，采纳最近一次成功回答', async () => {
  const existing = '# 项目决议\n\n## D-004 旧决定\n旧内容\n\n## D-012 最新编号\n保留且没有末尾换行';
  await fixture({ a: [answer('A_FIRST_SUCCESS'), answer('A_LATEST_SUCCESS'), answer('失败', { exitCode: 1 }), answer('再次失败', { exitCode: 1 })], b: [answer('B_FIRST_SUCCESS')] }, { decisions: existing, config: { participants: [{ tool: 'mock', model: 'a' }, { tool: 'mock', model: 'b' }] } }, async ({ cwd, cli, latest }) => {
    assert.equal((await cli(['ask', '初轮', '--no-summary'])).code, 0);
    const meetingId = (await latest()).state.meetingId;
    assert.equal((await cli(['ask', '成功追问', '--to', 'mock-a', '--no-summary'])).code, 0);
    assert.equal((await cli(['ask', '失败追问', '--to', 'mock-a', '--no-summary'])).code, 2);
    const preview = await cli(['decide', '--adopt', 'mock-a', '--title', '采纳 A']);
    assert.equal(preview.code, 0);
    assert.match(preview.output, /A_LATEST_SUCCESS/);
    assert.match(preview.output, /--yes/);
    assert.equal(await readFile(path.join(cwd, 'DECISIONS.md'), 'utf8'), existing);
    assert.equal((await latest()).state.decisions.length, 0);
    const written = await cli(['decide', meetingId, '--adopt', 'mock-a', '--title', '采纳 A', '--yes']);
    assert.equal(written.code, 0, written.output);
    const content = await readFile(path.join(cwd, 'DECISIONS.md'), 'utf8');
    assert.ok(content.startsWith(existing));
    assert.match(content, /\n\n## D-013 采纳 A/);
    const added = content.slice(existing.length);
    assert.match(added, /状态：Active/);
    assert.match(added, /采纳自 mock-a（第 2 轮）/);
    assert.match(added, /A_LATEST_SUCCESS/);
    assert.doesNotMatch(added, /A_FIRST_SUCCESS|B_FIRST_SUCCESS/);
    const decision = (await latest()).state.decisions[0];
    assert.equal(decision.id, 'D-013');
    assert.equal(decision.adoptedFrom, 'mock-a');
    assert.equal(decision.round, 2);
    assert.match(written.output, /git add DECISIONS\.md.*git commit -m "Add decision D-013"/);
  });
  await fixture({ a: [answer('只有一位参会者')] }, { config: { participants: [{ tool: 'mock', model: 'a' }] } }, async ({ cwd, cli, latest }) => {
    assert.equal((await cli(['ask', '新项目决议', '--no-summary'])).code, 0);
    await assert.rejects(access(path.join(cwd, 'DECISIONS.md')), { code: 'ENOENT' });
    assert.equal((await cli(['decide', '--text', '由我直接决定采用简单方案', '--yes'])).code, 0);
    assert.match(await readFile(path.join(cwd, 'DECISIONS.md'), 'utf8'), /^## D-001 /);
    assert.equal((await latest()).state.decisions[0].id, 'D-001');
  });
});

test('5a-9 决议本已写而 JSON 失败时，下次补记且不重复追加', async () => {
  await fixture({ a: [answer('A')] }, { config: { participants: [{ tool: 'mock', model: 'a' }] } }, async ({ cwd, cli, latest }) => {
    assert.equal((await cli(['ask', '事务恢复', '--no-summary'])).code, 0);
    let writes = 0;
    const args = ['decide', '--text', '只追加一次的事务决议', '--title', '事务恢复', '--yes'];
    await assert.rejects(cli(args, { saveMeetingFn: async () => { writes += 1; throw new Error('INJECTED_MEETING_WRITE_FAILURE'); } }), /INJECTED_MEETING_WRITE_FAILURE/);
    assert.equal(writes, 1);
    const decisionsPath = path.join(cwd, 'DECISIONS.md');
    const once = await readFile(decisionsPath, 'utf8');
    assert.equal((once.match(/^## D-\d+/gm) ?? []).length, 1);
    assert.equal((await latest()).state.decisions.length, 0);
    assert.equal((await cli(args)).code, 0);
    assert.equal(await readFile(decisionsPath, 'utf8'), once);
    const records = (await latest()).state.decisions;
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'D-001');
  });
});

test('5a-10 同会审写锁互斥，会审进行时仍能取得 crew run 项目锁', async () => {
  await fixture({ a: [answer('初轮完成'), answer('长追问完成', { delayMs: 2000 })], builder: [answer('实现完成', { files: { 'value.txt': '同时运行成功\n' } })], reviewer: [answer('VERDICT: APPROVED')] }, { config: { participants: [{ tool: 'mock', model: 'a' }] } }, async ({ cwd, cli, latest }) => {
    assert.equal((await cli(['ask', '初轮', '--no-summary'])).code, 0);
    const meetingId = (await latest()).state.meetingId;
    const controller = new AbortController();
    let settled = false;
    const holding = cli(['ask', '持有写锁的追问', '--meeting', meetingId, '--no-summary'], { signal: controller.signal }).finally(() => { settled = true; });
    holding.catch(() => {});
    try {
      await waitUntil(async () => {
        const latestRound = (await latest()).state.rounds.at(-1);
        return latestRound.n === 2 && latestRound.status === 'running';
      });
      await assert.rejects(cli(['ask', '应被锁拒绝', '--meeting', meetingId, '--no-summary']), /这个会审正在进行/);
      const run = await cli(['run', 'task']);
      assert.equal(run.code, 0, run.output);
      assert.equal(await readFile(path.join(cwd, 'value.txt'), 'utf8'), '同时运行成功\n');
      assert.equal((await holding).code, 0);
    } finally {
      if (!settled) { controller.abort(); await holding.catch(() => {}); }
    }
  });
});

test('5a-11 meeting --json 与磁盘一致，meetings 按更新时间倒序', async () => {
  await fixture({ a: [answer('第一次回答'), answer('第二次回答')] }, { config: { participants: [{ tool: 'mock', model: 'a' }] } }, async ({ cli, latest, meetings }) => {
    assert.equal((await cli(['ask', '第一个会审', '--no-summary'])).code, 0);
    const first = await latest();
    assert.equal((await cli(['ask', '第二个会审', '--no-summary'])).code, 0);
    const all = await meetings();
    const second = all.find(meeting => meeting.state.meetingId !== first.state.meetingId);
    assert.ok(second);
    first.state.updatedAt = '2050-01-01T00:00:00.000Z';
    second.state.updatedAt = '2000-01-01T00:00:00.000Z';
    await writeFile(first.file, JSON.stringify(first.state), 'utf8');
    await writeFile(second.file, JSON.stringify(second.state), 'utf8');
    const json = await cli(['meeting', first.state.meetingId, '--json']);
    assert.equal(json.code, 0);
    assert.deepEqual(JSON.parse(json.output), first.state);
    const list = await cli(['meetings']);
    assert.equal(list.code, 0);
    const firstIndex = list.output.indexOf(first.state.meetingId), secondIndex = list.output.indexOf(second.state.meetingId);
    assert.ok(firstIndex >= 0 && secondIndex >= 0);
    assert.ok(firstIndex < secondIndex);
  });
});

test('文件提问保留多行中文，可换总结模型，决议可在 dry-run 预览', async () => {
  await fixture({ a: [answer('保留暂停状态。')], s: [summary('恢复后核对计时。')] },
    { config: { participants: [{ tool: 'mock', model: 'a' }] } }, async ({ cwd, cli, latest, cursors }) => {
      const question = '暂停后如何恢复？\r\n请列出需要验证的文件与行为。\r\n';
      await writeFile(path.join(cwd, 'question.md'), question, 'utf8');
      assert.equal((await cli(['ask', '--file', 'question.md', '--no-summary'])).code, 0);
      const meeting = await latest();
      const [round] = meeting.state.rounds;
      assert.equal(await roundFile(meeting, round.question), question);
      const prompt = await readFile(promptFile(meeting, 1, 'mock'), 'utf8');
      assert.match(prompt, /暂停后如何恢复？\r?\n请列出需要验证的文件与行为。/);
      assert.deepEqual(await cursors(), { a: 1 });
      assert.equal((await cli(['summarize', '--by', 'mock:s'])).code, 0);
      assert.deepEqual((await latest()).state.rounds[0].summary.by, { tool: 'mock', model: 's' });
      assert.deepEqual(await cursors(), { a: 1, s: 1 });
      assert.equal((await cli(['decide', '--adopt', 'mock', '--yes'])).code, 0);
      const reading = await cli(['meeting']);
      assert.match(reading.output, /## D-001 会审建议[\s\S]*采纳自 mock（第 1 轮）\n\n保留暂停状态。/);
      await writeFile(path.join(cwd, '.crew', 'tasks', 'design-preview.yaml'), stringify({
        goal: '预览决议',
        roles: { designer: { tool: 'mock' }, builder: { tool: 'mock' }, reviewer: { tool: 'mock', model: 'r' } },
        flow: ['design', { loop: ['build', 'review'] }],
      }), 'utf8');
      const preview = await cli(['run', 'design-preview', '--dry-run']);
      assert.match(preview.output, /首棒：designer[\s\S]*DECISIONS\.md[\s\S]*## D-001 会审建议/);
      assert.deepEqual(await cursors(), { a: 1, s: 1 });
    });
});
