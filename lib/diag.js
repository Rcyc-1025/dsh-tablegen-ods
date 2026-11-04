/** 诊断类别；与需求文档 5.1 的 kind 一一对应。 */
export const DIAG_KINDS = ['undefined-record', 'constraint', 'syntax', 'include', 'other'];

/** `path:line:col: error: message`；路径可能带 Windows 盘符，用非贪婪前缀。 */
const DIAG_RE = /^(.*?):(\d+):(\d+):\s*(error|warning|note|remark):\s*(.*)$/;

/** tblgen 崩溃时打印的噪声行：不能当成诊断消息返回给模型。 */
const CRASH_PATTERNS = [
  /^PLEASE\s+submit\s+a\s+bug\s+report/i,
  /^Stack\s+dump/i,
  /^Program\s+arguments?\s*:/i,
  /^\d+\.\s/,                       // 0.	Program arguments: ...
  /^\s*Stack\s+dump/i,
  /^LLVM\s+ERROR\s*:/i,
  /^#\d+\s+0x[0-9a-f]+/i,           // 栈帧 #0 0x...
  /^llvm::/i,
];

/** 是否是崩溃噪声行。 */
export function isCrashLine(line) {
  const text = typeof line === 'string' ? line.trim() : '';
  if (text === '') return false;
  return CRASH_PATTERNS.some((pattern) => pattern.test(text));
}

/** stderr 里是否出现崩溃迹象（用于 crashed 标记，不影响 message）。 */
export function looksCrashed(stderr) {
  const text = typeof stderr === 'string' ? stderr : '';
  return /PLEASE\s+submit\s+a\s+bug\s+report|Stack\s+dump|LLVM\s+ERROR\s*:/i.test(text);
}

/**
 * 按消息文本分类；分类只依赖消息本身，未知一律 other（不伪造 fix）。
 * @returns {'undefined-record'|'constraint'|'syntax'|'include'|'other'}
 */
export function classifyMessage(message) {
  const text = typeof message === 'string' ? message : '';
  if (/Variable not defined/i.test(text) || /Unknown (record|type|class)/i.test(text)) return 'undefined-record';
  if (/could not find include file|include file not found/i.test(text)) return 'include';
  if (/op has a conflict with two operands having the same name/i.test(text)) return 'constraint';
  if (/^expected\b/i.test(text) || /\bexpected\b .*\bin (dag init|top level)\b/i.test(text)) return 'syntax';
  return 'other';
}

/** 从 `Variable not defined: 'X'` / `include file 'X.td'` 里抠出名字。 */
export function extractName(message) {
  const quoted = /['"]([^'"]+)['"]/.exec(String(message === null || message === undefined ? '' : message));
  return quoted === null ? null : quoted[1];
}

/**
 * 把被终端软换行拆开的诊断行接回去。
 * Windows 终端（PowerShell 管道）会把长行按窗口宽度折行，续行以一个空格开头；
 * 只接「上一条是诊断行 + 恰一个空格 + 非空白」的续行，源码摘录（多个空格）不受影响。
 */
export function rejoinWrappedLines(text) {
  const lines = String(text === null || text === undefined ? '' : text).split(/\r?\n/);
  const out = [];
  let pending = null;
  const flush = () => {
    if (pending !== null) out.push(pending);
    pending = null;
  };
  for (const line of lines) {
    if (pending !== null && /^ [^ \t]/.test(line) && !isCrashLine(line)) {
      pending = pending + ' ' + line.slice(1).trim();
      continue;
    }
    flush();
    if (DIAG_RE.test(line)) {
      pending = line;
      continue;
    }
    out.push(line);
  }
  flush();
  return out.join('\n');
}

/**
 * 解析 stderr 里的诊断行，过滤崩溃噪声、按 file/line/message 去重、按 file/line/col 排序。
 * @param stderr - tblgen 的 stderr。
 * @param options.maxDiagnostics - 最多返回多少条（只截断 error 之后的总数）。
 * @param options.recordFor - (file, line) => record|null，用于回填所属 def。
 * @returns {{diagnostics: object[], warnings: object[], crashed: boolean}}
 */
export function parseDiagnostics(stderr, options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const max = typeof opts.maxDiagnostics === 'number' && Number.isFinite(opts.maxDiagnostics)
    ? Math.max(1, Math.trunc(opts.maxDiagnostics))
    : 100;
  const recordFor = typeof opts.recordFor === 'function' ? opts.recordFor : null;
  const lines = rejoinWrappedLines(stderr).split(/\r?\n/);
  const seen = new Set();
  const all = [];
  for (const raw of lines) {
    if (isCrashLine(raw)) continue;
    const match = DIAG_RE.exec(raw);
    if (match === null) continue;
    const file = match[1].trim();
    const line = Number(match[2]);
    const col = Number(match[3]);
    const severity = match[4].toLowerCase();
    const message = match[5].trim();
    if (message === '' || isCrashLine(message)) continue;
    const key = file + ':' + String(line) + ':' + String(col) + ':' + message;
    if (seen.has(key)) continue;
    seen.add(key);
    let record = null;
    if (recordFor !== null) {
      try {
        record = recordFor(file, line);
      } catch {
        record = null;
      }
    }
    all.push({
      file,
      line,
      col,
      severity,
      kind: classifyMessage(message),
      record: typeof record === 'string' && record !== '' ? record : null,
      message,
    });
  }
  all.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || a.col - b.col);
  const diagnostics = all.filter((item) => item.severity === 'error').slice(0, max);
  const warnings = all.filter((item) => item.severity === 'warning').slice(0, max);
  return { diagnostics, warnings, crashed: looksCrashed(stderr) };
}

/** 从报错行向上扫最近的 `def <Record>` / `class <Record>`；找不到返回 null。 */
export function recordAtLine(source, line) {
  if (typeof source !== 'string' || source === '') return null;
  const lines = source.split(/\r?\n/);
  const start = Math.min(Math.max(1, Number.isFinite(line) ? line : 1), lines.length) - 1;
  for (let index = start; index >= 0; index -= 1) {
    const match = /^\s*(?:def|defm|class)\s+([A-Za-z][A-Za-z0-9_]*)/.exec(lines[index]);
    if (match !== null) return match[1];
  }
  return null;
}

/** 取某一行的原文（越界返回 null）。 */
export function lineAt(source, line) {
  if (typeof source !== 'string' || source === '') return null;
  const lines = source.split(/\r?\n/);
  const index = Math.max(1, Number.isFinite(line) ? line : 1) - 1;
  return index < lines.length ? lines[index] : null;
}
