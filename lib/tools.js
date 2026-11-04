import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseDiagnostics } from './diag.js';
import { explainReport, fixFor } from './explain.js';
import { includeHint, resolveIncludes } from './includes.js';
import { commitScaffold, findConflicts, renderScaffold, validateScaffold } from './scaffold.js';
import { clipHeadTail } from './text.js';
import { resolveTools, toolPath } from './toolchain.js';

/** td_check 支持的 kind → mlir-tblgen 参数。 */
const CHECK_KINDS = {
  'op-decls': '-gen-op-decls',
  'op-defs': '-gen-op-defs',
  'dialect-decls': '-gen-dialect-decls',
  'dialect-defs': '-gen-dialect-defs',
  'typedef-decls': '-gen-typedef-decls',
  'typedef-defs': '-gen-typedef-defs',
  rewriters: '-gen-rewriters',
  'rewriter-decls': '-gen-rewriters',
};

const DEFAULT_KINDS = ['op-decls', 'op-defs'];
const objectSchema = { type: 'object', additionalProperties: true };

/** 会话 cwd：模型在哪个项目里调用，相对路径就相对谁解析。 */
function executionCwd(exec) {
  return exec !== null && exec !== undefined &&
    exec.agent !== null && exec.agent !== undefined &&
    exec.agent.session !== null && exec.agent.session !== undefined &&
    exec.agent.session.header !== null && exec.agent.session.header !== undefined &&
    typeof exec.agent.session.header.cwd === 'string'
    ? exec.agent.session.header.cwd
    : process.cwd();
}

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/** 缺 mlir-tblgen 时统一的中文指引。 */
function missingTblgenHint(resolved, cwd) {
  const where = typeof resolved.toolchainPath === 'string' ? resolved.toolchainPath : '（未找到 toolchain.json）';
  const notes = Array.isArray(resolved.notes) && resolved.notes.length > 0 ? '；' + resolved.notes.join('；') : '';
  return '找不到 mlir-tblgen：本插件只认「mlirTblgenPath 显式路径 > toolchain.json 的 llvm.tools.mlirTblgen.path」，不做 PATH 搜索。' +
    '当前 toolchain.json：' + where + notes + '。修复：①给插件配 mlirTblgenPath（例如 D:\\Code\\llvm-build\\bin\\mlir-tblgen.exe）；' +
    '②或设环境变量 MLIR_TOOLCHAIN_JSON 指向 toolchain.json；③或在会话目录放 mlir-lang/toolchain.json。' +
    '插件与工具都没有向外执行其他动作。cwd=' + cwd;
}

/** 只列当前目录下的 .td（不递归），排序保证结果稳定。 */
function listTdFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.td'))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** kinds 规范化：缺省两个 op 生成器；未知 kind 直接拒绝。 */
function normalizeKinds(raw) {
  if (raw === undefined || raw === null) return { ok: true, kinds: [...DEFAULT_KINDS], error: null };
  if (!Array.isArray(raw)) {
    return { ok: false, kinds: [], error: 'kinds 必须是字符串数组，例如 ["op-decls","op-defs"]。' };
  }
  const sorts = [];
  for (const item of raw) {
    const key = typeof item === 'string' ? item.trim() : '';
    if (key === '') return { ok: false, kinds: [], error: 'kinds 里有空字符串。' };
    if (!Object.hasOwn(CHECK_KINDS, key)) {
      return {
        ok: false,
        kinds: [],
        error: '不支持的 kind：' + JSON.stringify(key) + '；可用：' + Object.keys(CHECK_KINDS).join('、') + '。',
      };
    }
    if (!sorts.includes(key)) sorts.push(key);
  }
  if (sorts.length === 0) return { ok: false, kinds: [], error: 'kinds 不能为空数组。' };
  return { ok: true, kinds: sorts, error: null };
}

/** 读 .td 原文用于回填 record；读不到返回 null（不影响诊断本身）。 */
function sourceReader() {
  const cache = new Map();
  return (file) => {
    const key = String(file).toLowerCase();
    if (cache.has(key)) return cache.get(key);
    let text = null;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      text = null;
    }
    cache.set(key, text);
    return text;
  };
}

