import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { buildTablegenTools } from '../lib/tools.js';
import { canSpawnExecutable, fakeExec, fileHashes, makeTempDir, realRunner } from './helpers.mjs';
import { threeOps } from './fixtures.mjs';

/** 真实 mlir-tblgen：默认用本机 LLVM 23.1.4 构建，也接受环境变量覆盖。 */
const TBLGEN = process.env.TD_MLIR_TBLGEN ?? 'D:/Code/llvm-build/bin/mlir-tblgen.exe';

const spawnBlocked = !(await canSpawnExecutable(TBLGEN));
const available = !spawnBlocked && existsSync(TBLGEN);
const reason = spawnBlocked
  ? '当前沙箱不允许 node 执行 ' + TBLGEN + '（EPERM），真实 tblgen 集成用例跳过'
  : (existsSync(TBLGEN) ? '真实 tblgen 不可用' : '找不到真实 mlir-tblgen：' + TBLGEN + '（可用 TD_MLIR_TBLGEN 指定）');
const skip = available ? false : reason;

function makeReal(dir) {
  const cfg = resolveConfig({ mlirTblgenPath: TBLGEN, timeoutMs: 60000, maxDiagnostics: 20 }, dir);
  const tools = buildTablegenTools(cfg, realRunner());
  return {
    cfg,
    definitions: Object.fromEntries(tools.map((definition) => [definition.name, definition])),
  };
}

/** 先生成 3 op 骨架，再把一段出错的 op 写成新的 .td（每个用例各用一个目录）。 */
async function scaffoldThenBad(dir, badFileName, badContent) {
  const { definitions } = makeReal(dir);
  const scaffolded = await definitions.td_scaffold.execute(
    { dialect: 'Toy', cppNamespace: '::toy', ops: threeOps(), outDir: 'td', validate: true },
    fakeExec(dir),
  );
  assert.equal(scaffolded.ok, true, scaffolded.hint ?? '');
  writeFileSync(join(dir, 'td', badFileName), badContent, 'utf8');
  return { definitions, scaffolded };
}

test('真实 tblgen：3 op 骨架生成 + 校验通过，两次生成逐字节一致', { skip }, async () => {
  const temp = makeTempDir('dsh-td-real-');
  try {
    const { definitions } = makeReal(temp.dir);
    const ops = threeOps();
    const first = await definitions.td_scaffold.execute(
      { dialect: 'Toy', cppNamespace: '::toy', ops, outDir: 'a', validate: true },
      fakeExec(temp.dir),
    );
    assert.equal(first.ok, true, first.hint ?? '');
    assert.equal(first.validation, 'passed');
    assert.equal(first.files.length, 7);

    const second = await definitions.td_scaffold.execute(
      { dialect: 'Toy', cppNamespace: '::toy', ops, outDir: 'b', validate: true },
      fakeExec(temp.dir),
    );
    assert.equal(second.ok, true);
    assert.deepEqual(
      fileHashes(second.files.map((file) => file.path)),
      fileHashes(first.files.map((file) => file.path)),
    );

    const checked = await definitions.td_check.execute({ tdDir: 'a' }, fakeExec(temp.dir));
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
    assert.equal(checked.crashed, false);
    assert.equal(checked.timedOut, false);
    assert.deepEqual(checked.kinds, ['op-decls', 'op-defs']);
  } finally {
    temp.cleanup();
  }
});

test('真实 tblgen：缺冒号的语法错误 → td_check syntax + td_explain 给出 (ins I32:$x)', { skip }, async () => {
  const temp = makeTempDir('dsh-td-syntax-');
  try {
    const bad = `include "ToyOps.td"

def Toy_BadOp : Toy_Op<"bad"> {
  let arguments = (ins
    I32 $x);
  let results = (outs
    I32:$r);
}
`;
    const { definitions } = await scaffoldThenBad(temp.dir, 'ToyBad.td', bad);
    const checked = await definitions.td_check.execute({ tdDir: 'td' }, fakeExec(temp.dir));
    assert.equal(checked.ok, false);
    const syntax = checked.errors.filter((item) => item.kind === 'syntax');
    assert.ok(syntax.length >= 1, JSON.stringify(checked.errors));
    assert.equal(syntax[0].record, 'Toy_BadOp');

    const explained = await definitions.td_explain.execute(
      { stderr: checked.stderr, tdFile: join(temp.dir, 'td', 'ToyBad.td') },
      fakeExec(temp.dir),
    );
    const target = explained.items.find((item) => item.record === 'Toy_BadOp');
    assert.ok(target, JSON.stringify(explained.items));
    assert.equal(target.line, syntax[0].line);
    assert.match(target.fix, /\(ins I32:\$x\)/);
  } finally {
    temp.cleanup();
  }
});

