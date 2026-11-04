import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { buildTablegenTools } from '../lib/tools.js';
import { fakeExec, fileHashes, makeTempDir, recordingRunner } from './helpers.mjs';
import { DUP_STDERR, SYNTAX_STDERR, SYNTAX_STDERR as _syntax, threeOps } from './fixtures.mjs';

/** 建一套工具：假 tblgen 路径（只需存在）+ 可控 runner。 */
function makeToolset(handler) {
  const temp = makeTempDir();
  const exe = join(temp.dir, 'mlir-tblgen.exe');
  writeFileSync(exe, '', 'utf8');
  const cfg = resolveConfig({ mlirTblgenPath: exe, timeoutMs: 5000, maxDiagnostics: 10 }, temp.dir);
  const { runner, calls } = recordingRunner(handler);
  const tools = buildTablegenTools(cfg, runner);
  return {
    temp,
    exe,
    calls,
    tools,
    outDir: join(temp.dir, 'out'),
    tdDir: join(temp.dir, 'td'),
    definitions: Object.fromEntries(tools.map((definition) => [definition.name, definition])),
  };
}

const exec = (dir) => fakeExec(dir);
const okResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };

/** ---------------------------------------------------------------- td_scaffold */

test('td_scaffold：ops 为空 / 名字非法 / 参数重名 / type 为空都拒绝且不建目录', async () => {
  const set = makeToolset(() => okResult);
  try {
    const ctx = exec(set.temp.dir);
    const cases = [
      { ops: [] },
      { ops: [{ name: '../evil' }] },
      { ops: [{ name: 'Add', operands: [{ name: 'x', type: 'I32' }, { name: 'x', type: 'I32' }] }] },
      { ops: [{ name: 'Add', operands: [{ name: 'x', type: '' }] }] },
      { ops: [{ name: 'Add' }, { name: 'AddOp' }] },
    ];
    for (const extra of cases) {
      const result = await set.definitions.td_scaffold.execute(
        { dialect: 'Toy', outDir: set.outDir, validate: false, ...extra },
        ctx,
      );
      assert.equal(result.ok, false, JSON.stringify(extra));
      assert.ok(result.errors.length > 0, JSON.stringify(extra));
    }
    assert.equal(existsSync(set.outDir), false);
  } finally {
    set.temp.cleanup();
  }
});

test('td_scaffold：validate:false 写入 7 个文件，且两次生成逐字节一致', async () => {
  const set = makeToolset(() => okResult);
  try {
    const ctx = exec(set.temp.dir);
    const first = await set.definitions.td_scaffold.execute(
      { dialect: 'Toy', cppNamespace: '::toy', ops: threeOps(), outDir: 'out', validate: false },
      ctx,
    );
    assert.equal(first.ok, true);
    assert.equal(first.validation, 'skipped');
    assert.equal(first.files.length, 7);
    const names = first.files.map((file) => file.path.split(/[\\/]/).pop()).sort();
    assert.deepEqual(names, [
      'CMakeLists.txt',
      'ToyDialect.cpp',
      'ToyDialect.h',
      'ToyDialect.td',
      'ToyOps.cpp',
      'ToyOps.h',
      'ToyOps.td',
    ]);
    const hashesA = fileHashes(first.files.map((file) => file.path));

    const second = await set.definitions.td_scaffold.execute(
      { dialect: 'Toy', cppNamespace: '::toy', ops: threeOps(), outDir: 'out2', validate: false },
      ctx,
    );
    assert.equal(second.ok, true);
    assert.deepEqual(fileHashes(second.files.map((file) => file.path)), hashesA);
    // 生成物里不能出现绝对路径或时间戳
    const opsTd = readFileSync(join(set.temp.dir, 'out2', 'ToyOps.td'), 'utf8');
    assert.equal(opsTd.includes(set.temp.dir), false);
    assert.match(opsTd, /def Toy_AddOp : Toy_Op<"add">/);
  } finally {
    set.temp.cleanup();
  }
});

