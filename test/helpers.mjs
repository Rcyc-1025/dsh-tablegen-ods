import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 伪造工具的 exec 参数：只有会话 cwd 是插件会读的。 */
export function fakeExec(cwd) {
  return { agent: { session: { header: { cwd } } } };
}

/** 建一个进程内临时目录，返回 {dir, cleanup}。 */
export function makeTempDir(prefix = 'dsh-td-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 清不掉不影响断言。
      }
    },
  };
}

/** 记录每次调用的 argv/cwd，返回预设结果；handler 可返回或抛错。 */
export function recordingRunner(handler = () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })) {
  const calls = [];
  const runner = async (argv, options) => {
    calls.push({ argv: [...argv], options: { ...options } });
    return handler(argv, options, calls.length - 1);
  };
  return { runner, calls };
}

/** 稳定返回成功（用于不关心 null 诊断的用例）。 */
export function okRunner() {
  return async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
}

/** 文件哈希（确定性验收用）。 */
export function fileHashes(paths) {
  return paths.map((path) => createHash('sha256').update(readFileSync(path)).digest('hex'));
}

/**
 * 沙箱里 node 不一定能再 spawn 子进程（Windows 上常见 EPERM）。
 * EPERM 是异步 error 事件，所以要真的等一次子进程结束才能判定。
 */
export async function canSpawnRealProcesses() {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已经退出。
      }
      finish(false);
    }, 10000);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/** 真实子进程 runner（形状与 lib/exec.js 一致），供集成测试使用。 */export function realRunner() {
  return async (argv, options = {}) => {
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 30000;
    return await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(argv[0], argv.slice(1), {
        cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 已经退出。
        }
        finish({ exitCode: null, stdout, stderr, timedOut: true });
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error) => {
        finish({ exitCode: null, stdout, stderr: stderr + String(error.message ?? error), timedOut: false, error: true });
      });
      child.on('close', (code) => {
        finish({ exitCode: code, stdout, stderr, timedOut: false });
      });
    });
  };
}

/**
 * 能不能真的执行某个外部程序并读回输出（沙箱禁止建管道时 spawn 会 EPERM）。
 * 必须用 pipe 探测：stdio 为 ignore 时可能放行，但那不能代表插件真实的调用方式。
 */
export async function canSpawnExecutable(exe) {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(exe, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已经退出。
      }
      finish(false);
    }, 20000);
    child.on('error', () => finish(false));
    child.on('close', () => finish(true));
  });
}
