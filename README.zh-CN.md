# dsh-tablegen-ods

MLIR ODS 的 TableGen 脚手架与诊断插件：一次生成一套能直接进 CMake 工程的 dialect/op 骨架，用 `mlir-tblgen` 校验，再把 tblgen 的报错翻译成能照着改的中文建议。

三个工具：

| 工具 | 做什么 | 会不会跑外部程序 |
| --- | --- | --- |
| `td_scaffold` | 按 dialect/ops 生成 7 个文件（`.td` + C++ + `CMakeLists.txt`），可选先校验 | `validate:true` 时会跑 `mlir-tblgen` |
| `td_check` | 对一个目录里的 `.td` 跑 `mlir-tblgen -gen-*`，把诊断结构化 | 会 |
| `td_explain` | 纯文本分析 tblgen 的 stderr，给出 `record / line / kind / fix` | 不会 |

## 安装与启用

插件包名 `dsh-tablegen-ods`，带 `cordis.patch.yml`，按普通 bundle 安装即可；三个工具总是注册，加载阶段不探测工具链。

```yaml
- insert:
    - id: tablegen-ods
      name: 'dsh-tablegen-ods'
      config:
        timeoutMs: 30000
        maxOutputBytes: 1048576
```

## 找到 mlir-tblgen

优先级从高到低：

1. 配置项 `mlirTblgenPath`（显式路径，最省事）；
2. 环境变量 `MLIR_TOOLCHAIN_JSON` 指向的 `toolchain.json` 里的 `llvm.tools.mlirTblgen.path`；
3. 自动探测 `toolchain.json`：本包同级 → 本包内 → 会话 cwd → 会话 cwd/mlir-lang。

TableGen 还需要 `mlir/IR/OpBase.td`。`includeDirs` 里的目录会原样作为 `-I`；没配时会按 `OpBase.td` 是否存在自动从 `toolchain.json`、LLVM 安装/构建目录、以及 `mlir-tblgen` 自身所在的 `bin` 往上找（包括同级的 `llvm-src/*/mlir/include` 源码树）。实在找不到就返回 `ok:false` 并列出搜过的目录。

找不到 `mlir-tblgen` 时不会抛异常：`td_scaffold` 返回 `ok:false` + `validation:"failed"`，`td_check` 返回 `ok:false`，hint 里写清下一步该配什么。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `toolchainPath` | 自动探测 | `toolchain.json` 路径，也可用 `MLIR_TOOLCHAIN_JSON` |
| `mlirTblgenPath` | 空 | 直接指定 `mlir-tblgen`，优先于 `toolchain.json` |
| `includeDirs` | `[]` | 追加的 `-I` 目录 |
| `timeoutMs` | `30000` | 单次 tblgen 调用的超时（1000–600000） |
| `maxOutputBytes` | `1048576` | stdout/stderr 各自的上限，超了保留头尾 |
| `maxDiagnostics` | `100` | 最多返回多少条诊断 |
| `graceMs` | `5000` | 子进程退出后的宽限期 |

## td_scaffold

```jsonc
{
  "dialect": "Toy",
  "cppNamespace": "::toy",          // 省略时用 ::<dialect 小写>
  "ops": [
    {
      "name": "Add",                 // Add / AddOp / Toy_AddOp / toy.add 都行
      "operands": [{ "name": "lhs", "type": "I32" }, { "name": "rhs", "type": "I32" }],
      "results": [{ "name": "result", "type": "I32" }],
      "attributes": [{ "name": "value", "type": "I32Attr" }],  // 也接受 "I32Attr:$value"
      "summary": "integer addition"
    }
  ],
  "outDir": "path/to/dialect",
  "overwrite": false,
  "validate": true
}
```

生成的 7 个文件：

```
<Toy>Dialect.td   <Toy>Ops.td
<Toy>Dialect.h    <Toy>Dialect.cpp
<Toy>Ops.h        <Toy>Ops.cpp
CMakeLists.txt
```

要点：

- 记录名固定为 `<Dialect>_<Name>Op`，mnemonic 为 `<dialect>.<name 小写>`；
- 类型别名会归一（`i32` → `I32`，`Variadic<i32>` → `Variadic<I32>`），其他字符串原样透传；
- attributes 追加到 `let arguments = (ins ...)` 末尾（ODS 里属性也是 arguments）；
- `CMakeLists.txt` 用 `mlir_tablegen` 生成 4 个 `.inc` + `add_mlir_dialect_library` 静态库，C++17，并给 out-of-tree 构建补了 `mlir-headers` 占位目标；
- 输出确定性：同样的输入逐字节一致（不写时间戳、随机数、绝对路径）；
- `overwrite:false` 时只要有一个同名文件就整批不写；`validate:true` 时先把 7 个文件写进系统临时目录跑 4 次 tblgen，通过才提交到 `outDir`。

