import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject, name } from '../lib/index.js';
import { makeTempDir } from './helpers.mjs';

function fakeCtx() {
  const registered = [];
  const disposers = [];
  const events = [];
  return {
    registered,
    disposers,
    events,
    ctx: {
      subprocess: {
        spawn: () => {
          throw new Error('注册阶段不应该 spawn');
        },
      },
      tools: {
        register(definition) {
          registered.push(definition);
          const dispose = () => {
            const index = registered.indexOf(definition);
            if (index >= 0) registered.splice(index, 1);
          };
          disposers.push(dispose);
          return dispose;
        },
      },
      on(event, handler) {
        events.push({ event, handler });
      },
    },
  };
}

test('模块导出：插件 id 与 inject 与参考插件一致', () => {
  assert.equal(name, 'tablegen-ods');
  assert.deepEqual(inject, ['subprocess', 'tools']);
  assert.equal(typeof apply, 'function');
});

test('apply 注册三个工具，且不在注册阶段启动任何子进程', () => {
  const temp = makeTempDir();
  try {
    const fake = fakeCtx();
    apply(fake.ctx, {});
    assert.equal(fake.registered.length, 3);
    assert.deepEqual(fake.registered.map((definition) => definition.name).sort(), [
      'td_check',
      'td_explain',
      'td_scaffold',
    ]);
    for (const definition of fake.registered) {
      assert.equal(typeof definition.execute, 'function');
      assert.equal(typeof definition.timeoutMs, 'number');
      assert.ok(definition.timeoutMs >= 10000);
    }
    assert.equal(fake.events.length, 1);
    assert.equal(fake.events[0].event, 'dispose');
  } finally {
    temp.cleanup();
  }
});

test('apply 的 dispose 会撤销全部注册', () => {
  const temp = makeTempDir();
  try {
    const fake = fakeCtx();
    apply(fake.ctx, { timeoutMs: 4000, maxDiagnostics: 5 });
    assert.equal(fake.registered.length, 3);
    fake.events[0].handler();
    assert.equal(fake.registered.length, 0);
  } finally {
    temp.cleanup();
  }
});

test('apply 接受残缺配置也不抛错（全部走默认值）', () => {
  const temp = makeTempDir();
  try {
    for (const config of [undefined, null, {}, { timeoutMs: 'x' }, { includeDirs: 'not-array' }]) {
      const fake = fakeCtx();
      assert.doesNotThrow(() => apply(fake.ctx, config), JSON.stringify(config));
      assert.equal(fake.registered.length, 3);
    }
  } finally {
    temp.cleanup();
  }
});
