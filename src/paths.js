import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Check existing ancestors too: lexical checks alone permit a junction escape.
export async function projectPath(cwd, target) {
  const root = await realpath(cwd);
  const resolved = path.resolve(root, target);
  if (!inside(root, resolved)) throw new Error(`路径必须在项目目录内：${target}`);
  let current = resolved;
  while (true) {
    try {
      await lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      current = path.dirname(current);
      continue;
    }
    let actual;
    try { actual = await realpath(current); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`路径包含无法解析的符号链接：${target}`);
      throw error;
    }
    if (!inside(root, actual)) throw new Error(`路径通过符号链接指向项目外：${target}`);
    break;
  }
  return resolved;
}