test('td_scaffold：Ops.h 带上 BytecodeOpInterface include（含 attributes 的 op 才能编译）', async () => {
  const set = makeToolset(() => okResult);
  try {
    const result = await set.definitions.td_scaffold.execute(
      {
        dialect: 'Toy',
        outDir: 'out',
        validate: false,
        ops: [{
          name: 'Add',
          operands: [{ name: 'lhs', type: 'I32' }],
          results: [{ name: 'result', type: 'I32' }],
          attributes: [{ name: 'value', type: 'I32Attr' }],
        }],
      },
      exec(set.temp.dir),
    );
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const header = readFileSync(join(set.outDir, 'ToyOps.h'), 'utf8');
    assert.match(header, /#include "mlir\/Bytecode\/BytecodeOpInterface\.h"/);
  } finally {
    set.temp.cleanup();
  }
});

test('td_scaffold：overwrite:false 冲突时一个字节都不写；overwrite:true 只覆盖 7 个文件', async () => {
  const set = makeToolset(() => okResult);
  try {
    const ctx = exec(set.temp.dir);
    const input = { dialect: 'Toy', ops: threeOps(), outDir: 'out', validate: false };
    const first = await set.definitions.td_scaffold.execute(input, ctx);
    assert.equal(first.ok, true);
    const before = fileHashes(first.files.map((file) => file.path));
    writeFileSync(join(set.outDir, 'keep.txt'), 'keep me', 'utf8');

    const conflict = await set.definitions.td_scaffold.execute(input, ctx);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.validation, 'skipped');
    assert.equal(conflict.conflicts.length, 7);
    assert.deepEqual(fileHashes(first.files.map((file) => file.path)), before, '冲突时旧文件字节必须不变');

    const overwritten = await set.definitions.td_scaffold.execute({ ...input, overwrite: true }, ctx);
    assert.equal(overwritten.ok, true);
    assert.equal(overwritten.files.length, 7);
    assert.equal(readFileSync(join(set.outDir, 'keep.txt'), 'utf8'), 'keep me', 'overwrite 不该删别的文件');
    assert.equal(readdirSync(set.outDir).length, 8);
  } finally {
    set.temp.cleanup();
  }
});

test('td_scaffold：validate:true 跑 4 次 tblgen，通过才提交', async () => {
  const set = makeToolset(() => okResult);
  try {
    const result = await set.definitions.td_scaffold.execute(
      { dialect: 'Toy', ops: threeOps(), outDir: 'out' },
      exec(set.temp.dir),
    );
    assert.equal(result.ok, true);
    assert.equal(result.validation, 'passed');
    assert.equal(set.calls.length, 4);
    const flags = set.calls.map((call) => call.argv[1]);
    assert.deepEqual(flags, ['-gen-dialect-decls', '-gen-dialect-defs', '-gen-op-decls', '-gen-op-defs']);
    // 每次都有 -I 临时目录，且不写 .inc 到用户目录
    for (const call of set.calls) assert.ok(call.argv.includes('-I'));
    assert.deepEqual(readdirSync(set.outDir).sort(), [
      'CMakeLists.txt',
      'ToyDialect.cpp',
      'ToyDialect.h',
      'ToyDialect.td',
      'ToyOps.cpp',
      'ToyOps.h',
      'ToyOps.td',
    ]);
  } finally {
    set.temp.cleanup();
  }
});

test('td_scaffold：校验失败 → ok:false、validation:failed、不提交文件', async () => {
  const bad = 'C:\\tmp\\ToyOps.td:3:1: error: expected \')\' in dag init';
  const set = makeToolset(() => ({ exitCode: 1, stdout: '', stderr: bad, timedOut: false }));
  try {
    const result = await set.definitions.td_scaffold.execute(
      { dialect: 'Toy', ops: threeOps(), outDir: 'out' },
      exec(set.temp.dir),
    );
    assert.equal(result.ok, false);
    assert.equal(result.validation, 'failed');
    assert.equal(result.files.length, 0);
    assert.ok(result.errors.length > 0);
    assert.equal(result.errors[0].kind, 'syntax');
    assert.equal(existsSync(set.outDir), false, '校验失败不许落盘');
  } finally {
    set.temp.cleanup();
  }
});

test('td_scaffold：找不到 mlir-tblgen 时 ok:false + 中文 hint，不抛异常', async () => {
  const temp = makeTempDir();
  try {
    const cfg = resolveConfig({ mlirTblgenPath: join(temp.dir, 'nope', 'mlir-tblgen.exe') }, temp.dir);
    const tools = buildTablegenTools(cfg, async () => okResult);
    const scaffold = tools.find((tool) => tool.name === 'td_scaffold');
    const result = await scaffold.execute(
      { dialect: 'Toy', ops: threeOps(), outDir: 'out' },
      exec(temp.dir),
    );
    assert.equal(result.ok, false);
    assert.equal(result.validation, 'failed');
    assert.match(result.hint, /mlirTblgenPath/);
    assert.equal(existsSync(join(temp.dir, 'out')), false);
  } finally {
    temp.cleanup();
  }
});

