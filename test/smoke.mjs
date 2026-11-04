#!/usr/bin/env node
/**
 * 冒烟脚本：不依赖真实 mlir-tblgen，验证插件能被加载、生成骨架、解释报错。
 * 用法：npm run smoke
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, inject, name } from '../lib/index.js';
import { resolveConfig } from '../lib/config.js';
import { buildTablegenTools } from '../lib/tools.js';

let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log('  ok  ' + label);
  } else {
    failed += 1;
    console.log('FAIL  ' + label + (detail === undefined ? '' : ' → ' + String(detail)));
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-tablegen-ods-smoke-'));
try {
  console.log('dsh-tablegen-ods');
  check('插件 id = tablegen-ods', name === 'tablegen-ods', name);
  check('inject = subprocess + tools', JSON.stringify(inject) === '["subprocess","tools"]', JSON.stringify(inject));

  const registered = [];
  apply(
    {
      subprocess: { spawn: () => { throw new Error('smoke 不该 spawn'); } },
      tools: { register: (definition) => { registered.push(definition); } },
      on: () => {},
    },
    { timeoutMs: 30000 },
  );
  check('注册 3 个工具', registered.length === 3, registered.map((definition) => definition.name).join(','));

  const cfg = resolveConfig({ mlirTblgenPath: join(dir, 'missing-mlir-tblgen.exe') }, dir);
  const definitions = Object.fromEntries(buildTablegenTools(cfg, async () => {
    throw new Error('smoke 不该 spawn');
  }).map((definition) => [definition.name, definition]));

  console.log('\ntd_scaffold（validate:false）');
  const scaffolded = await definitions.td_scaffold.execute(
    {
      dialect: 'Toy',
      cppNamespace: '::toy',
      ops: [
        { name: 'Add', operands: [{ name: 'lhs', type: 'I32' }, { name: 'rhs', type: 'I32' }], results: [{ name: 'result', type: 'I32' }] },
        { name: 'Sub', operands: [{ name: 'lhs', type: 'I32' }, { name: 'rhs', type: 'I32' }], results: [{ name: 'result', type: 'I32' }] },
        { name: 'Mul', operands: [{ name: 'lhs', type: 'I32' }, { name: 'rhs', type: 'I32' }], results: [{ name: 'result', type: 'I32' }] },
      ],
      outDir: 'out',
      validate: false,
    },
    { agent: { session: { header: { cwd: dir } } } },
  );
  check('生成成功', scaffolded.ok === true, scaffolded.hint);
  check('输出 7 个文件', scaffolded.files.length === 7, scaffolded.files.length);

  console.log('\ntd_scaffold（validation 缺工具链）');
  const blocked = await definitions.td_scaffold.execute(
    { dialect: 'Toy', ops: [{ name: 'Add' }], outDir: 'blocked' },
    { agent: { session: { header: { cwd: dir } } } },
  );
  check('缺 tblgen 时 ok:false', blocked.ok === false);
  check('给出中文 hint', typeof blocked.hint === 'string' && blocked.hint.length > 0, blocked.hint);

  console.log('\ntd_explain');
  const explained = await definitions.td_explain.execute(
    { stderr: "C:\\tmp\\ToyOps.td:5:9: error: expected ')' in dag init" },
    { agent: { session: { header: { cwd: dir } } } },
  );
  check('识别出 1 条诊断', explained.items.length === 1, explained.items.length);
  check('分类为 syntax', explained.items[0]?.kind === 'syntax', explained.items[0]?.kind);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed > 0) {
  console.log('\n' + String(failed) + ' 项失败');
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