function recordForReader(readSource) {
  return (file, line) => {
    const source = readSource(file);
    if (typeof source !== 'string') return null;
    const lines = source.split(/\r?\n/);
    const start = Math.min(Math.max(1, line), lines.length) - 1;
    for (let index = start; index >= 0; index -= 1) {
      const match = /^\s*(?:def|defm|class)\s+([A-Za-z][A-Za-z0-9_]*)/.exec(lines[index]);
      if (match !== null) return match[1];
    }
    return null;
  };
}

/** 跨 (kind, file) 去重：同一诊断会在 -gen-op-decls 与 -gen-op-defs 各出现一次。 */
function dedupeDiagnostics(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = String(item.file) + '\u0000' + String(item.line) + '\u0000' + String(item.col) + '\u0000' + String(item.message);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  out.sort((a, b) => String(a.file).localeCompare(String(b.file)) || a.line - b.line || a.col - b.col);
  return out;
}

function firstErrorMessage(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  const where = first.file !== null && first.file !== undefined && first.file !== ''
    ? basename(String(first.file)) + ':' + String(first.line) + ':' + String(first.col) + ': '
    : '';
  return where + String(first.message);
}

function errorHint(errors, crashed, timedOut) {
  const first = firstErrorMessage(errors);
  const lines = [];
  if (typeof first === 'string') {
    lines.push('发现 ' + String(errors.length) + ' 条错误，首个：' + first);
    const fix = fixFor(errors[0].kind, errors[0].message, null);
    if (typeof fix === 'string' && fix !== '') lines.push('修复方向：' + fix);
  }
  if (crashed) lines.push('mlir-tblgen 崩溃了（Stack dump 已从 message 里过滤）；先修上面的错误，若 .td 本身合法则是工具链问题。');
  if (timedOut) lines.push('校验超时：把插件配置 timeoutMs 调大，或缩小 tdDir 里 .td 的数量。');
  return lines.length === 0 ? null : lines.join('\n');
}