test('真实 tblgen：未定义记录 / 命名冲突 / include 缺失三类都能识别', { skip }, async () => {
  const cases = [
    {
      name: 'ToyUndef.td',
      content: `include "ToyOps.td"

def Toy_UndefOp : Toy_Op<"undef"> {
  let arguments = (ins
    NoSuchType:$x);
}
`,
      kind: 'undefined-record',
    },
    {
      name: 'ToyDup.td',
      content: `include "ToyOps.td"

def Toy_DupOp : Toy_Op<"dup"> {
  let arguments = (ins
    I32:$x,
    F32:$x);
}
`,
      kind: 'constraint',
    },
    {
      name: 'ToyNoInc.td',
      content: `include "NoSuchDialect.td"

def Toy_NoIncOp : Toy_Op<"noinc"> {
}
`,
      kind: 'include',
    },
  ];

  for (const item of cases) {
    const temp = makeTempDir('dsh-td-case-');
    try {
      const { definitions } = await scaffoldThenBad(temp.dir, item.name, item.content);
      const checked = await definitions.td_check.execute({ tdDir: 'td' }, fakeExec(temp.dir));
      assert.equal(checked.ok, false, item.name);
      const kinds = checked.errors.map((entry) => entry.kind);
      assert.ok(kinds.includes(item.kind), item.name + ' → ' + JSON.stringify(kinds));
      for (const entry of checked.errors) {
        assert.equal(String(entry.message).includes('PLEASE'), false);
        assert.equal(String(entry.message).includes('Stack dump'), false);
      }
      const explained = await definitions.td_explain.execute(
        { stderr: checked.stderr, tdFile: join(temp.dir, 'td', item.name) },
        fakeExec(temp.dir),
      );
      assert.ok(explained.items.some((entry) => entry.kind === item.kind), item.name);
    } finally {
      temp.cleanup();
    }
  }
});

test('真实 tblgen：outDir 含空格与中文也能生成并通过校验', { skip }, async () => {
  const temp = makeTempDir('dsh-td-cn-');
  try {
    const { definitions } = makeReal(temp.dir);
    const outDir = '空 格/中文 目录';
    const result = await definitions.td_scaffold.execute(
      { dialect: 'Toy', ops: threeOps(), outDir, validate: true },
      fakeExec(temp.dir),
    );
    assert.equal(result.ok, true, result.hint ?? '');
    assert.equal(result.files.length, 7);
    const checked = await definitions.td_check.execute({ tdDir: outDir }, fakeExec(temp.dir));
    assert.equal(checked.ok, true);
  } finally {
    temp.cleanup();
  }
});

test('真实 tblgen：不支持的 kind 给出工具链提示', { skip }, async () => {
  const temp = makeTempDir('dsh-td-kind-');
  try {
    const { definitions } = makeReal(temp.dir);
    const scaffolded = await definitions.td_scaffold.execute(
      { dialect: 'Toy', ops: threeOps(), outDir: 'td', validate: false },
      fakeExec(temp.dir),
    );
    assert.equal(scaffolded.ok, true);
    const checked = await definitions.td_check.execute(
      { tdDir: 'td', kinds: ['typedef-decls'] },
      fakeExec(temp.dir),
    );
    // LLVM 23.x 已没有 -gen-typedef-decls：必须识别为工具链不支持。
    assert.equal(checked.ok, false);
    assert.match(checked.hint, /不支持/);
  } finally {
    temp.cleanup();
  }
});
