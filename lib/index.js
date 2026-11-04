import { resolveConfig } from './config.js';
import { createSubprocessRunner } from './exec.js';
import { buildTablegenTools } from './tools.js';

export const name = 'tablegen-ods';
export const inject = ['subprocess', 'tools'];

/**
 * 注册三个工具：td_scaffold（生成 ODS 骨架）、td_check（mlir-tblgen 校验）、td_explain（解释报错）。
 * 插件本身不做任何宿主级注册（无后台任务、无 job、无定时器）；配置解析与工具构造都在这里完成一次。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config, process.cwd());
  const runner = createSubprocessRunner(
    (spec) => ctx.subprocess.spawn(spec),
    cfg.graceMs,
    cfg.timeoutMs,
  );
  const disposers = buildTablegenTools(cfg, runner).map((definition) => ctx.tools.register(definition));
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose();
      }
    });
  }
}
