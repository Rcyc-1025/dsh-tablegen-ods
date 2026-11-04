import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIAG_KINDS,
  classifyMessage,
  extractName,
  isCrashLine,
  looksCrashed,
  parseDiagnostics,
  recordAtLine,
  lineAt,
} from '../lib/diag.js';
import { BAD_SOURCE, DUP_STDERR, INCLUDE_STDERR, SYNTAX_STDERR, UNDEF_STDERR, UNKNOWN_STDERR, WRAPPED_DUP_STDERR } from './fixtures.mjs';

test('parseDiagnostics：终端软换行的续行会被接回去，kind 不吃瘪', () => {
  const parsed = parseDiagnostics(WRAPPED_DUP_STDERR);
  assert.equal(parsed.diagnostics.length, 1, JSON.stringify(parsed.diagnostics));
  const item = parsed.diagnostics[0];
  assert.equal(item.line, 3);
  assert.equal(item.col, 5);
  assert.equal(item.kind, 'constraint');
  assert.equal(item.message, "op has a conflict with two operands having the same name 'x'");
  assert.equal(parsed.crashed, true);
});

test('parseDiagnostics：语法错误带 file/line/col 与 record', () => {
  const parsed = parseDiagnostics(SYNTAX_STDERR, { recordFor: () => 'Toy_BadOp' });
  assert.equal(parsed.diagnostics.length, 1);
  const item = parsed.diagnostics[0];
  assert.equal(item.severity, 'error');
  assert.equal(item.kind, 'syntax');
  assert.equal(item.line, 5);
  assert.equal(item.col, 9);
  assert.equal(item.record, 'Toy_BadOp');
  assert.match(item.message, /expected '\)' in dag init/);
  assert.equal(parsed.crashed, false);
});

test('parseDiagnostics：未定义记录与 include 各归各类', () => {
  const undef = parseDiagnostics(UNDEF_STDERR);
  assert.equal(undef.diagnostics.length, 1);
  assert.equal(undef.diagnostics[0].kind, 'undefined-record');
  assert.equal(extractName(undef.diagnostics[0].message), 'NoSuchType');

  const inc = parseDiagnostics(INCLUDE_STDERR);
  // 同位置两条：include 与它引发的 Unexpected token at top level。
  assert.equal(inc.diagnostics.length, 2);
  assert.equal(inc.diagnostics[0].kind, 'include');
  assert.equal(inc.diagnostics[0].message, "could not find include file 'NoSuchDialect.td'");
  assert.equal(inc.diagnostics[1].kind, 'other');
});

test('parseDiagnostics：崩溃栈被过滤，crashed 只作附加信息', () => {
  const parsed = parseDiagnostics(DUP_STDERR);
  assert.equal(parsed.crashed, true);
  assert.equal(parsed.diagnostics.length, 1);
  const item = parsed.diagnostics[0];
  assert.equal(item.kind, 'constraint');
  for (const noise of ['PLEASE', 'Stack dump', 'Program arguments', '#0 0x', 'Running pass']) {
    assert.equal(item.message.includes(noise), false, noise);
  }
  assert.equal(parsed.diagnostics.some((entry) => entry.severity !== 'error'), false);
});

test('isCrashLine / looksCrashed：真实崩溃行命中，普通诊断行不命中', () => {
  const crashLines = [
    'PLEASE submit a bug report to https://github.com/llvm/llvm-project/issues/',
    'Stack dump:',
    '0.\tProgram arguments: mlir-tblgen.exe -gen-op-decls a.td',
    ' #0 0x00007ff6e2b81a4c (mlir-tblgen.exe+0x1c1a4c)',
    'LLVM ERROR: undefined behavior',
  ];
  for (const line of crashLines) assert.equal(isCrashLine(line), true, line);
  assert.equal(isCrashLine(SYNTAX_STDERR), false);
  assert.equal(looksCrashed(DUP_STDERR), true);
  assert.equal(looksCrashed(SYNTAX_STDERR), false);
  assert.equal(looksCrashed(''), false);
});

test('parseDiagnostics：warning 单独返回，不算失败；同条诊断去重', () => {
  const text = [
    'a.td:1:1: warning: unused template argument',
    'a.td:1:1: warning: unused template argument',
    'a.td:2:1: error: boom',
  ].join('\n');
  const parsed = parseDiagnostics(text);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.diagnostics.length, 1);
  assert.equal(parsed.diagnostics[0].message, 'boom');
  assert.equal(parsed.crashed, false);
});

test('parseDiagnostics：按 file/line/col 排序并按 maxDiagnostics 截断', () => {
  const text = [
    'b.td:9:1: error: second file',
    'a.td:7:3: error: later',
    'a.td:3:1: error: earlier',
  ].join('\n');
  const parsed = parseDiagnostics(text, { maxDiagnostics: 2 });
  assert.deepEqual(parsed.diagnostics.map((item) => item.message), ['earlier', 'later']);
  const all = parseDiagnostics(text);
  assert.deepEqual(all.diagnostics.map((item) => item.message), ['earlier', 'later', 'second file']);
});

test('classifyMessage：四类 + 未知', () => {
  assert.equal(classifyMessage("Variable not defined: 'X'"), 'undefined-record');
  assert.equal(classifyMessage("Unknown record 'X'"), 'undefined-record');
  assert.equal(classifyMessage("could not find include file 'X.td'"), 'include');
  assert.equal(classifyMessage("op has a conflict with two operands having the same name 'x'"), 'constraint');
  assert.equal(classifyMessage("expected ')' in dag init"), 'syntax');
  assert.equal(classifyMessage('something nobody has seen before'), 'other');
  assert.equal(UNKNOWN_STDERR.includes('error:'), true);
  assert.deepEqual(DIAG_KINDS, ['undefined-record', 'constraint', 'syntax', 'include', 'other']);
});

test('recordAtLine：向上找最近的 def/defm/class，越界不抛', () => {
  assert.equal(recordAtLine(BAD_SOURCE, 5), 'Toy_BadOp');
  assert.equal(recordAtLine(BAD_SOURCE, 1), null);
  assert.equal(recordAtLine(BAD_SOURCE, 9999), 'Toy_BadOp');
  assert.equal(recordAtLine('', 1), null);
  assert.equal(recordAtLine(null, 1), null);
  assert.equal(lineAt(BAD_SOURCE, 5), '    I32 $x);');
  assert.equal(lineAt(BAD_SOURCE, 9999), null);
});