test('td_scaffold：outDir 含空格与中文可用', async () => {
  const set = makeToolset(() => okResult);
  try {
    const outDir = join('空 格 目录', '孩子');
    const result = await set.definitions.td_scaffold.execute(
      { dialect: 'Toy', ops: threeOps(), outDir, validate: false },
      exec(set.temp.dir),
    );
    assert.equal(result.ok, true);
    assert.equal(result.files.length, 7);
    assert.equal(existsSync(join(set.temp.dir, outDir, 'ToyOps.td')), true);
  } finally {
    set.temp.cleanup();
  }
});

test('td_scaffold：summary 会转义，字符串形式 attributes 进 let arguments', async () => {
  const set = makeToolset(() => okResult);
  try {
    const result = await set.definitions.td_scaffold.execute(
      {
        dialect: 'Toy',
        ops: [
          {
            name: 'Add',
            operands: [{ name: 'lhs', type: 'I32' }],
            results: [{ name: 'result', type: 'I32' }],
            attributes: ['I32Attr:$value', { name: 'unit', type: 'UnitAttr' }],
            summary: 'say "hi" and \\ / newline\nsecond line',
          },
        ],
        outDir: 'esc',
        validate: false,
      },
      exec(set.temp.dir),
    );
    assert.equal(result.ok, true, result.hint ?? '');
    const ops = readFileSync(join(set.temp.dir, 'esc', 'ToyOps.td'), 'utf8');
    // TablGen 字符串里引号要转义、反斜杠要写两个、换行写 \n，否则生成的 .td 直接 parse 失败。
    assert.ok(
      ops.includes('let summary = "say \\"hi\\" and \\\\ / newline\\nsecond line";'),
      ops.split('\n').find((line) => line.includes('summary')) ?? ops,
    );
    assert.match(ops, /I32:\$lhs,\n {4}I32Attr:\$value,\n {4}UnitAttr:\$unit\);/);
    assert.equal(ops.includes('let attributes'), false);
  } finally {
    set.temp.cleanup();
  }
});

/** ---------------------------------------------------------------- td_check */

function makeTdDir(set, names = ['ToyOps.td']) {
  mkdirSync(set.tdDir, { recursive: true });
  for (const name of names) writeFileSync(join(set.tdDir, name), 'def X;\n', 'utf8');
}

test('td_check：未知 kind / 目录不存在 / 没有 .td 都结构化返回', async () => {
  const set = makeToolset(() => okResult);
  try {
    const ctx = exec(set.temp.dir);
    const unknown = await set.definitions.td_check.execute({ tdDir: 'td', kinds: ['nope'] }, ctx);
    assert.equal(unknown.ok, false);
    assert.match(unknown.hint, /nope/);
    assert.match(unknown.hint, /op-decls/);

    const missing = await set.definitions.td_check.execute({ tdDir: 'td' }, ctx);
    assert.equal(missing.ok, false);
    assert.match(missing.hint, /不存在|不是目录/);

    mkdirSync(set.tdDir, { recursive: true });
    const empty = await set.definitions.td_check.execute({ tdDir: 'td' }, ctx);
    assert.equal(empty.ok, false);
    assert.match(empty.hint, /没有 \.td/);
  } finally {
    set.temp.cleanup();
  }
});

test('td_check：通过时 ok:true；每次运行都带 -I tdDir 且不留下 .inc', async () => {
  const set = makeToolset(() => okResult);
  try {
    makeTdDir(set);
    const before = readdirSync(set.tdDir).length;
    const result = await set.definitions.td_check.execute({ tdDir: 'td' }, exec(set.temp.dir));
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.crashed, false);
    assert.equal(result.timedOut, false);
    assert.deepEqual(result.kinds, ['op-decls', 'op-defs']);
    assert.equal(set.calls.length, 2);
    for (const call of set.calls) {
      const index = call.argv.indexOf('-I');
      assert.ok(index > 0);
      assert.equal(call.argv[index + 1], set.tdDir);
      assert.equal(call.options.cwd, set.tdDir);
    }
    assert.equal(readdirSync(set.tdDir).length, before, '用户目录里不该多出 .inc');
  } finally {
    set.temp.cleanup();
  }
});

