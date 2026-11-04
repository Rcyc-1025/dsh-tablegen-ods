import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_RE,
  normalizeDialect,
  normalizeNamespace,
  normalizeOp,
  expandTypeConstraint,
  checkParamName,
  escapeTdString,
} from '../lib/naming.js';

test('normalizeDialect：toy / Toy / ToyDialect 归一到 Toy', () => {
  for (const raw of ['toy', 'Toy', 'ToyDialect', '  Toy  ']) {
    const info = normalizeDialect(raw);
    assert.equal(info.ok, true, raw);
    assert.equal(info.dialect, 'Toy');
    assert.equal(info.lower, 'toy');
  }
});

test('normalizeDialect：空、路径、空白、$、.. 一律拒绝', () => {
  for (const raw of ['', '   ', 'a/b', 'a\\b', 'to y', 'to$y', '..', 'Toy..Dialect', 42]) {
    assert.equal(normalizeDialect(raw).ok, false, String(raw));
  }
  assert.equal(normalizeDialect('Dialect').ok, false);
});

test('normalizeNamespace：缺省 ::toy，支持多段与 :: 前缀', () => {
  assert.equal(normalizeNamespace(undefined, 'toy').cppNamespace, '::toy');
  assert.equal(normalizeNamespace('', 'toy').cppNamespace, '::toy');
  assert.equal(normalizeNamespace('toy', 'toy').cppNamespace, '::toy');
  assert.equal(normalizeNamespace('::toy', 'toy').cppNamespace, '::toy');
  assert.equal(normalizeNamespace('foo::Bar2', 'toy').cppNamespace, '::foo::Bar2');
  assert.equal(normalizeNamespace('foo::', 'toy').ok, false);
  assert.equal(normalizeNamespace('::1toy', 'toy').ok, false);
  assert.equal(normalizeNamespace('foo bar', 'toy').ok, false);
});

test('normalizeOp：四种写法都归一到同一条记录', () => {
  const toy = normalizeDialect('Toy');
  const expected = { record: 'Toy_AddOp', mnemonic: 'toy.add', name: 'Add' };
  for (const raw of ['Add', 'AddOp', 'Toy_AddOp', 'toy.add']) {
    const op = normalizeOp(raw, toy);
    assert.equal(op.ok, true, raw);
    assert.equal(op.record, expected.record, raw);
    assert.equal(op.mnemonic, expected.mnemonic, raw);
    assert.equal(op.name, expected.name, raw);
  }
});

test('normalizeOp：方言前缀不匹配 / 多重点 / 非法字符都拒绝', () => {
  const toy = normalizeDialect('Toy');
  assert.equal(normalizeOp('other.add', toy).ok, false);
  assert.equal(normalizeOp('toy.add.extra', toy).ok, false);
  assert.equal(normalizeOp('toy.', toy).ok, false);
  assert.equal(normalizeOp('.add', toy).ok, false);
  assert.equal(normalizeOp('', toy).ok, false);
  assert.equal(normalizeOp('..', toy).ok, false);
  assert.equal(normalizeOp('a/b', toy).ok, false);
  assert.equal(normalizeOp('a b', toy).ok, false);
  assert.equal(normalizeOp('toy.add$x', toy).ok, false);
  assert.equal(normalizeOp('toy_', toy).ok, false);
});

test('expandTypeConstraint：别名归一、Variadic 递归、其余原样透传', () => {
  assert.deepEqual(expandTypeConstraint('i32'), { ok: true, error: null, text: 'I32' });
  assert.deepEqual(expandTypeConstraint('ANYMEMREF'), { ok: true, error: null, text: 'AnyMemRef' });
  assert.deepEqual(expandTypeConstraint('Variadic<i32>'), { ok: true, error: null, text: 'Variadic<I32>' });
  assert.deepEqual(expandTypeConstraint('Variadic<Variadic<F32>>'), { ok: true, error: null, text: 'Variadic<Variadic<F32>>' });
  assert.deepEqual(expandTypeConstraint('MyCustomType'), { ok: true, error: null, text: 'MyCustomType' });
  for (const bad of ['', '   ', 'I32"', 'I32$', 'I32;', 'I32{', 'a/b', 'a\\b', '..', 'I3\u00072']) {
    assert.equal(expandTypeConstraint(bad).ok, false, String(bad));
  }
});

test('checkParamName：允许下划线开头，拒绝 $、空白、路径', () => {
  assert.equal(checkParamName('lhs', 'operand').ok, true);
  assert.equal(checkParamName('_tmp2', 'operand').ok, true);
  for (const bad of ['', ' ', '$x', 'a b', 'a/b', 'a.b', '1x']) {
    assert.equal(checkParamName(bad, 'operand').ok, false, bad);
  }
});

test('escapeTdString：反斜杠、引号、换行', () => {
  assert.equal(escapeTdString('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapeTdString('a\\b'), 'a\\\\b');
  assert.equal(escapeTdString('a\nb'), 'a\\nb');
  assert.equal(escapeTdString('a\r\nb'), 'a\\nb');
});

test('RECORD_RE 与 ODS 记录名规则一致', () => {
  assert.equal(RECORD_RE.test('Toy_AddOp'), true);
  assert.equal(RECORD_RE.test('1Toy'), false);
  assert.equal(RECORD_RE.test('Toy-Add'), false);
});
