import { readFileSync } from 'node:fs';
import { parseDiagnostics } from './diag.js';
import { classifyMessage, extractName, lineAt } from './diag.js';

/**
 * 纯文本分析 tblgen 的 stderr：不跑 tblgen、不写文件。
 * 输入可带 source（.td 原文）或 tdFile（可读路径），用于定位 record 与生成具体修复建议。
 * @returns {{items: object[], hint: string|null}}
 */
export function explainReport(input) {
  const args = input !== null && typeof input === 'object' ? input : {};
  const stderr = typeof args.stderr === 'string' ? args.stderr : '';
  const maxDiagnostics = typeof args.maxDiagnostics === 'number' ? args.maxDiagnostics : 100;
  const providedSource = typeof args.source === 'string' ? args.source : null;
  const fileSource = readIfPossible(args.tdFile);

  const parsed = parseDiagnostics(stderr, {
    maxDiagnostics,
    recordFor: (file, line) => recordFor(file, line, providedSource, fileSource, args.tdFile),
  });

  const items = parsed.diagnostics.map((item) => {
    const text = sourceLineFor(item, providedSource, fileSource, args.tdFile);
    const block = sourceBlockFor(item, providedSource, fileSource, args.tdFile);
    return {
      record: item.record,
      line: item.line,
      col: item.col,
      kind: item.kind,
      message: item.message,
      fix: fixFor(item.kind, item.message, text, block),
    };
  });

  return { items, hint: hintFor(items, parsed, args) };
}

function readIfPossible(path) {
  if (typeof path !== 'string' || path.trim() === '') return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 判断某个诊断所属文件是不是我们手里那份源码：优先按文件名后缀比对，再退化到唯一文件。 */
function sourceLineFor(item, providedSource, fileSource, tdFile) {
  const candidates = [];
  if (providedSource !== null) candidates.push({ source: providedSource, file: null });
  if (fileSource !== null) candidates.push({ source: fileSource, file: tdFile });
  if (candidates.length === 1) return lineAt(candidates[0].source, item.line);
  for (const candidate of candidates) {
    if (candidate.file !== null && sameFile(candidate.file, item.file)) return lineAt(candidate.source, item.line);
  }
  return candidates.length > 0 ? lineAt(candidates[0].source, item.line) : null;
}

function recordFor(_file, line, providedSource, fileSource, tdFile) {
  for (const source of [providedSource, fileSource]) {
    if (source === null) continue;
    const record = recordAt(source, line);
    if (record !== null) return record;
  }
  void tdFile;
  return null;
}

function recordAt(source, line) {
  const lines = source.split(/\r?\n/);
  const start = Math.min(Math.max(1, line), lines.length) - 1;
  for (let index = start; index >= 0; index -= 1) {
    const match = /^\s*(?:def|defm|class)\s+([A-Za-z][A-Za-z0-9_]*)/.exec(lines[index]);
    if (match !== null) return match[1];
  }
  return null;
}

/**
 * 取出报错行所在的 `(ins ...)` / `(outs ...)` 参数块（跨行时向上找开头、向下找右括号），
 * 用来把修复建议写成完整片段，例如 `(ins I32:$x)`。
 */
function sourceBlockFor(item, providedSource, fileSource, tdFile) {
  const line = sourceLineFor(item, providedSource, fileSource, tdFile);
  const source = matchingSource(item, providedSource, fileSource, tdFile);
  if (source === null) return null;
  if (typeof line === 'string' && /\(\s*(ins|outs)\b/.test(line)) return line;
  const lines = source.split(/\r?\n/);
  const index = Math.min(Math.max(1, item.line), lines.length) - 1;
  let head = -1;
  for (let cursor = index; cursor >= Math.max(0, index - 8); cursor -= 1) {
    if (/\(\s*(ins|outs)\b/.test(lines[cursor])) {
      head = cursor;
      break;
    }
  }
  if (head === -1) return typeof line === 'string' ? line : null;
  const collected = [];
  for (let cursor = head; cursor < lines.length && collected.length < 16; cursor += 1) {
    collected.push(lines[cursor]);
    if (/\)\s*;?\s*$/.test(lines[cursor]) && cursor > head) break;
  }
  return collected.join('\n');
}

/** 与某条诊断对应的源码：优先显式 source，其次 tdFile 的读取结果。 */
function matchingSource(item, providedSource, fileSource, tdFile) {
  void item;
  void tdFile;
  if (providedSource !== null) return providedSource;
  return fileSource;
}

function sameFile(a, b) {
  const left = String(a).replace(/\\/g, '/').toLowerCase();
  const right = String(b).replace(/\\/g, '/').toLowerCase();
  return left === right || left.endsWith('/' + right) || right.endsWith('/' + left);
}

/** 按 kind 给出可执行的修复建议；未知类别返回 null，绝不编造。 */
export function fixFor(kind, message, lineText, blockText) {
  const text = typeof message === 'string' ? message : '';
  const name = extractName(text);
  if (kind === 'undefined-record') {
    return name === null
      ? '记录未定义：include 定义它的 .td，或检查拼写与大小写。'
      : "记录 '" + name + "' 未定义：include 定义它的 .td（例如 include \"" + name + "Defs.td\"），或检查拼写/大小写。";
  }
  if (kind === 'include') {
    return name === null
      ? '找不到 include 文件：确认文件存在，并把它所在的目录加进 includeDirs。'
      : "找不到 include 文件 '" + name + "'：确认该文件存在，并把它所在的目录加进 includeDirs（或让 tdDir 指向包含它的目录）。";
  }
  if (kind === 'constraint') {
    const duplicate = /same name\s+'([^']+)'/i.exec(text);
    if (duplicate !== null) {
      return '参数名 $' + duplicate[1] + ' 重复：同一 op 内 operand/result/attribute 名必须唯一，改名（例如 $lhs / $rhs）。';
    }
    return '约束冲突：检查同一 op 里的参数名与类型约束是否互相矛盾，必要时拆成两个 op。';
  }
  if (kind === 'syntax') return syntaxFix(text, lineText, blockText);
  return null;
}