test('td_check：kinds:[] 按「未指定」处理，回落到 op-decls / op-defs', async () => {
  const set = makeToolset(() => okResult);
  try {
    makeTdDir(set);
    const result = await set.definitions.td_check.execute({ tdDir: 'td', kinds: [] }, exec(set.temp.dir));
    assert.equal(result.ok, true);
    assert.deepEqual(result.kinds, ['op-decls', 'op-defs']);
    assert.equal(set.calls.length, 2);
    const flags = set.calls.map((call) => call.argv.filter((arg) => String(arg).startsWith('-gen-')));
    assert.deepEqual(flags, [['-gen-op-decls'], ['-gen-op-defs']]);
  } finally {
    set.temp.cleanup();
  }
});

test('td_check：两种 kind 产生同一条诊断时去重，崩溃栈不进 message', async () => {
  const set = makeToolset(() => ({ exitCode: 1, stdout: '', stderr: DUP_STDERR, timedOut: false }));
  try {
    makeTdDir(set);
    const result = await set.definitions.td_check.execute({ tdDir: 'td' }, exec(set.temp.dir));
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1, 'op-decls 与 op-defs 的同一条错误必须去重');
    assert.equal(result.errors[0].kind, 'constraint');
    assert.equal(result.crashed, true);
    assert.equal(result.stderr.includes('PLEASE'), true, 'stderr 原样保留');
    assert.equal(JSON.stringify(result.errors).includes('PLEASE'), false);
    assert.match(result.hint, /参数名|重复|constraint/);
  } finally {
    set.temp.cleanup();
  }
});

test('td_check：不支持的 -gen- 参数给出工具链提示，而不是当成 .td 错误', async () => {
  const set = makeToolset(() => ({
    exitCode: 1,
    stdout: '',
    stderr: "mlir-tblgen.exe: Unknown command line argument '-gen-typedef-decls'.  Try: 'mlir-tblgen.exe --help'",
    timedOut: false,
  }));
  try {
    makeTdDir(set);
    const result = await set.definitions.td_check.execute(
      { tdDir: 'td', kinds: ['typedef-decls'] },
      exec(set.temp.dir),
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, []);
    assert.match(result.hint, /不支持/);
    assert.match(result.hint, /typedef-decls/);
  } finally {
    set.temp.cleanup();
  }
});

test('td_check：超时 → timedOut:true 且 ok:false；runner 抛错也不冒泡', async () => {
  const timeoutSet = makeToolset(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
  try {
    makeTdDir(timeoutSet);
    const result = await timeoutSet.definitions.td_check.execute({ tdDir: 'td' }, exec(timeoutSet.temp.dir));
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
  } finally {
    timeoutSet.temp.cleanup();
  }

  const throwSet = makeToolset(() => {
    throw new Error('spawn EPERM');
  });
  try {
    makeTdDir(throwSet);
    const result = await throwSet.definitions.td_check.execute({ tdDir: 'td' }, exec(throwSet.temp.dir));
    assert.equal(result.ok, false);
    assert.match(result.hint, /启动 mlir-tblgen 失败/);
  } finally {
    throwSet.temp.cleanup();
  }
});

test('td_check：缺 mlir-tblgen 时 ok:false + hint，不跑任何命令', async () => {
  const temp = makeTempDir();
  try {
    mkdirSync(join(temp.dir, 'td'), { recursive: true });
    writeFileSync(join(temp.dir, 'td', 'X.td'), 'def X;\n', 'utf8');
    const cfg = resolveConfig({ mlirTblgenPath: join(temp.dir, 'missing.exe') }, temp.dir);
    const { runner, calls } = recordingRunner(() => okResult);
    const tools = buildTablegenTools(cfg, runner);
    const check = tools.find((tool) => tool.name === 'td_check');
    const result = await check.execute({ tdDir: 'td' }, exec(temp.dir));
    assert.equal(result.ok, false);
    assert.match(result.hint, /mlir-tblgen/);
    assert.equal(calls.length, 0);
  } finally {
    temp.cleanup();
  }
});

/** ---------------------------------------------------------------- td_explain */

test('td_explain：真实报错原文 → 结构化条目；空输入给提示', async () => {
  const set = makeToolset(() => okResult);
  try {
    const explain = set.definitions.td_explain;
    const result = await explain.execute({ stderr: SYNTAX_STDERR }, exec(set.temp.dir));
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, 'syntax');
    assert.equal(result.items[0].line, 5);

    const empty = await explain.execute({ stderr: '  ' }, exec(set.temp.dir));
    assert.deepEqual(empty.items, []);
    assert.match(empty.hint, /stderr/);

    const unknown = await explain.execute(
      { stderr: 'a.td:1:1: error: something nobody has seen before' },
      exec(set.temp.dir),
    );
    assert.equal(unknown.items[0].fix, null);
    assert.match(unknown.hint, /未识别/);
  } finally {
    set.temp.cleanup();
  }
});