export function buildTablegenTools(config, runner) {
  /** ---------------------------------------------------------------- scaffold */
  const scaffold = {
    name: 'td_scaffold',
    description: '按 dialect / op 列表生成一套可直接用的 MLIR ODS 骨架：<D>Dialect.td、<D>Ops.td、<D>Dialect.h/.cpp、<D>Ops.h/.cpp、CMakeLists.txt（共 7 个文件），并用 mlir-tblgen 校验 .td。支持 Add / AddOp / Toy_AddOp / toy.add 四种 op 写法；类型别名 I32/I64/F32/F64/AnyInteger/AnyMemRef/Variadic<T> 自动展开。默认 overwrite:false（有同名文件就整批拒绝、一个字节都不写），validate:true（校验失败也不提交）。确定性生成：同输入逐字节一致。缺 mlir-tblgen 时返回 ok:false + 中文 hint，不抛异常。',
    parameters: {
      type: 'object',
      properties: {
        dialect: { type: 'string', description: '方言名，如 Toy（也接受 toy / ToyDialect）。' },
        cppNamespace: { type: 'string', description: '可选：C++ 命名空间，如 ::toy；缺省 ::<dialect 小写>。' },
        ops: {
          type: 'array',
          description: 'op 列表，至少一个；顺序由记录名排序决定，保证确定性。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'op 名：Add / AddOp / Toy_AddOp / toy.add 均可。' },
              operands: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: '参数名（生成 $name）。' },
                    type: { type: 'string', description: '类型约束，如 I32 / F32 / AnyMemRef / Variadic<I32>。' },
                  },
                  required: ['name', 'type'],
                  additionalProperties: false,
                },
              },
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: '结果名（生成 $name）。' },
                    type: { type: 'string', description: '类型约束，如 I32。' },
                  },
                  required: ['name', 'type'],
                  additionalProperties: false,
                },
              },
              attributes: {
                type: 'array',
                description: '属性（写进 arguments，不生成 let attributes），元素 {name,type}，type 如 I32Attr。',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: '属性名（生成 $name）。' },
                    type: { type: 'string', description: '属性约束，如 I32Attr / StrAttr / UnitAttr。' },
                  },
                  required: ['name', 'type'],
                  additionalProperties: false,
                },
              },
              summary: { type: 'string', description: '可选：op 摘要，写入 let summary。' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        outDir: { type: 'string', description: '输出目录，按会话 cwd 解析；不存在会创建。' },
        overwrite: { type: 'boolean', description: '默认 false：目标同名文件存在时整批拒绝、不写任何文件。' },
        validate: { type: 'boolean', description: '默认 true：写盘前用 mlir-tblgen 校验生成的 .td；失败则不提交文件。' },
      },
      required: ['dialect', 'ops', 'outDir'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: (_args, value) => {
        const rec = value !== null && typeof value === 'object' ? value : {};
        const lines = ['td_scaffold：' + (rec.ok === true ? '成功' : '失败')];
        if (typeof rec.outDir === 'string') lines.push('- outDir：' + rec.outDir);
        if (typeof rec.validation === 'string') lines.push('- 校验：' + rec.validation);
        if (Array.isArray(rec.files)) {
          for (const file of rec.files) {
            lines.push('- ' + String(file.path ?? file) + '（' + String(file.kind ?? '') + '，' + String(file.bytes ?? '?') + ' 字节）');
          }
        }
        if (Array.isArray(rec.conflicts) && rec.conflicts.length > 0) {
          lines.push('- 冲突文件（未写入）：' + rec.conflicts.join('、'));
        }
        if (Array.isArray(rec.errors) && rec.errors.length > 0) {
          for (const item of rec.errors.slice(0, 8)) {
            const where = typeof item.file === 'string' && item.file !== ''
              ? basename(item.file) + ':' + String(item.line) + ':' + String(item.col) + ': '
              : (typeof item.field === 'string' ? item.field + '：' : '');
            lines.push('- ' + where + String(item.message ?? ''));
          }
          if (rec.errors.length > 8) lines.push('- … 还有 ' + String(rec.errors.length - 8) + ' 条错误');
        }
        if (typeof rec.hint === 'string' && rec.hint !== '') lines.push('- 建议：' + rec.hint);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(rawArgs, exec) {
      const cwd = executionCwd(exec);
      const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {};
      const outDirRaw = textOf(input.outDir).trim();
      const rendered = renderScaffold(input);
      const outDir = outDirRaw === '' ? '' : resolve(cwd, outDirRaw);
      if (!rendered.ok) {
        return {
          ok: false,
          outDir: outDir === '' ? null : outDir,
          files: [],
          validation: 'skipped',
          errors: rendered.errors,
          hint: hintForInputErrors(rendered.errors),
        };
      }
      if (outDir === '') {
        return {
          ok: false,
          outDir: null,
          files: [],
          validation: 'skipped',
          errors: [{ kind: 'input', field: 'outDir', message: 'outDir 不能为空。' }],
          hint: 'outDir 不能为空：给一个可写目录，例如 D:\\work\\toy。',
        };
      }

      const overwrite = input.overwrite === true;
      const conflicts = findConflicts(outDir, rendered.files);
      if (conflicts.length > 0 && !overwrite) {
        return {
          ok: false,
          outDir,
          files: [],
          validation: 'skipped',
          conflicts,
          errors: [],
          hint: '目标目录已有同名文件，overwrite:false 时整批不写：' + conflicts.join('、') +
            '。改用新的 outDir，或显式传 overwrite:true。',
        };
      }

      let validation = 'skipped';
      let errors = [];
      if (input.validate !== false) {
        const resolved = resolveTools(config, cwd);
        const tblgen = toolPath(resolved, 'mlir-tblgen');
        if (tblgen === null) {
          return {
            ok: false,
            outDir,
            files: [],
            validation: 'failed',
            conflicts: conflicts.length > 0 ? conflicts : undefined,
            errors: [{ kind: 'toolchain', message: '找不到 mlir-tblgen' }],
            hint: missingTblgenHint(resolved, cwd) + ' 也可以传 validate:false 跳过校验（仍会写文件，但不再保证能过 tblgen）。',
          };
        }
        const includes = resolveIncludes(config, cwd, resolved);
        const result = await validateScaffold({
          dialect: rendered.dialect,
          files: rendered.files,
          runner,
          tblgenPath: tblgen,
          includeDirs: includes.dirs,
          timeoutMs: config.timeoutMs,
          maxDiagnostics: config.maxDiagnostics,
        });
        validation = result.validation;
        errors = result.errors;
        if (validation !== 'passed') {
          const hint = errorHint(errors, result.crashed, result.timedOut) ??
            (includes.dirs.length === 0 ? includeHint(includes.searched) : '校验没通过：先修 .td，或确认 mlir-tblgen 与 MLIR include 版本匹配。');
          return { ok: false, outDir, files: [], validation, conflicts: conflicts.length > 0 ? conflicts : undefined, errors, hint };
        }
      }

      const commit = commitScaffold({ outDir, files: rendered.files, overwrite });
      if (!commit.ok) {
        return {
          ok: false,
          outDir,
          files: commit.files,
          validation,
          conflicts: commit.conflicts.length > 0 ? commit.conflicts : undefined,
          errors: commit.errors,
          hint: commit.conflicts.length > 0
            ? '写入时发现同名文件（可能刚被创建）：' + commit.conflicts.join('、') + '。'
            : (commit.errors[0]?.message ?? '写入失败。'),
        };
      }
      return {
        ok: true,
        outDir,
        files: commit.files,
        validation,
        errors: [],
        hint: validation === 'passed'
          ? '已生成 7 个文件并通过 mlir-tblgen 校验；下一步：cmake -S ' + outDir + ' -B build -DMLIR_DIR=<mlir cmake 目录>。'
          : '已生成 7 个文件（未校验）；需要时再调 td_check，或传 validate:true。',
      };
    },
    timeoutMs: Math.min(config.timeoutMs * 5 + 30000, 900000),
  };

  /** ---------------------------------------------------------------- check */
  const check = {
    name: 'td_check',
    description: '用 mlir-tblgen 检查目录里的 TableGen 定义：默认跑 -gen-op-decls / -gen-op-defs，可选 dialect-decls/defs、typedef-decls/defs、rewriters。返回 ok、结构化诊断（file/line/col/severity/kind/record/message，已按位置排序去重、崩溃栈已过滤）、files、kinds、crashed、timedOut、stderr、中文 hint。ok:true 仅当所有 kind 退出码 0 且无 error 级诊断（warning 不算失败）。不写 .inc 到用户目录。',
    parameters: {
      type: 'object',
      properties: {
        tdDir: { type: 'string', description: '包含 .td 的目录（按会话 cwd 解析），只检查该目录下的 .td。' },
        kinds: {
          type: 'array',
          description: '生成器列表，默认 ["op-decls","op-defs"]；可选 op-decls/op-defs/dialect-decls/dialect-defs/typedef-decls/typedef-defs/rewriters/rewriter-decls。',
          items: { type: 'string' },
        },
      },
      required: ['tdDir'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: (_args, value) => {
        const rec = value !== null && typeof value === 'object' ? value : {};
        const lines = ['td_check：' + (rec.ok === true ? '通过' : '失败') +
          '（kinds=' + (Array.isArray(rec.kinds) ? rec.kinds.join(',') : '?') +
          '；文件 ' + String(Array.isArray(rec.files) ? rec.files.length : 0) + ' 个）'];
        if (rec.timedOut === true) lines.push('- 超时');
        if (rec.crashed === true) lines.push('- mlir-tblgen 崩溃（栈已过滤）');
        if (Array.isArray(rec.errors)) {
          for (const item of rec.errors.slice(0, 12)) {
            lines.push('- error ' + basename(String(item.file ?? '')) + ':' + String(item.line) + ':' + String(item.col) +
              ' [' + String(item.kind) + (item.record === null || item.record === undefined ? '' : ' ' + String(item.record)) + '] ' + String(item.message));
          }
          if (rec.errors.length > 12) lines.push('- … 还有 ' + String(rec.errors.length - 12) + ' 条错误');
        }
        if (Array.isArray(rec.warnings) && rec.warnings.length > 0) lines.push('- warning ' + String(rec.warnings.length) + ' 条');
        if (typeof rec.hint === 'string' && rec.hint !== '') lines.push('- 建议：' + rec.hint);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(rawArgs, exec) {
      const cwd = executionCwd(exec);
      const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {};
      const kindsInfo = normalizeKinds(input.kinds);
      const empty = { ok: false, errors: [], warnings: [], files: [], kinds: kindsInfo.kinds, crashed: false, timedOut: false, stderr: '', hint: null };
      if (!kindsInfo.ok) return { ...empty, hint: kindsInfo.error };
      const dirRaw = textOf(input.tdDir).trim();
      if (dirRaw === '') return { ...empty, hint: 'tdDir 不能为空：给一个包含 .td 的目录。' };
      const tdDir = resolve(cwd, dirRaw);
      let isDir = false;
      try {
        isDir = statSync(tdDir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!existsSync(tdDir) || !isDir) return { ...empty, hint: 'tdDir 不存在或不是目录：' + tdDir };
      const files = listTdFiles(tdDir);
      if (files.length === 0) return { ...empty, hint: '目录里没有 .td 文件：' + tdDir };

      const resolved = resolveTools(config, cwd);
      const tblgen = toolPath(resolved, 'mlir-tblgen');
      if (tblgen === null) return { ...empty, files, hint: missingTblgenHint(resolved, cwd) };

      const includes = resolveIncludes(config, cwd, resolved);
      const readSource = sourceReader();
      const recordFor = recordForReader(readSource);
      const errors = [];
      const warnings = [];
      const stderrParts = [];
      let crashed = false;
      let timedOut = false;
      let unsupported = null;
      let runs = 0;

      outer:
      for (const kind of kindsInfo.kinds) {
        const flag = CHECK_KINDS[kind];
        for (const file of files) {
          const out = join(tmpdir(), 'dsh-td-check-' + String(process.pid) + '-' + String(runs) + '.inc');
          runs += 1;
          const argv = [tblgen, flag, file, '-I', tdDir];
          for (const dir of includes.dirs) {
            if (resolve(dir) !== resolve(tdDir)) argv.push('-I', dir);
          }
          argv.push('-o', out);
          let result;
          try {
            result = await runner(argv, { cwd: tdDir, timeoutMs: config.timeoutMs });
          } catch (error) {
            return {
              ...empty,
              files,
              hint: '启动 mlir-tblgen 失败：' + String(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : error),
            };
          } finally {
            try {
              rmSync(out, { force: true });
            } catch {
              // 临时文件清不掉不影响结论。
            }
          }
          stderrParts.push(result.stderr);
          if (result.timedOut) timedOut = true;
          if (/Unknown command line argument .*-gen-/i.test(result.stderr)) {
            unsupported = kind;
            break outer;
          }
          const parsed = parseDiagnostics(result.stderr, { maxDiagnostics: config.maxDiagnostics, recordFor });
          crashed = crashed || parsed.crashed;
          if (parsed.diagnostics.length === 0 && result.exitCode !== 0 && !result.timedOut) {
            errors.push({
              file,
              line: 0,
              col: 0,
              severity: 'error',
              kind: 'other',
              record: null,
              message: 'mlir-tblgen 退出码 ' + String(result.exitCode) + '，没有可解析的诊断行。',
            });
          }
          errors.push(...parsed.diagnostics);
          warnings.push(...parsed.warnings);
          if (result.timedOut) break outer;
        }
      }

      const stderr = clipHeadTail(stderrParts.filter((part) => part !== '').join('\n'), config.maxOutputBytes);
      const dedupedErrors = dedupeDiagnostics(errors).slice(0, config.maxDiagnostics);
      const dedupedWarnings = dedupeDiagnostics(warnings).slice(0, config.maxDiagnostics);
      const hint = unsupported !== null
        ? '当前 mlir-tblgen 不支持 kind ' + JSON.stringify(unsupported) + '（' + String(flagOf(unsupported)) +
          '），换一个 kind 或升级工具链；已支持：' + Object.keys(CHECK_KINDS).join('、') + '。'
        : (dedupedErrors.length === 0 && !timedOut && !crashed
          ? null
          : (errorHint(dedupedErrors, crashed, timedOut) ?? (timedOut ? '校验超时。' : null)));

      return {
        ok: unsupported === null && !timedOut && dedupedErrors.length === 0,
        errors: dedupedErrors,
        warnings: dedupedWarnings,
        files,
        kinds: kindsInfo.kinds,
        crashed,
        timedOut,
        stderr: stderr.text,
        truncated: stderr.truncated,
        hint,
      };
    },
    timeoutMs: Math.min(config.timeoutMs * 5 + 30000, 900000),
  };

  /** ---------------------------------------------------------------- explain */
  const explain = {
    name: 'td_explain',
    description: '解释 mlir-tblgen 的报错文本：把原始 stderr 按 file:line:col 拆成条目，分类为 undefined-record / constraint / syntax / include / other，回填所属 def 记录名，并给出可执行的修复建议（fix）。纯文本分析，不跑 tblgen、不写磁盘。传 tdFile 或 source 才能定位行内原文并给出「该行应写成 …」的具体建议；未识别的报错 fix 为 null，绝不编造。崩溃栈会被过滤。',
    parameters: {
      type: 'object',
      properties: {
        stderr: { type: 'string', description: 'mlir-tblgen 的原始 stderr（多行原样粘贴）。' },
        tdFile: { type: 'string', description: '可选：对应的 .td 文件路径（按会话 cwd 解析），用于回填 record 与生成具体改法。' },
        source: { type: 'string', description: '可选：.td 原文；给了就不再读 tdFile，适合还没落盘的片段。' },
      },
      required: ['stderr'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: (_args, value) => {
        const rec = value !== null && typeof value === 'object' ? value : {};
        const items = Array.isArray(rec.items) ? rec.items : [];
        const lines = ['td_explain：识别出 ' + String(items.length) + ' 条报错'];
        for (const item of items) {
          lines.push('- [' + String(item.kind) + ']' +
            (item.record === null || item.record === undefined ? '' : ' ' + String(item.record)) +
            ' 第 ' + String(item.line) + ' 行:' + String(item.col) + ' —— ' + String(item.message));
          if (typeof item.fix === 'string' && item.fix !== '') lines.push('  修复：' + item.fix);
        }
        if (typeof rec.hint === 'string' && rec.hint !== '') lines.push('- 说明：' + rec.hint);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(rawArgs, exec) {
      const cwd = executionCwd(exec);
      const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {};
      const stderr = textOf(input.stderr);
      if (stderr.trim() === '') {
        return { items: [], hint: 'stderr 不能为空：把 mlir-tblgen 的原始报错粘进来（形如 file:line:col: error: message）。' };
      }
      const tdFile = textOf(input.tdFile).trim() === '' ? undefined : resolve(cwd, textOf(input.tdFile).trim());
      const report = explainReport({
        stderr,
        tdFile,
        source: typeof input.source === 'string' ? input.source : undefined,
        maxDiagnostics: config.maxDiagnostics,
      });
      return report;
    },
    timeoutMs: 10000,
  };

  return [scaffold, check, explain];
}

function flagOf(kind) {
  return CHECK_KINDS[kind] ?? '?';
}

/** 输入错误的中文提示：把前 3 条拼起来，避免 hint 过长。 */
function hintForInputErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const lines = errors.slice(0, 3).map((item) => (typeof item.field === 'string' ? item.field + '：' : '') + String(item.message));
  if (errors.length > 3) lines.push('… 还有 ' + String(errors.length - 3) + ' 条');
  return '入参不合法，未生成任何文件。' + lines.join('；');
}
