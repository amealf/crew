import path from 'node:path';
import { mkdir, readFile, writeFile, realpath, lstat, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execute } from './adapters/process.js';
import { projectPath } from './paths.js';

const allowedCommands = new Set(['rev-parse', 'status', 'check-ignore', 'add', 'commit', 'switch', 'diff', 'ls-files', 'ls-tree', 'restore', 'reset', 'log', 'check-ref-format']);

export async function git(cwd, args, { signal, timeoutMs = 60_000 } = {}) {
  if (!allowedCommands.has(args[0])) throw new Error(`调度器不允许执行 git ${args[0]}。`);
  if (args[0] === 'reset' && (args[1] !== '--soft' || args.length !== 3)) throw new Error('调度器仅允许保留文件的 git reset --soft。');
  const result = await execute('git', ['-c', 'core.quotepath=false', ...args], { cwd, timeoutMs, signal });
  if (result.exitCode !== 0 || result.error || result.timedOut || result.interrupted) {
    const error = new Error(`git ${args[0]} 失败：${result.error || result.stderr.trim() || result.stdout.trim() || '命令未完成'}。请检查仓库状态和 git 配置后重试。`);
    error.exitCode = result.exitCode;
    error.interrupted = result.interrupted;
    error.timedOut = result.timedOut;
    throw error;
  }
  return result.stdout;
}

export const head = async cwd => (await git(cwd, ['rev-parse', 'HEAD'])).trim();
export const currentBranch = async cwd => (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

function splitPaths(text) { return text.split('\0').filter(Boolean); }
function parseStatus(text) {
  const fields = text.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i += 1) {
    if (!fields[i]) continue;
    const code = fields[i].slice(0, 2);
    const file = fields[i].slice(3);
    const oldFile = /[RC]/.test(code) ? fields[++i] : null;
    entries.push({ code, file, ...(oldFile ? { oldFile } : {}) });
  }
  return entries;
}