test('td_explain：不传 tdFile 时从 stderr 的第一条 .td 路径自动定位', async () => {
  const set = makeToolset(() => okResult);
  try {
    const tdPath = join(set.temp.dir, 'Bad.td');
    writeFileSync(
      tdPath,
      [
        '#ifndef BAD_TD',
        '#define BAD_TD',
        'include "mlir/IR/OpBase.td"',
        '',
        'def Toy_BadOp : Toy_Op<"bad"> {',
        '  let arguments = (ins I32 $x);',
        '  let results = (outs);',
        '}',
        '',
        '#endif',
        '',
      ].join('\n'),
      'utf8',
    );
    const result = await set.definitions.td_explain.execute(
      { stderr: tdPath + ":6:21: error: expected ')' in dag init" },
      exec(set.temp.dir),
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, 'syntax');
    assert.equal(result.items[0].record, 'Toy_BadOp', '应从自动定位到的源码回填 record');
    assert.match(String(result.items[0].fix), /\(ins I32:\$x\)/);
    assert.match(String(result.hint), /Bad\.td/);
  } finally {
    set.temp.cleanup();
  }
});

test('td_scaffold / td_check / td_explain 的入参 schema 都禁止多余字段', () => {
  const set = makeToolset(() => okResult);
  try {
    for (const definition of set.tools) {
      assert.equal(definition.parameters.type, 'object', definition.name);
      assert.equal(definition.parameters.additionalProperties, false, definition.name);
      assert.ok(Array.isArray(definition.parameters.required), definition.name);
      assert.equal(typeof definition.description, 'string');
      assert.ok(definition.description.length > 20);
      assert.equal(typeof definition.execute, 'function');
      assert.equal(typeof definition.output.render, 'function');
      assert.equal(definition.output.schema.type, 'object');
    }
    assert.deepEqual(set.definitions.td_scaffold.parameters.required, ['dialect', 'ops', 'outDir']);
    assert.deepEqual(set.definitions.td_check.parameters.required, ['tdDir']);
    assert.deepEqual(set.definitions.td_explain.parameters.required, ['stderr']);
  } finally {
    set.temp.cleanup();
  }
});

test('render 函数把结果渲染成可读文本', () => {
  const set = makeToolset(() => okResult);
  try {
    const scaffold = set.definitions.td_scaffold;
    const scaffoldText = scaffold.output.render({}, {
      ok: true,
      outDir: 'D:\\out',
      validation: 'passed',
      files: [{ path: 'D:\\out\\ToyOps.td', kind: 'ops-def', bytes: 10 }],
      errors: [],
      hint: 'done',
    })[0].text;
    assert.match(scaffoldText, /成功/);
    assert.match(scaffoldText, /ToyOps\.td/);

    const checkText = set.definitions.td_check.output.render({}, {
      ok: false,
      kinds: ['op-decls'],
      files: ['a.td'],
      errors: [{ file: 'D:\\x\\a.td', line: 3, col: 2, kind: 'syntax', record: 'Toy_XOp', message: 'expected \')\'' }],
      warnings: [],
      crashed: false,
      timedOut: false,
      hint: 'fix it',
    })[0].text;
    assert.match(checkText, /失败/);
    assert.match(checkText, /a\.td:3:2/);
    assert.match(checkText, /Toy_XOp/);

    const explainText = set.definitions.td_explain.output.render({}, {
      items: [{ record: null, line: 1, col: 1, kind: 'other', message: 'boom', fix: null }],
      hint: null,
    })[0].text;
    assert.match(explainText, /boom/);
  } finally {
    set.temp.cleanup();
  }
});
