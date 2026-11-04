import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { explainReport, repairParamLine } from '../lib/explain.js';
import { makeTempDir } from './helpers.mjs';
import { BAD_SOURCE, DUP_STDERR, INCLUDE_STDERR, SYNTAX_STDERR, UNDEF_STDERR, UNKNOWN_STDERR } from './fixtures.mjs';

test('explainReport：语法错误回填 record/line 并给出 `(ins I32:$x)`', () => {
  const report = explainReport({ stderr: SYNTAX_STDERR, source: BAD_SOURCE });
  assert.equal(report.items.length, 1);
  const item = report.items[0];
  assert.equal(item.record, 'Toy_BadOp');
  assert.equal(item.line, 5);
  assert.equal(item.col, 9);
  assert.equal(item.kind, 'syntax');
  assert.match(item.fix, /\(ins I32:\$x\)/);
  assert.equal(report.hint, null);
});

test('explainReport：未定义记录建议 include 或改拼写', () => {
  const source = 'def Toy_UndefOp : Toy_Op<"undef"> {\n  let arguments = (ins\n    NoSuchType:$x);\n}\n';
  const report = explainReport({ stderr: UNDEF_STDERR, source });
  assert.equal(report.items.length, 1);
  const item = report.items[0];
  assert.equal(item.kind, 'undefined-record');
  assert.equal(item.record, 'Toy_UndefOp');
  assert.match(item.fix, /NoSuchType/);
  assert.match(item.fix, /include/);
});

test('explainReport：include 缺失指向 includeDirs', () => {
  const report = explainReport({ stderr: INCLUDE_STDERR });
  assert.equal(report.items.length, 2);
  assert.equal(report.items[0].kind, 'include');
  assert.match(report.items[0].fix, /includeDirs/);
  // 第二条是连带错误，未识别就保持 fix:null。
  assert.equal(report.items[1].fix, null);
  assert.match(report.hint, /未识别/);
});

test('explainReport：崩溃栈不进 items，只留真正的报错', () => {
  const report = explainReport({ stderr: DUP_STDERR });
  assert.equal(report.items.length, 1);
  const item = report.items[0];
  assert.equal(item.kind, 'constraint');
  assert.match(item.fix, /\$x/);
  assert.equal(JSON.stringify(report.items).includes('PLEASE'), false);
  assert.match(report.hint, /崩溃栈/);
});

test('explainReport：未识别报错 fix 为 null 且 hint 说明', () => {
  const report = explainReport({ stderr: UNKNOWN_STDERR });
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].kind, 'other');
  assert.equal(report.items[0].fix, null);
  assert.match(report.hint, /未识别/);
});

test('explainReport：空 stderr 返回空 items 与提示', () => {
  const report = explainReport({ stderr: '   \n\n' });
  assert.deepEqual(report.items, []);
  assert.match(report.hint, /stderr/);
});

test('explainReport：只给 tdFile 也能回填 record 与行内原文', () => {
  const temp = makeTempDir();
  try {
    const file = join(temp.dir, 'ToyBad.td');
    writeFileSync(file, BAD_SOURCE, 'utf8');
    const stderr = `${file}:5:9: error: expected ')' in dag init`;
    const report = explainReport({ stderr, tdFile: file });
    assert.equal(report.items[0].record, 'Toy_BadOp');
    assert.match(report.items[0].fix, /\(ins I32:\$x\)/);
  } finally {
    temp.cleanup();
  }
});

test('repairParamLine：只补「类型与名字之间缺冒号」，其余原样', () => {
  assert.equal(repairParamLine('  let arguments = (ins I32 $x);'), '  let arguments = (ins I32:$x);');
  assert.equal(repairParamLine('(outs I32 result)'), '(outs I32:$result)');
  assert.equal(repairParamLine('(ins I32 $x, F32 $y)'), '(ins I32:$x, F32:$y)');
  assert.equal(repairParamLine('(ins Variadic<I32> $xs)'), '(ins Variadic<I32>:$xs)');
  assert.equal(repairParamLine('(ins I32:$x)'), '(ins I32:$x)');
  assert.equal(repairParamLine('no parens here'), 'no parens here');
  assert.equal(repairParamLine(''), null);
  assert.equal(repairParamLine(null), null);
  // 多行参数块（td_explain 在报错行只是片段时会向上取整块），只补冒号、其余排版保持原样
  assert.equal(
    repairParamLine('let arguments = (ins\n    I32 $x,\n    F32 $y)'),
    'let arguments = (ins\n    I32:$x,\n    F32:$y)',
  );
});
