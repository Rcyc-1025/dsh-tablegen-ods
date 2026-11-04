import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parseDiagnostics } from './diag.js';
import {
  checkParamName,
  escapeTdString,
  expandTypeConstraint,
  normalizeDialect,
  normalizeNamespace,
  normalizeOp,
} from './naming.js';

/** 生成的文件清单（顺序稳定，写入与报告都用它）。 */
export function filePlan(dialect) {
  return [
    { name: dialect + 'Dialect.td', kind: 'dialect-def' },
    { name: dialect + 'Ops.td', kind: 'ops-def' },
    { name: dialect + 'Dialect.h', kind: 'dialect-header' },
    { name: dialect + 'Dialect.cpp', kind: 'dialect-source' },
    { name: dialect + 'Ops.h', kind: 'ops-header' },
    { name: dialect + 'Ops.cpp', kind: 'ops-source' },
    { name: 'CMakeLists.txt', kind: 'cmake' },
  ];
}

const MAX_OPS = 256;

/**
 * 校验输入并渲染 7 个文件的内容（不碰磁盘、不跑 tblgen）。
 * @returns {{ok: boolean, errors: object[], dialect: string, lower: string, cppNamespace: string, files: object[]}}
 */
export function renderScaffold(input) {
  const args = input !== null && typeof input === 'object' ? input : {};
  const errors = [];
  const dialectInfo = normalizeDialect(args.dialect);
  if (!dialectInfo.ok) {
    errors.push({ kind: 'input', field: 'dialect', message: dialectInfo.error });
    return { ok: false, errors, dialect: '', lower: '', cppNamespace: '', files: [] };
  }
  const { dialect, lower } = dialectInfo;
  const ns = normalizeNamespace(args.cppNamespace, lower);
  if (!ns.ok) errors.push({ kind: 'input', field: 'cppNamespace', message: ns.error });

  const rawOps = Array.isArray(args.ops) ? args.ops : null;
  if (rawOps === null) errors.push({ kind: 'input', field: 'ops', message: 'ops 必须是数组，例如 [{ name: "Add", operands: [{ name: "lhs", type: "I32" }] }]。' });
  else if (rawOps.length === 0) errors.push({ kind: 'input', field: 'ops', message: 'ops 不能为空：至少给一个 op。' });
  else if (rawOps.length > MAX_OPS) errors.push({ kind: 'input', field: 'ops', message: 'ops 一次最多 ' + String(MAX_OPS) + ' 个（收到 ' + String(rawOps.length) + ' 个）。' });

  const ops = [];
  const seenRecords = new Map();
  const seenMnemonics = new Map();
  if (Array.isArray(rawOps)) {
    rawOps.forEach((entry, index) => {
      const op = entry !== null && typeof entry === 'object' ? entry : {};
      const where = 'ops[' + String(index) + ']';
      const normalized = normalizeOp(op.name, dialectInfo);
      if (!normalized.ok) {
        errors.push({ kind: 'input', field: where + '.name', message: normalized.error });
        return;
      }
      if (seenRecords.has(normalized.record)) {
        errors.push({ kind: 'input', field: where + '.name', message: '记录名重复：' + normalized.record + '（已被 ops[' + String(seenRecords.get(normalized.record)) + '] 使用）。' });
        return;
      }
      if (seenMnemonics.has(normalized.mnemonic)) {
        errors.push({ kind: 'input', field: where + '.name', message: 'mnemonic 重复：' + normalized.mnemonic + '（已被 ops[' + String(seenMnemonics.get(normalized.mnemonic)) + '] 使用）。' });
        return;
      }
      seenRecords.set(normalized.record, index);
      seenMnemonics.set(normalized.mnemonic, index);

      const names = new Set();
      const operands = readParams(op.operands, where + '.operands', 'operand', names, errors);
      const results = readParams(op.results, where + '.results', 'result', names, errors);
      const attributes = readAttributes(op.attributes, where + '.attributes', names, errors);
      const summary = typeof op.summary === 'string' && op.summary.trim() !== '' ? op.summary.trim() : null;

      ops.push({
        name: normalized.name,
        record: normalized.record,
        mnemonic: normalized.mnemonic,
        operands,
        results,
        attributes,
        summary,
      });
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors, dialect, lower, cppNamespace: ns.cppNamespace, files: [] };
  }

  const sorted = [...ops].sort((a, b) => (a.record < b.record ? -1 : a.record > b.record ? 1 : 0));
  const context = { dialect, lower, cppNamespace: ns.cppNamespace, ops: sorted };
  const contents = new Map([
    [dialect + 'Dialect.td', renderDialectTd(context)],
    [dialect + 'Ops.td', renderOpsTd(context)],
    [dialect + 'Dialect.h', renderDialectHeader(context)],
    [dialect + 'Dialect.cpp', renderDialectSource(context)],
    [dialect + 'Ops.h', renderOpsHeader(context)],
    [dialect + 'Ops.cpp', renderOpsSource(context)],
    ['CMakeLists.txt', renderCMakeLists(context)],
  ]);
  const files = filePlan(dialect).map((entry) => ({
    ...entry,
    content: contents.get(entry.name),
  }));
  return { ok: true, errors: [], dialect, lower, cppNamespace: ns.cppNamespace, files };
}

/** operands / results：数组，元素 {name, type}。 */
function readParams(raw, where, what, names, errors) {
  const out = [];
  if (raw === undefined || raw === null) return out;
  if (!Array.isArray(raw)) {
    errors.push({ kind: 'input', field: where, message: where + ' 必须是数组（元素形如 { name: "lhs", type: "I32" }）。' });
    return out;
  }
  raw.forEach((entry, index) => {
    const item = entry !== null && typeof entry === 'object' ? entry : {};
    const at = where + '[' + String(index) + ']';
    const nameCheck = checkParamName(item.name, at);
    if (!nameCheck.ok) errors.push({ kind: 'input', field: at + '.name', message: nameCheck.error });
    const type = expandTypeConstraint(item.type);
    if (!type.ok) errors.push({ kind: 'input', field: at + '.type', message: type.error });
    if (!nameCheck.ok || !type.ok) return;
    const name = String(item.name).trim();
    if (names.has(name)) {
      errors.push({ kind: 'input', field: at + '.name', message: what + ' 名字重复：$' + name + '（同一 op 内 operand/result/attribute 名必须唯一）。' });
      return;
    }
    names.add(name);
    out.push({ name, type: type.text });
  });
  return out;
}

/** attributes：接受 {name, type} 或字符串 "I32Attr:$amount"。 */
function readAttributes(raw, where, names, errors) {
  const out = [];
  if (raw === undefined || raw === null) return out;
  if (!Array.isArray(raw)) {
    errors.push({ kind: 'input', field: where, message: where + ' 必须是数组（元素形如 { name: "amount", type: "I32Attr" }）。' });
    return out;
  }
  raw.forEach((entry, index) => {
    const at = where + '[' + String(index) + ']';
    let name = '';
    let type = '';
    if (typeof entry === 'string') {
      const text = entry.trim();
      const match = /^(.+?):\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
      if (match === null) {
        errors.push({ kind: 'input', field: at, message: 'attribute 字符串应形如 I32Attr:$amount（收到 ' + JSON.stringify(entry) + '）。' });
        return;
      }
      type = match[1].trim();
      name = match[2];
    } else {
      const item = entry !== null && typeof entry === 'object' ? entry : {};
      name = typeof item.name === 'string' ? item.name.trim() : '';
      type = typeof item.type === 'string' ? item.type.trim() : '';
    }
    const nameCheck = checkParamName(name, at);
    if (!nameCheck.ok) errors.push({ kind: 'input', field: at + '.name', message: nameCheck.error });
    const typeCheck = expandTypeConstraint(type);
    if (!typeCheck.ok) errors.push({ kind: 'input', field: at + '.type', message: 'attribute ' + typeCheck.error });
    if (!nameCheck.ok || !typeCheck.ok) return;
    if (names.has(name)) {
      errors.push({ kind: 'input', field: at + '.name', message: 'attribute 名字重复：$' + name + '（同一 op 内 operand/result/attribute 名必须唯一）。' });
      return;
    }
    names.add(name);
    out.push({ name, type: typeCheck.text });
  });
  return out;
}

function renderDialectTd(ctx) {
  const { dialect, lower, cppNamespace } = ctx;
  return [
    '//===- ' + dialect + 'Dialect.td - ' + dialect + ' dialect definition ------*- tablegen -*-===//',
    '//',
    '// Generated by dsh-tablegen-ods. Edit freely.',
    '//',
    '//===----------------------------------------------------------------------===//',
    '',
    '#ifndef ' + guard(dialect) + '_DIALECT_TD',
    '#define ' + guard(dialect) + '_DIALECT_TD',
    '',
    'include "mlir/IR/OpBase.td"',
    '',
    'def ' + dialect + '_Dialect : Dialect {',
    '  let name = "' + lower + '";',
    '  let cppNamespace = "' + cppNamespace + '";',
    '}',
    '',
    '#endif // ' + guard(dialect) + '_DIALECT_TD',
    '',
  ].join('\n');
}

function renderOpsTd(ctx) {
  const { dialect, ops } = ctx;
  const lines = [
    '//===- ' + dialect + 'Ops.td - ' + dialect + ' operation definitions -----*- tablegen -*-===//',
    '//',
    '// Generated by dsh-tablegen-ods. Edit freely.',
    '//',
    '//===----------------------------------------------------------------------===//',
    '',
    '#ifndef ' + guard(dialect) + '_OPS_TD',
    '#define ' + guard(dialect) + '_OPS_TD',
    '',
    'include "' + dialect + 'Dialect.td"',
    '',
    'class ' + dialect + '_Op<string mnemonic, list<Trait> traits = []> :',
    '    Op<' + dialect + '_Dialect, mnemonic, traits>;',
    '',
  ];
  for (const op of ops) {
    lines.push('def ' + op.record + ' : ' + dialect + '_Op<"' + op.name.toLowerCase() + '"> {');
    if (op.summary !== null) lines.push('  let summary = "' + escapeTdString(op.summary) + '";');
    const args = op.operands.map((item) => item.type + ':$' + item.name)
      .concat(op.attributes.map((item) => item.type + ':$' + item.name));
    if (args.length > 0) {
      lines.push('  let arguments = (ins');
      args.forEach((text, index) => {
        const suffix = index === args.length - 1 ? ');' : ',';
        lines.push('    ' + text + suffix);
      });
    }
    if (op.results.length > 0) {
      lines.push('  let results = (outs');
      op.results.forEach((item, index) => {
        const suffix = index === op.results.length - 1 ? ');' : ',';
        lines.push('    ' + item.type + ':$' + item.name + suffix);
      });
    }
    lines.push('}');
    lines.push('');
  }
  lines.push('#endif // ' + guard(dialect) + '_OPS_TD');
  lines.push('');
  return lines.join('\n');
}

function renderDialectHeader(ctx) {
  const { dialect } = ctx;
  return [
    '//===- ' + dialect + 'Dialect.h - ' + dialect + ' dialect declaration ----------*- C++ -*-===//',
    '//',
    '// Generated by dsh-tablegen-ods. Edit freely.',
    '//',
    '//===----------------------------------------------------------------------===//',
    '',
    '#ifndef ' + guard(dialect) + '_DIALECT_H',
    '#define ' + guard(dialect) + '_DIALECT_H',
    '',
    '#include "mlir/IR/Dialect.h"',
    '',
    '#include "' + dialect + 'Dialect.h.inc"',
    '',
    '#endif // ' + guard(dialect) + '_DIALECT_H',
    '',
  ].join('\n');
}

function renderDialectSource(ctx) {
  const { dialect, cppNamespace } = ctx;
  const ns = cppNamespace.startsWith('::') ? cppNamespace.slice(2) : cppNamespace;
  return [
    '//===- ' + dialect + 'Dialect.cpp - ' + dialect + ' dialect implementation -------*- C++ -*-===//',
    '//',
    '// Generated by dsh-tablegen-ods. Edit freely.',
    '//',
    '//===----------------------------------------------------------------------===//',
    '',
    '#include "' + dialect + 'Dialect.h"',
    '',
    '#include "mlir/IR/DialectImplementation.h"',
    '',
    '#include "' + dialect + 'Dialect.cpp.inc"',
    '',
    '#include "' + dialect + 'Ops.h"',
    '',
    'void ' + ns + '::' + dialect + 'Dialect::initialize() {',
    '  addOperations<',
    '#define GET_OP_LIST',
    '#include "' + dialect + 'Ops.cpp.inc"',
    '      >();',
    '}',
    '',
  ].join('\n');
}

function renderOpsHeader(ctx) {
  const { dialect } = ctx;
  return [
    '//===- ' + dialect + 'Ops.h - ' + dialect + ' operation declarations --------*- C++ -*-===//',
    '//',
    '// Generated by dsh-tablegen-ods. Edit freely.',
    '//',
    '//===----------------------------------------------------------------------===//',
    '',
    '#ifndef ' + guard(dialect) + '_OPS_H',
    '#define ' + guard(dialect) + '_OPS_H',
    '',
    '#include "mlir/IR/Builders.h"',
    '#include "mlir/IR/BuiltinTypes.h"',
    '#include "mlir/IR/Dialect.h"',
    '#include "mlir/IR/OpDefinition.h"',
    '#include "mlir/IR/OpImplementation.h"',
    '#include "mlir/Interfaces/SideEffectInterfaces.h"',
    '',
    '#include "' + dialect + 'Dialect.h"',
    '',
    '#define GET_OP_CLASSES',
    '#include "' + dialect + 'Ops.h.inc"',
    '',
    '#endif // ' + guard(dialect) + '_OPS_H',
    '',
  ].join('\n');
}

function renderOpsSource(ctx) {
  const { dialect } = ctx;
  return [
    '//===- ' + dialect + 'Ops.cpp - ' + dialect + ' operation definitions --------*- C++ -*-===//',
    '//',
    '// Generated by dsh-tablegen-ods. Edit freely.',
    '//',
    '//===----------------------------------------------------------------------===//',
    '',
    '#include "' + dialect + 'Ops.h"',
    '',
    '#include "mlir/IR/OpImplementation.h"',
    '',
    '#define GET_OP_CLASSES',
    '#include "' + dialect + 'Ops.cpp.inc"',
    '',
  ].join('\n');
}

function renderCMakeLists(ctx) {
  const { dialect, lower } = ctx;
  return [
    '# Generated by dsh-tablegen-ods. Edit freely.',
    'cmake_minimum_required(VERSION 3.20)',
    'project(' + dialect + 'Dialect LANGUAGES CXX)',
    '',
    'set(CMAKE_CXX_STANDARD 17)',
    'set(CMAKE_CXX_STANDARD_REQUIRED ON)',
    'set(CMAKE_CXX_EXTENSIONS OFF)',
    '',
    'find_package(MLIR REQUIRED CONFIG)',
    '',
    'list(APPEND CMAKE_MODULE_PATH "${MLIR_CMAKE_DIR}")',
    'list(APPEND CMAKE_MODULE_PATH "${LLVM_CMAKE_DIR}")',
    'include(TableGen)',
    'include(AddLLVM)',
    'include(AddMLIR)',
    'include(HandleLLVMOptions)',
    '',
    'include_directories(${LLVM_INCLUDE_DIRS} ${MLIR_INCLUDE_DIRS})',
    'include_directories(${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_BINARY_DIR})',
    'add_definitions(${LLVM_DEFINITIONS})',
    '',
    'set(LLVM_TARGET_DEFINITIONS ' + dialect + 'Dialect.td)',
    'mlir_tablegen(' + dialect + 'Dialect.h.inc -gen-dialect-decls -dialect=' + lower + ')',
    'mlir_tablegen(' + dialect + 'Dialect.cpp.inc -gen-dialect-defs -dialect=' + lower + ')',
    'set(LLVM_TARGET_DEFINITIONS ' + dialect + 'Ops.td)',
    'mlir_tablegen(' + dialect + 'Ops.h.inc -gen-op-decls)',
    'mlir_tablegen(' + dialect + 'Ops.cpp.inc -gen-op-defs)',
    'add_public_tablegen_target(' + dialect + 'IncGen)',
    '',
    '# add_mlir_dialect_library() hard-depends on the in-tree `mlir-headers` target,',
    '# which does not exist for out-of-tree builds; provide an empty stand-in.',
    'if(NOT TARGET mlir-headers)',
    '  add_custom_target(mlir-headers)',
    'endif()',
    '',
    'add_mlir_dialect_library(' + dialect + 'Dialect',
    '  ' + dialect + 'Dialect.cpp',
    '  ' + dialect + 'Ops.cpp',
    '',
    '  DEPENDS',
    '  ' + dialect + 'IncGen',
    '',
    '  LINK_LIBS PUBLIC',
    '  MLIRIR',
    ')',
    '',
  ].join('\n');
}

function guard(dialect) {
  return dialect.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** 校验种类 → tblgen 参数与本插件支持的 kind 名单。 */
export const VALIDATION_RUNS = [
  { kind: 'dialect-decls', flag: '-gen-dialect-decls', input: 'Dialect' },
  { kind: 'dialect-defs', flag: '-gen-dialect-defs', input: 'Dialect' },
  { kind: 'op-decls', flag: '-gen-op-decls', input: 'Ops' },
  { kind: 'op-defs', flag: '-gen-op-defs', input: 'Ops' },
];

/**
 * 在临时目录里跑 4 次 tblgen 校验生成的 .td；不往用户目录写 .inc。
 * @param options.dialect - 已规范化的 dialect 名。
 * @param options.files - renderScaffold 的 files。
 * @param options.runner - subprocess runner。
 * @param options.tblgenPath - mlir-tblgen 绝对路径。
 * @param options.includeDirs - 额外 -I。
 * @param options.timeoutMs - 单次超时。
 * @param options.maxDiagnostics - 诊断上限。
 * @returns {Promise<{validation: 'passed'|'failed', errors: object[], stderr: string, crashed: boolean, timedOut: boolean}>}
 */
export async function validateScaffold(options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const dialect = String(opts.dialect);
  const files = Array.isArray(opts.files) ? opts.files : [];
  const includeDirs = Array.isArray(opts.includeDirs) ? opts.includeDirs : [];
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000;
  const maxDiagnostics = typeof opts.maxDiagnostics === 'number' ? opts.maxDiagnostics : 100;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tablegen-ods-'));
  const sources = new Map();
  const errors = [];
  let stderr = '';
  let crashed = false;
  let timedOut = false;
  try {
    for (const file of files) {
      if (!file.name.endsWith('.td')) continue;
      writeFileSync(join(dir, file.name), file.content, 'utf8');
      sources.set(join(dir, file.name).toLowerCase(), file.content);
    }
    const recordFor = (file, line) => recordForSource(sources.get(String(file).toLowerCase()), line);
    for (const run of VALIDATION_RUNS) {
      const input = join(dir, dialect + run.input + '.td');
      const out = join(dir, run.kind + '.inc');
      const argv = [opts.tblgenPath, run.flag, input, '-I', dir];
      for (const includeDir of includeDirs) argv.push('-I', includeDir);
      argv.push('-o', out);
      let result;
      try {
        result = await opts.runner(argv, { cwd: dir, timeoutMs });
      } catch (error) {
        errors.push({
          file: input,
          line: 0,
          col: 0,
          severity: 'error',
          kind: 'toolchain',
          record: null,
          message: '启动 mlir-tblgen 失败：' + messageOf(error),
          phase: run.kind,
        });
        break;
      }
      stderr += result.stderr;
      if (result.timedOut) timedOut = true;
      const parsed = parseDiagnostics(result.stderr, { maxDiagnostics, recordFor });
      crashed = crashed || parsed.crashed;
      for (const item of parsed.diagnostics) {
        errors.push({ ...item, kind: item.kind, phase: run.kind });
      }
      if (parsed.diagnostics.length === 0 && result.exitCode !== 0 && !result.timedOut) {
        errors.push({
          file: input,
          line: 0,
          col: 0,
          severity: 'error',
          kind: 'other',
          record: null,
          message: 'mlir-tblgen 退出码 ' + String(result.exitCode) + '，没有可解析的诊断行。',
          phase: run.kind,
        });
      }
      if (result.timedOut) break;
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录清不掉不影响结论。
    }
  }
  const validation = errors.length === 0 && !timedOut ? 'passed' : 'failed';
  return { validation, errors: dedupeScaffoldErrors(errors), stderr, crashed, timedOut };
}

/** 同一个诊断会在 decls 与 defs 两次运行里各出现一次，按 file/line/col/message 去重。 */
function dedupeScaffoldErrors(errors) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(errors) ? errors : []) {
    const key = String(item.file) + '\u0000' + String(item.line) + '\u0000' + String(item.col) + '\u0000' + String(item.message);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function recordForSource(source, line) {
  if (typeof source !== 'string') return null;
  const lines = source.split(/\r?\n/);
  const start = Math.min(Math.max(1, line), lines.length) - 1;
  for (let index = start; index >= 0; index -= 1) {
    const match = /^\s*(?:def|defm|class)\s+([A-Za-z][A-Za-z0-9_]*)/.exec(lines[index]);
    if (match !== null) return match[1];
  }
  return null;
}

/** 列出 outDir 里已存在的目标文件（overwrite:false 时用来提前报冲突）。 */
export function findConflicts(outDir, files) {
  const base = resolve(String(outDir));
  const conflicts = [];
  for (const file of Array.isArray(files) ? files : []) {
    const target = join(base, file.name);
    if (!isInside(base, target)) continue;
    if (existsSync(target)) conflicts.push(target);
  }
  return conflicts;
}

/** 判断目标路径确实落在 outDir 内（写盘前的最后一道闸）。 */
export function isInside(outDir, target) {
  const base = resolve(outDir);
  const path = resolve(target);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * 把渲染好的文件写进磁盘；overwrite:false 时先检查冲突，冲突则一个字节都不写。
 * @returns {{ok: boolean, conflicts: string[], files: object[], errors: object[]}}
 */
export function commitScaffold(options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const outDir = resolve(String(opts.outDir));
  const files = Array.isArray(opts.files) ? opts.files : [];
  const conflicts = [];
  for (const file of files) {
    const target = join(outDir, file.name);
    if (!isInside(outDir, target)) {
      return { ok: false, conflicts: [], files: [], errors: [{ kind: 'input', field: 'outDir', message: '拒绝写入 outDir 之外的路径：' + target }] };
    }
    if (existsSync(target)) conflicts.push(target);
  }
  if (conflicts.length > 0 && opts.overwrite !== true) {
    return { ok: false, conflicts, files: [], errors: [] };
  }
  try {
    if (existsSync(outDir) && !statSync(outDir).isDirectory()) {
      return { ok: false, conflicts: [], files: [], errors: [{ kind: 'input', field: 'outDir', message: 'outDir 已存在且不是目录：' + outDir }] };
    }
    mkdirSync(outDir, { recursive: true });
  } catch (error) {
    return { ok: false, conflicts: [], files: [], errors: [{ kind: 'input', field: 'outDir', message: '创建 outDir 失败：' + messageOf(error) }] };
  }
  const written = [];
  try {
    for (const file of files) {
      const target = join(outDir, file.name);
      writeFileSync(target, file.content, 'utf8');
      written.push({ path: target, kind: file.kind, bytes: Buffer.byteLength(file.content, 'utf8') });
    }
  } catch (error) {
    return { ok: false, conflicts: [], files: written, errors: [{ kind: 'input', field: 'outDir', message: '写文件失败：' + messageOf(error) }] };
  }
  return { ok: true, conflicts: [], files: written, errors: [] };
}

function messageOf(error) {
  return error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
}
