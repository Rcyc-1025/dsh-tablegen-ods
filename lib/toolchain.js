import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverToolchain } from './config.js';

/** 本插件只需要 mlir-tblgen；其余路径只用于提示，不参与执行。 */
export const REQUIRED_TOOLS = ['mlir-tblgen'];

/** toolchain.json 里的键名 → 可执行文件名。 */
const TOOLCHAIN_TO_EXE = {
  mlirTblgen: 'mlir-tblgen',
};

/**
 * 读 toolchain.json；永不抛错（坏 JSON / 文件不存在都归一成 error 字符串）。
 * @param path - toolchain.json 路径或 null。
 */
export function loadToolchainFile(path) {
  if (typeof path !== 'string' || path.trim() === '') return { json: null, error: '未配置 toolchainPath' };
  if (!existsSync(path)) return { json: null, error: 'toolchain.json 不存在：' + path };
  try {
    return { json: JSON.parse(readFileSync(path, 'utf8')), error: null };
  } catch (error) {
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : String(error);
    return { json: null, error: 'toolchain.json 解析失败：' + message };
  }
}

/**
 * 解析「工具名 → 可执行文件绝对路径」。来源优先级：显式 mlirTblgenPath > toolchain.json。
 * 未使用 PATH 搜索：行为必须可预测。
 * @param config - resolveConfig 的结果。
 * @param cwd - 解析相对路径用。
 */
export function resolveTools(config, cwd) {
  const toolchainPath = typeof config.toolchainPath === 'string' && config.toolchainPath !== ''
    ? config.toolchainPath
    : discoverToolchain(cwd);
  const loaded = loadToolchainFile(toolchainPath);
  const json = loaded.json;
  const paths = {};
  const versions = {};
  const notes = [];
  let source = 'none';
  let llvmRoot = null;
  let mlirRoot = null;
  let mlirDev = null;
  let version = null;

  if (json !== null && typeof json.llvm === 'object' && json.llvm !== null) {
    source = 'toolchain.json';
    llvmRoot = typeof json.llvm.root === 'string' ? json.llvm.root : null;
    mlirRoot = typeof json.llvm.mlirRoot === 'string' ? json.llvm.mlirRoot : null;
    version = typeof json.llvm.version === 'string' ? json.llvm.version : null;
    const tools = json.llvm.tools !== null && typeof json.llvm.tools === 'object' ? json.llvm.tools : {};
    for (const [key, exe] of Object.entries(TOOLCHAIN_TO_EXE)) {
      const entry = tools[key];
      if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string') {
        paths[exe] = entry.path;
        if (typeof entry.version === 'string') versions[exe] = entry.version;
      }
    }
    if (json.mlirDev !== null && typeof json.mlirDev === 'object') {
      mlirDev = pickStrings(json.mlirDev, ['include', 'lib', 'cmakeDir', 'llvmCmakeDir']);
    }
  } else if (typeof loaded.error === 'string') {
    notes.push(loaded.error);
  }

  if (typeof config.mlirTblgenPath === 'string' && config.mlirTblgenPath.trim() !== '') {
    paths['mlir-tblgen'] = resolve(cwd, config.mlirTblgenPath.trim());
    if (source === 'none') source = 'config';
  }

  return { source, llvmRoot, mlirRoot, mlirDev, version, paths, versions, notes, toolchainPath };
}

/** 取工具路径；不存在返回 null（不抛 ENOENT）。 */
export function toolPath(resolved, exe) {
  const path = resolved.paths[exe];
  return typeof path === 'string' && path !== '' && existsSync(path) ? path : null;
}

function pickStrings(object, keys) {
  const out = {};
  for (const key of keys) {
    if (typeof object[key] === 'string' && object[key].trim() !== '') out[key] = object[key];
  }
  return out;
}
