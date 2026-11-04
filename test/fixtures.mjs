/** 真实 mlir-tblgen 23.1.4 的输出片段（在 D:\Code\llvm-build\bin\mlir-tblgen.exe 上实测）。 */

export const SYNTAX_STDERR = 'D:\\tmp\\Toy\\Bad.td:5:9: error: expected \')\' in dag init';

export const UNDEF_STDERR = 'D:\\tmp\\Toy\\Undef.td:5:5: error: Variable not defined: \'NoSuchType\'';

export const INCLUDE_STDERR = [
  'D:\\tmp\\Toy\\NoInc.td:1:9: error: could not find include file \'NoSuchDialect.td\'',
  'D:\\tmp\\Toy\\NoInc.td:1:9: error: Unexpected token at top level',
].join('\n');

/** 命名冲突后 mlir-tblgen 会直接崩溃并打印栈，栈行不能进 message。 */
export const DUP_STDERR = [
  'D:\\tmp\\Toy\\Dup.td:3:5: error: op has a conflict with two operands having the same name \'x\'',
  'PLEASE submit a bug report to https://github.com/llvm/llvm-project/issues/ and include the crash backtrace and instructions to reproduce the bug.',
  'Stack dump:',
  '0.\tProgram arguments: D:\\Code\\llvm-build\\bin\\mlir-tblgen.exe -gen-op-decls D:\\tmp\\Toy\\Dup.td',
  '1.\tRunning pass \'MLIR TableGen\' on module \'Dup.td\'',
  ' #0 0x00007ff6e2b81a4c (mlir-tblgen.exe+0x1c1a4c)',
  ' #1 0x00007ff6e2b81a4c (mlir-tblgen.exe+0x1c1a4c)',
].join('\n');

export const UNKNOWN_STDERR = 'D:\\tmp\\Toy\\Weird.td:9:3: error: something nobody has seen before';

/**
 * 同一段崩溃输出经 Windows 终端（PowerShell 管道）转发后的样子：
 * 长行被按窗口宽度软换行，续行以一个空格开头，还会混进 PowerShell 的错误记录。
 * td_explain 要能把续行接回去，否则 kind 会退化成 other。
 */
export const WRAPPED_DUP_STDERR = [
  'mlir-tblgen.exe : D:\\tmp\\Toy\\Dup.td:3:5: error: op has a conflict with two operands having',
  " the same name 'x'",
  '所在位置 行:1 字符: 558',
  '+ ... )) { $err = & $exe -gen-op-decls "$td\\$f" -I $td -I $inc -o "$out\\$f. ...',
  '+                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '    + CategoryInfo          : NotSpecified: (D:\\tmp\\Ta...e same name \'x\':String) [], RemoteException',
  'PLEASE submit a bug report to https://github.com/llvm/llvm-project/issues/',
  'Stack dump:',
  '0.\tProgram arguments: D:\\Code\\llvm-build\\bin\\mlir-tblgen.exe -gen-op-decls D:\\tmp\\Toy\\Dup.td',
].join('\n');

/** 与 SYNTAX_STDERR 对应的源码：第 5 行的 `I32 $x` 缺冒号。 */
export const BAD_SOURCE = [
  'include "ToyOps.td"',
  '',
  'def Toy_BadOp : Toy_Op<"bad"> {',
  '  let arguments = (ins',
  '    I32 $x);',
  '  let results = (outs',
  '    I32:$r);',
  '}',
  '',
].join('\n');

/** 三个 op 的最小验收输入。 */
export function threeOps() {
  return ['Add', 'Sub', 'Mul'].map((name) => ({
    name,
    operands: [
      { name: 'lhs', type: 'I32' },
      { name: 'rhs', type: 'I32' },
    ],
    results: [{ name: 'result', type: 'I32' }],
    summary: name.toLowerCase() + ' two i32 values',
  }));
}
