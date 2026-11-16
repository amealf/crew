import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, readFile, access, readdir } from 'node:fs/promises';
import spawn from 'cross-spawn';
import { execute } from '../src/adapters/process.js';
import { git, preflight, head, currentBranch, createBranch, assertBranch, commitBuild, writeDiff, restoreRound } from '../src/gitops.js';
import { atomicJson, createRun, loadRun, saveState, event, nextStepDir, acquireLock } from '../src/runlog.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const parent = path.join(root, '.local', 'tests');
await mkdir(parent, { recursive: true });

async function command(cwd, args) {
  const result = await execute('git', args, { cwd, timeoutMs: 15_000 });
  assert.equal(result.exitCode, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

async function repository({ ignore = true } = {}) {
  const cwd = await mkdtemp(path.join(parent, 'git-runlog-'));
  await command(cwd, ['init', '-b', 'main']);
  await command(cwd, ['config', '--local', 'user.name', 'Crew Test']);
  await command(cwd, ['config', '--local', 'user.email', 'crew-test@example.invalid']);
  await command(cwd, ['config', '--local', 'core.autocrlf', 'false']);
  await mkdir(path.join(cwd, '.crew', 'tasks'), { recursive: true });
  await writeFile(path.join(cwd, '.crew', 'tasks', 'demo.yaml'), 'goal: 中文任务\nroles: {}\nflow: []\n', 'utf8');
  await writeFile(path.join(cwd, 'source.txt'), 'base\n', 'utf8');
  if (ignore) await writeFile(path.join(cwd, '.gitignore'), '.crew/runs/\n', 'utf8');
  await command(cwd, ['add', '-A']);
  await command(cwd, ['commit', '-m', 'seed']);
  return cwd;
}

test('preflight 拒绝非仓库、未初始化、子目录和脏工作区', async () => {
  const blank = await mkdtemp(path.join(parent, 'blank-'));
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = parent;
  try { await assert.rejects(preflight(blank), /git init/); }
  finally {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  }
  await command(blank, ['init']);
  await assert.rejects(preflight(blank), /初始提交/);
  const cwd = await repository();
  await assert.rejects(preflight(path.join(cwd, '.crew')), /根目录/);
  await writeFile(path.join(cwd, 'source.txt'), 'dirty', 'utf8');
  await assert.rejects(preflight(cwd), /工作区有未提交/);
});

test('preflight 自动提交忽略规则，允许尚未忽略的本次锁记录', async () => {
  const cwd = await repository({ ignore: false });
  const initial = await head(cwd);
  const release = await acquireLock(cwd);
  try {
    const ready = await preflight(cwd);
    assert.notEqual(ready.baseCommit, initial);
    assert.equal(ready.branch, 'main');
    assert.match(await readFile(path.join(cwd, '.gitignore'), 'utf8'), /\.crew\/runs\//);
    assert.equal((await git(cwd, ['log', '-1', '--format=%s'])).trim(), 'crew: ignore run records');
    assert.equal((await preflight(cwd)).baseCommit, ready.baseCommit);
    assert.equal(await git(cwd, ['status', '--porcelain']), '');
  } finally { await release(); }
});

test('每轮提交留在新分支，累计 diff 包含所有轮次，commit 幂等', async () => {
  const cwd = await repository();
  const { baseCommit } = await preflight(cwd);
  await createBranch(cwd, 'crew/test');
  await assertBranch(cwd, 'crew/test');
  await assert.rejects(assertBranch(cwd, 'main'), /git switch main/);
  await writeFile(path.join(cwd, 'source.txt'), 'round one\n', 'utf8');
  const one = await commitBuild(cwd, 1, { baseCommit });
  assert.equal(one.changedFiles, 1);
  assert.deepEqual(await commitBuild(cwd, 1, { baseCommit }), one);
  assert.deepEqual(await commitBuild(cwd, 2, { baseCommit: one.commit }), { commit: one.commit, changedFiles: 0 });
  await writeFile(path.join(cwd, '中文.txt'), '第二轮\n', 'utf8');
  const two = await commitBuild(cwd, 2, { baseCommit: one.commit });
  assert.equal(two.changedFiles, 1);
  const file = await writeDiff(cwd, baseCommit, '.crew/runs/test/checks/diff-2.patch');
  const patch = await readFile(file, 'utf8');
  assert.match(patch, /round one/);
  assert.match(patch, /第二轮/);
  assert.equal((await git(cwd, ['rev-parse', 'main'])).trim(), baseCommit);
  assert.equal(await currentBranch(cwd), 'crew/test');
  assert.equal((await git(cwd, ['log', `${baseCommit}..HEAD`, '--format=%s'])).trim(), 'crew: round 2 build\ncrew: round 1 build');
  await assert.rejects(git(cwd, ['push']), /不允许/);
  await assert.rejects(git(cwd, ['reset', '--hard', baseCommit]), /仅允许/);
});

test('回滚先保留暂存、未暂存、新文件与原提交，再恢复本轮起点', async () => {
  const cwd = await repository();
  const base = await head(cwd);
  await createBranch(cwd, 'crew/rollback');
  await writeFile(path.join(cwd, 'source.txt'), 'staged\n', 'utf8');
  await git(cwd, ['add', '--', 'source.txt']);
  await writeFile(path.join(cwd, 'source.txt'), 'latest unfinished\n', 'utf8');
  await mkdir(path.join(cwd, 'new'), { recursive: true });
  await writeFile(path.join(cwd, 'new', 'new.txt'), 'recover me', 'utf8');
  const restored = await restoreRound(cwd, base, '.crew/runs/test/recovery');
  assert.equal(await readFile(path.join(cwd, 'source.txt'), 'utf8'), 'base\n');
  await assert.rejects(access(path.join(cwd, 'new', 'new.txt')));
  assert.equal(await readFile(path.join(restored.recoveryDir, 'files', 'source.txt'), 'utf8'), 'latest unfinished\n');
  assert.equal(await readFile(path.join(restored.recoveryDir, 'files', 'new', 'new.txt'), 'utf8'), 'recover me');
  assert.match(await readFile(path.join(restored.recoveryDir, 'staged.patch'), 'utf8'), /staged/);
  assert.equal(await git(cwd, ['status', '--porcelain']), '');
  await writeFile(path.join(cwd, 'source.txt'), 'committed before checkpoint\n', 'utf8');
  const built = await commitBuild(cwd, 1, { baseCommit: base });
  const recovery = await restoreRound(cwd, base, '.crew/runs/test/recovery');
  assert.equal(await head(cwd), base);
  assert.equal(await readFile(path.join(cwd, 'source.txt'), 'utf8'), 'base\n');
  const manifest = JSON.parse(await readFile(path.join(recovery.recoveryDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.originalHead, built.commit);
  assert.equal(await readFile(path.join(recovery.recoveryDir, 'files', 'source.txt'), 'utf8'), 'committed before checkpoint\n');
});

test('运行目录保存任务快照、原子状态、递增步骤和事件，latest 跳过 doctor', async () => {
  const cwd = await repository();
  const taskPath = path.join(cwd, '.crew', 'tasks', 'demo.yaml');
  const run = await createRun(cwd, 'demo', taskPath, { flow: ['design', { loop: ['build', 'review'] }] });
  assert.equal(run.state.nextStep, 'design');
  assert.match(run.state.runId, /^demo-\d{8}-\d{6}/);
  await writeFile(taskPath, 'changed source', 'utf8');
  assert.match(await readFile(path.join(run.runDir, 'task.yaml'), 'utf8'), /中文任务/);
  const first = await nextStepDir(run.runDir, run.state, 'design');
  const second = await nextStepDir(run.runDir, run.state, 'build');
  assert.equal(path.basename(first), '01-design');
  assert.equal(path.basename(second), '02-build');
  // A directory can survive a crash immediately before its state checkpoint.
  await mkdir(path.join(run.runDir, 'steps', '03-review'));
  assert.equal(path.basename(await nextStepDir(run.runDir, run.state, 'review')), '04-review');
  run.state.nextStep = 'check';
  await saveState(run.runDir, run.state);
  await event(run.runDir, { step: 'build', round: 1, result: 'ok', durationMs: 10 });
  assert.equal(JSON.parse((await readFile(path.join(run.runDir, 'events.log'), 'utf8')).trim()).step, 'build');
  await mkdir(path.join(cwd, '.crew', 'runs', 'doctor-9999'));
  assert.equal((await loadRun(cwd)).state.runId, run.state.runId);
  assert.equal((await loadRun(cwd, run.state.runId)).state.nextStep, 'check');
  const secondRun = await createRun(cwd, 'demo', taskPath, { flow: [{ loop: ['build', 'review'] }] });
  assert.notEqual(secondRun.state.runId, run.state.runId);
  assert.equal((await loadRun(cwd)).state.runId, secondRun.state.runId);
  await assert.rejects(loadRun(cwd, '../outside'), /运行编号/);
  const file = path.join(run.runDir, 'parallel.json');
  await Promise.all(Array.from({ length: 8 }, (_, n) => atomicJson(file, { n })));
  assert.ok(Number.isInteger(JSON.parse(await readFile(file, 'utf8')).n));
  assert.equal((await readdir(run.runDir)).some(name => name.includes('.tmp-')), false);
});

test('运行锁互斥、释放可重复，死进程自动让出锁，记录文件保留', async () => {
  const cwd = await repository();
  const release = await acquireLock(cwd);
  await assert.rejects(acquireLock(cwd), /已有 crew 运行中/);
  await release();
  await release();
  assert.equal(JSON.parse(await readFile(path.join(cwd, '.crew', 'runs', 'lock.json'), 'utf8')), null);
  const moduleUrl = new URL('../src/runlog.js', import.meta.url).href;
  const script = `import {acquireLock} from ${JSON.stringify(moduleUrl)}; await acquireLock(process.cwd()); console.log('READY'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('READY')) resolve(); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`lock child exited ${code}`)));
  });
  await assert.rejects(acquireLock(cwd), /已有 crew 运行中/);
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('close', resolve));
  const reacquired = await acquireLock(cwd);
  await reacquired();
});

test('首份状态完整记录初始化起点，点号任务名可创建并恢复', async () => {
  const cwd = await repository();
  const taskPath = path.join(cwd, '.crew', 'tasks', 'demo.yaml');
  const baseCommit = await head(cwd);
  const originalBranch = await currentBranch(cwd);
  const run = await createRun(cwd, 'demo.v2', taskPath, { flow: ['design', { loop: ['build', 'review'] }] }, { originalBranch, baseCommit });
  const diskState = JSON.parse(await readFile(path.join(run.runDir, 'state.json'), 'utf8'));
  assert.equal(diskState.task, 'demo.v2');
  assert.equal(diskState.nextStep, 'initialize');
  assert.equal(diskState.initialNextStep, 'design');
  assert.equal(diskState.originalBranch, originalBranch);
  assert.equal(diskState.baseCommit, baseCommit);
  assert.equal(diskState.branch, `crew/${run.state.runId}`);
  assert.deepEqual((await loadRun(cwd, run.state.runId)).state, diskState);
  assert.equal(await currentBranch(cwd), originalBranch);
  const loopOnly = await createRun(cwd, 'demo.v3', taskPath, { flow: [{ loop: ['build', 'review'] }] }, { originalBranch, baseCommit });
  assert.equal(loopOnly.state.initialNextStep, 'build');
  for (const name of ['.', '..']) await assert.rejects(createRun(cwd, name, taskPath, { flow: [] }), /任务名/);
  await assert.rejects(createRun(cwd, 'demo', taskPath, { flow: [] }, {}), /originalBranch.*baseCommit/);
});