返回：

```jsonc
{
  "ok": true,
  "outDir": "...",
  "files": [{ "path": "...", "kind": "ops-def", "bytes": 512 }],
  "validation": "passed",           // passed | skipped | failed
  "conflicts": [],                  // 仅冲突时
  "errors": [],
  "hint": "..."
}
```

## td_check

```jsonc
{ "tdDir": "path/to/dialect", "kinds": ["op-decls", "op-defs"] }
```

支持的 `kinds`：`op-decls`、`op-defs`、`dialect-decls`、`dialect-defs`、`typedef-decls`、`typedef-defs`、`rewriters`、`rewriter-decls`。不传或传空数组都按默认的 `op-decls` / `op-defs` 处理。

- 每次调用都带 `-I <tdDir>` 并以 `tdDir` 为 cwd（否则 `include "XOps.td"` 会找不到）；
- `.inc` 只写到系统临时目录，用完即删，不污染源码目录；
- 诊断按 `file/line/col` 排序、按 `file/line/message` 去重（同一条错误在 decls 与 defs 里各出现一次很常见）；
- 崩溃栈（`PLEASE submit a bug report`、`Stack dump`、`Program arguments`、栈帧）不会变成 `message`，只把 `crashed` 置 true；
- 当前工具链没有某个 `-gen-` 参数时（例如 LLVM 23 已移除 `-gen-typedef-decls`），hint 会说明是工具链不支持，而不是 .td 写错了；
- `ok:true` 只要求：没有不支持的 kind、没有超时、没有 error 级诊断（warning 不算失败）。

返回：

```jsonc
{
  "ok": false,
  "errors": [{ "file": "...", "line": 5, "col": 9, "severity": "error", "kind": "syntax", "record": "Toy_BadOp", "message": "expected ')' in dag init" }],
  "warnings": [],
  "files": ["..."],
  "kinds": ["op-decls", "op-defs"],
  "crashed": false,
  "timedOut": false,
  "stderr": "...",
  "truncated": false,
  "hint": "..."
}
```

## td_explain

```jsonc
{ "stderr": "<mlir-tblgen 原始 stderr>", "tdFile": "path/to/ToyOps.td" }
```

`tdFile` 或 `source` 可选：给了就能把 `record` 回填到最近的 `def`，并把修复建议写成具体片段。两个都不给时会从 `stderr` 的第一条 `path:line:col:` 里取 `.td` 路径（校验文件确实存在）自动定位。

返回：

```jsonc
{
  "items": [
    {
      "record": "Toy_BadOp",
      "line": 5,
      "col": 9,
      "kind": "syntax",
      "message": "expected ')' in dag init",
      "fix": "参数缺少冒号：该参数块应写成 `(ins I32:$x);`（类型与名字之间用冒号连接，名字带 $）。"
    }
  ],
  "hint": null
}
```

`kind` 四类：`undefined-record`（记录/类型没定义 → include 或改拼写）、`constraint`（命名冲突等 → 改名）、`syntax`（期望某 token → 按 ODS 语法补）、`include`（找不到 include → 加目录），其余归 `other` 且 `fix:null`——不编造修复。

## 安全边界

- 所有外部调用都是 argv 数组，不经过 shell，不做字符串拼接；
- 写文件前检查目标在 `outDir` 内；
- 名字只允许 `[A-Za-z][A-Za-z0-9_]*`，逐项拒绝 `/ \ ..`、空白、`$`、控制字符；
- 没有失败会抛异常：缺工具链、坏 JSON、超时、崩溃、路径含空格中文，都是结构化返回 + 中文 hint。

## 开发

```bash
npm test          # 55 个用例（真实 tblgen 用例在禁止 spawn 的沙箱里自动跳过）
npm run smoke     # 不需要 tblgen 的冒烟检查
```

真实 tblgen 集成用例默认用 `D:/Code/llvm-build/bin/mlir-tblgen.exe`，可用 `TD_MLIR_TBLGEN` 覆盖。

## 许可

MIT
