import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包根目录（安装成 node_modules 链接时 ESM 解析到真实路径）。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 给 dsh resume 用的默认值：30s 足够一次 td 校验，重活由调用方显式放大。 */
const DEFAULTS = {
  toolchainPath: null,
  mlirTblgenPath: null,
  includeDirs: [],
  timeoutMs: 30000,
  maxOutputBytes: 1048576,
  maxDiagnostics: 100,
  graceMs: 5000,
};

/**
 * 解析插件配置：显式 mlirTblgenPath > toolchainPath/toolchain.json，数值夹到安全区间。
 * @param raw - cordis.patch.yml 里传进来的 config（可为 undefined）。
 * @param cwd - 会话工作目录，用于解析相对路径。
 */
export function resolveConfig(raw, cwd) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULTS, ...input };
  const explicitToolchain = typeof input.toolchainPath === 'string' && input.toolchainPath.trim() !== ''
    ? input.toolchainPath.trim()
    : (typeof process.env.MLIR_TOOLCHAIN_JSON === 'string' && process.env.MLIR_TOOLCHAIN_JSON.trim() !== ''
      ? process.env.MLIR_TOOLCHAIN_JSON.trim()
      : null);
  config.toolchainPath = explicitToolchain === null
    ? discoverToolchain(cwd)
    : resolve(cwd, explicitToolchain);
  config.mlirTblgenPath = typeof input.mlirTblgenPath === 'string' && input.mlirTblgenPath.trim() !== ''
    ? resolve(cwd, input.mlirTblgenPath.trim())
    : null;
  config.includeDirs = normalizeDirs(input.includeDirs);
  config.timeoutMs = clampInt(config.timeoutMs, 1000, 600000, DEFAULTS.timeoutMs);
  config.maxOutputBytes = clampInt(config.maxOutputBytes, 4096, 8 * 1024 * 1024, DEFAULTS.maxOutputBytes);
  config.maxDiagnostics = clampInt(config.maxDiagnostics, 1, 1000, DEFAULTS.maxDiagnostics);
  config.graceMs = clampInt(config.graceMs, 500, 30000, DEFAULTS.graceMs);
  return config;
}

/**
 * 未显式配置时按固定顺序找 toolchain.json：
 * 插件包同级（mlir-lang/toolchain.json）、包内、会话 cwd、cwd/mlir-lang。
 * 装上即可用，不需要改 profile 的 cordis.patch.yml。
 */
export function discoverToolchain(cwd) {
  const candidates = [
    join(PACKAGE_ROOT, '..', 'toolchain.json'),
    join(PACKAGE_ROOT, 'toolchain.json'),
    resolve(cwd, 'toolchain.json'),
    resolve(cwd, 'mlir-lang', 'toolchain.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** includeDirs 既接受数组也接受单个字符串；去空去重，保留原始写法（执行期按 cwd 解析）。 */
function normalizeDirs(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    const dir = item.trim();
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** 供工具提示用：当前插件包根目录。 */
export function packageRoot() {
  return PACKAGE_ROOT;
}
