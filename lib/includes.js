import { statSync, readdirSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

/** 判断一个候选根目录能不能满足 TableGen 的 mlir/IR/OpBase.td include。 */
const OPBASE_RELATIVE = ['mlir', 'IR', 'OpBase.td'];

/** 该目录能否作为 -I 根（下面有 mlir/IR/OpBase.td）。 */
export function hasOpBase(dir) {
  try {
    return statSync(join(dir, ...OPBASE_RELATIVE)).isFile();
  } catch {
    return false;
  }
}

function safeReaddir(path) {
  try {
    return readdirSync(path).sort().slice(0, 20);
  } catch {
    return [];
  }
}

/**
 * 与 LLVM 安装/构建树同级的源码树候选：<父目录>/llvm-src/<任意>/mlir/include。
 * toolchain.json 一般只记录 llvmRoot/mlirRoot，源码树靠这条规则兜底。
 */
function sourceTreeRoots(base, add) {
  if (typeof base !== 'string' || base.trim() === '') return;
  const parents = [dirname(base), dirname(dirname(base))];
  for (const parent of parents) {
    const srcRoot = join(parent, 'llvm-src');
    for (const entry of safeReaddir(srcRoot)) {
      add(join(srcRoot, entry, 'mlir', 'include'));
    }
  }
}

/**
 * 从 mlir-tblgen 自身位置推导：<root>/bin/mlir-tblgen.exe → <root>/include、<root>/tools/mlir/include，
 * 以及 <root 的父目录>/llvm-src/* 源码树。没有 toolchain.json 时靠这条规则也能找到 OpBase.td。
 */
function toolRoots(resolved, add) {
  const paths = resolved !== null && resolved !== undefined && resolved.paths !== null && typeof resolved.paths === 'object'
    ? resolved.paths
    : {};
  const tblgen = paths['mlir-tblgen'];
  if (typeof tblgen !== 'string' || tblgen.trim() === '') return;
  const binDir = dirname(resolve(tblgen));
  const root = dirname(binDir);
  add(join(root, 'include'));
  add(join(root, 'tools', 'mlir', 'include'));
  add(join(binDir, '..', 'include'));
  sourceTreeRoots(binDir, add);
}

/** 从 toolchain.json 推导可能的 mlir/include 根，按可靠度排序。 */
function includeCandidateRoots(resolved) {
  const roots = [];
  const add = (path) => {
    if (typeof path !== 'string' || path.trim() === '') return;
    const abs = resolve(path);
    if (!roots.includes(abs)) roots.push(abs);
  };
  const dev = resolved !== null && resolved !== undefined && resolved.mlirDev !== null && typeof resolved.mlirDev === 'object'
    ? resolved.mlirDev
    : {};
  for (const key of ['include', 'lib', 'cmakeDir', 'llvmCmakeDir']) {
    const value = dev[key];
    if (typeof value !== 'string') continue;
    add(value);
    add(dirname(value));
    add(dirname(dirname(value)));
  }
  if (typeof resolved.llvmRoot === 'string') add(join(resolved.llvmRoot, 'include'));
  if (typeof resolved.mlirRoot === 'string') {
    add(join(resolved.mlirRoot, 'include'));
    add(join(resolved.mlirRoot, 'tools', 'mlir', 'include'));
  }
  sourceTreeRoots(resolved.llvmRoot, add);
  sourceTreeRoots(resolved.mlirRoot, add);
  toolRoots(resolved, add);
  return roots;
}

/**
 * 决定 TableGen 的 -I：显式 includeDirs / MLIR_INCLUDE_DIR 优先，
 * 其余候选按 OpBase.td 是否存在自动挑选。
 * @returns {{dirs: string[], auto: string[], searched: string[], source: 'config'|'auto'|'none'}}
 */
export function resolveIncludes(config, cwd, resolved) {
  const dirs = [];
  const auto = [];
  const searched = [];
  const push = (dir) => {
    const abs = resolve(cwd, dir);
    if (!dirs.includes(abs)) dirs.push(abs);
  };
  for (const dir of Array.isArray(config.includeDirs) ? config.includeDirs : []) {
    if (typeof dir === 'string' && dir.trim() !== '') push(dir.trim());
  }
  const env = typeof process.env.MLIR_INCLUDE_DIR === 'string' ? process.env.MLIR_INCLUDE_DIR : '';
  for (const dir of env.split(delimiter)) {
    if (dir.trim() !== '') push(dir.trim());
  }
  const explicit = dirs.length;
  const satisfied = dirs.some(hasOpBase);
  if (!satisfied) {
    for (const candidate of includeCandidateRoots(resolved)) {
      if (dirs.includes(candidate)) continue;
      searched.push(candidate);
      if (hasOpBase(candidate)) {
        auto.push(candidate);
        push(candidate);
      }
    }
  }
  const source = explicit > 0 ? 'config' : (auto.length > 0 ? 'auto' : 'none');
  return { dirs, auto, searched, source };
}

/** 缺 include 时的中文指引（td_check 与 td_scaffold 校验共用）。 */
export function includeHint(searched) {
  const sample = searched.length > 0 ? searched.slice(0, 8).join('、') : '（未找到候选目录）';
  return 'TableGen 找不到 include（多半是 mlir/IR/OpBase.td）。已搜索：' + sample + '。' +
    '修复：①给插件配 includeDirs；②或设环境变量 MLIR_INCLUDE_DIR；' +
    '③或把 MLIR 源码放在 <LLVM 安装/构建目录的父目录>/llvm-src/*/mlir/include。' +
    '典型值：<llvm-project>/mlir/include，命令行即 -I <llvm-project>/mlir/include。';
}