export async function preflight(cwd) {
  let top;
  try { top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); }
  catch { throw new Error('当前目录不是 git 仓库。请先运行 git init，并提交项目初始文件，再从项目根目录运行 crew。'); }
  const actualRoot = await realpath(cwd);
  const actualTop = await realpath(top);
  const samePath = process.platform === 'win32' ? actualRoot.toLowerCase() === actualTop.toLowerCase() : actualRoot === actualTop;
  if (!samePath) throw new Error(`请从 git 仓库根目录运行 crew：${actualTop}`);
  try { await head(cwd); }
  catch { throw new Error('仓库还没有初始提交。请先执行 git add -A 和 git commit，再运行 crew。'); }
  const entries = parseStatus(await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  // An acquired scheduler lock can exist before the ignore rule is installed.
  const dirty = entries.filter(entry => !(entry.code === '??' && entry.file.startsWith('.crew/runs/')));
  if (dirty.length) throw new Error(`工作区有未提交的改动：${dirty.map(entry => entry.file).join('、')}。请先提交或暂存这些改动（git stash），再运行 crew。`);
  const trackedLogs = splitPaths(await git(cwd, ['ls-files', '-z', '--', '.crew/runs/']));
  if (trackedLogs.length) throw new Error('运行记录 .crew/runs/ 已被 git 跟踪。请先用 git rm --cached -r .crew/runs 取消跟踪并提交，再运行 crew。');
  let ignored = false;
  try { await git(cwd, ['check-ignore', '-q', '--', '.crew/runs/__crew_ignore_probe__']); ignored = true; }
  catch (error) { if (error.exitCode !== 1) throw error; }
  if (!ignored) {
    const ignorePath = await projectPath(cwd, '.gitignore');
    let text = '';
    try { text = await readFile(ignorePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(ignorePath, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.crew/runs/\n`, 'utf8');
    await git(cwd, ['add', '--', '.gitignore']);
    await git(cwd, ['commit', '--only', '-m', 'crew: ignore run records', '--', '.gitignore']);
  }
  return { baseCommit: await head(cwd), branch: await currentBranch(cwd) };
}

export async function createBranch(cwd, name) {
  if (!name.startsWith('crew/')) throw new Error('运行分支必须以 crew/ 开头。');
  await git(cwd, ['check-ref-format', '--branch', name]);
  await git(cwd, ['switch', '-c', name]);
  return name;
}

export async function assertBranch(cwd, expected) {
  const actual = await currentBranch(cwd);
  if (actual !== expected) throw new Error(`当前分支为 ${actual}，运行记录要求 ${expected}。请先执行 git switch ${expected}，再继续。`);
}

export async function commitBuild(cwd, round, { baseCommit } = {}) {
  const current = await head(cwd);
  const message = `crew: round ${round} build`;
  if (baseCommit && current !== baseCommit) {
    const parent = (await git(cwd, ['rev-parse', 'HEAD^'])).trim();
    const subject = (await git(cwd, ['log', '-1', '--format=%s'])).trim();
    if (parent !== baseCommit || subject !== message) throw new Error('HEAD 与本轮起点不一致。请检查运行分支的额外提交，再执行 crew resume。');
    const dirty = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (dirty) throw new Error('本轮提交已经存在，但工作区又有未提交改动。请先保存这些改动，再执行 crew resume。');
    const changedFiles = splitPaths(await git(cwd, ['diff', '--name-only', '-z', baseCommit, current, '--'])).length;
    return { commit: current, changedFiles };
  }
  await git(cwd, ['add', '-A']);
  const changedFiles = splitPaths(await git(cwd, ['diff', '--cached', '--name-only', '-z', '--'])).length;
  if (!changedFiles) return { commit: current, changedFiles: 0 };
  await git(cwd, ['commit', '-m', message]);
  return { commit: await head(cwd), changedFiles };
}

export async function writeDiff(cwd, baseCommit, filePath) {
  const target = await projectPath(cwd, filePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await git(cwd, ['diff', '--binary', `${baseCommit}..HEAD`, '--']), 'utf8');
  return target;
}

export async function restoreRound(cwd, commit, recoveryDir) {
  // Resolve the commit before moving any files. Preserve HEAD and both diff layers.
  const targetCommit = (await git(cwd, ['rev-parse', '--verify', `${commit}^{commit}`])).trim();
  const originalHead = await head(cwd);
  const root = await realpath(cwd);
  const recoveryRoot = await projectPath(cwd, recoveryDir);
  const recoveryRelative = path.relative(root, recoveryRoot).split(path.sep).join('/');
  if (!recoveryRelative.startsWith('.crew/runs/')) throw new Error('回滚恢复目录必须放在项目 .crew/runs/ 内。');
  const archive = await projectPath(cwd, path.join(recoveryRoot, `${Date.now()}-${randomUUID()}`));
  await mkdir(archive, { recursive: true });
  const status = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const changed = splitPaths(await git(cwd, ['diff', '--name-only', '-z', targetCommit, '--']));
  const untracked = splitPaths(await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
  const files = [...new Set([...changed, ...untracked])];
  const stagedPatch = await git(cwd, ['diff', '--cached', '--binary', '--']);
  const worktreePatch = await git(cwd, ['diff', '--binary', '--']);
  await writeFile(path.join(archive, 'staged.patch'), stagedPatch, 'utf8');
  await writeFile(path.join(archive, 'worktree.patch'), worktreePatch, 'utf8');
  await writeFile(path.join(archive, 'manifest.json'), JSON.stringify({ originalHead, targetCommit, status, files, createdAt: new Date().toISOString() }, null, 2), 'utf8');
  const movedDirectories = [];
  for (const file of files.sort((a, b) => a.length - b.length)) {
    if (file === '.git' || file.startsWith('.git/') || file.startsWith('.crew/runs/')) throw new Error(`回滚文件位于受保护目录：${file}`);
    if (movedDirectories.some(parent => file.startsWith(`${parent}/`))) continue;
    // Check the parent rather than following a final symlink. Moving a link does
    // not read or write its target, including a link to a missing external file.
    const parent = await projectPath(cwd, path.dirname(file));
    const source = path.join(parent, path.basename(file));
    let info;
    try { info = await lstat(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const destination = await projectPath(cwd, path.join(archive, 'files', file));
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(source, destination);
    if (info.isDirectory()) movedDirectories.push(file);
  }
  if (originalHead !== targetCommit) await git(cwd, ['reset', '--soft', targetCommit]);
  await git(cwd, ['restore', '--source', targetCommit, '--staged', '--worktree', '--', '.']);
  return { recoveryDir: archive, originalHead, commit: targetCommit };
}