/** 把跨行参数块压成一行，便于在建议里原样引用。 */
function normalizeSpace(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/** 语法类修复：能拿到原文就把 `(ins I32 $x)` 这类改写成 `(ins I32:$x)`。 */
function syntaxFix(message, lineText, blockText) {
  const block = typeof blockText === 'string' && blockText !== '' ? blockText : null;
  const repairedBlock = block === null ? null : repairParamLine(block);
  if (repairedBlock !== null && repairedBlock !== block) {
    const quoted = normalizeSpace(repairedBlock).replace(/^let\s+[A-Za-z0-9_]+\s*=\s*/, '');
    return '参数缺少冒号：该参数块应写成 `' + quoted +
      '`（类型与名字之间用冒号连接，名字带 $）。';
  }
  const repaired = typeof lineText === 'string' ? repairParamLine(lineText) : null;
  const expected = /expected\s+'([^']*)'/i.exec(message);
  const token = expected === null ? null : expected[1];
  if (repaired !== null && repaired !== lineText) {
    return '参数缺少冒号或写法不完整，该行应写成：`' + normalizeSpace(repaired) + '`。';
  }
  if (token === ':') {
    return '缺少冒号：参数要写成 `类型:$名字`，例如 `(ins I32:$x)`。';
  }
  if (token === ')') {
    return '缺少右括号：检查 `(ins ...)` / `(outs ...)` 的括号与逗号是否配对；参数写成 `类型:$名字`，例如 `(ins I32:$x)`。';
  }
  if (token !== null && token !== '') {
    return "缺少 '" + token + "'：按 ODS 语法补齐该符号；参数写成 `类型:$名字`，例如 `(ins I32:$x)`。";
  }
  return '按 ODS 语法修正该行：参数写成 `类型:$名字`（如 `(ins I32:$x)`），并检查括号/逗号是否配对。';
}

/**
 * 把 `(ins I32 $x)` / `(outs I32 result)` 修成 `(ins I32:$x)` / `(outs I32:$result)`。
 * 只做「类型与名字之间缺冒号」这一种确定性改写，其他内容保持原样。
 */
export function repairParamLine(lineText) {
  if (typeof lineText !== 'string' || lineText === '') return null;
  return lineText.replace(/\((ins|outs)\b([^)]*)\)/g, (whole, head, body) => {
    const tokens = splitTopLevel(body);
    let changed = false;
    const out = tokens.map((token) => {
      const trimmed = token.trim();
      if (trimmed === '') return token;
      // 只认「类型 名字」与「类型 $名字」两种残缺写法；`类型:$名字` 本身不会命中。
      const match = /^([A-Za-z0-9_<>\[\]:]+)\s+(\$?)([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
      if (match === null) return token;
      changed = true;
      return token.replace(trimmed, match[1] + ':$' + match[3]);
    });
    return changed ? '(' + head + out.join(',') + ')' : whole;
  });
}

/** 按顶层逗号切分（忽略 <> 与 () 里的逗号）。 */
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '<' || char === '(' || char === '[') depth += 1;
    if (char === '>' || char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

function hintFor(items, parsed, args) {
  if (items.length === 0) {
    return '没有从 stderr 里识别出 TableGen 诊断行（形如 file:line:col: error: message）；崩溃栈与提示行会被忽略。' +
      '确认输入是 mlir-tblgen 的原始 stderr。';
  }
  const notes = [];
  const unknown = items.filter((item) => item.kind === 'other').length;
  if (unknown > 0) notes.push('其中 ' + String(unknown) + ' 条暂未识别的 TableGen 报错（fix 为 null），按原文处理。');
  if (items.some((item) => item.record === null)) {
    notes.push('部分报错定位不到 record：传 tdFile 或 source（.td 原文）可以回填所属 def。');
  }
  if (parsed.crashed) notes.push('输入里含 tblgen 崩溃栈，已过滤，不作为报错消息。');
  if (args !== null && typeof args === 'object' && typeof args.tdFile === 'string' && args.tdFile.trim() !== '' && readIfPossible(args.tdFile) === null) {
    notes.push('tdFile 读不到：' + args.tdFile);
  }
  return notes.length === 0 ? null : notes.join(' ');
}

export { classifyMessage };
