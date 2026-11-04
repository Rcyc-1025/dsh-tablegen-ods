# dsh-tablegen-ods

TableGen scaffolding and diagnostics for MLIR ODS: generate a dialect/op skeleton that compiles in a CMake project, validate it with `mlir-tblgen`, and turn tblgen errors into concrete fix suggestions.

| Tool | What it does | Spawns a process |
| --- | --- | --- |
| `td_scaffold` | Render 7 files (`.td` + C++ + `CMakeLists.txt`) from dialect/ops, optionally validate first | Only when `validate:true` |
| `td_check` | Run `mlir-tblgen -gen-*` over a directory of `.td` and structure the diagnostics | Yes |
| `td_explain` | Plain-text analysis of tblgen stderr into `record / line / kind / fix` | No |

## Install

The package is a normal bundle (`cordis.patch.yml` included). All three tools are registered unconditionally; the toolchain is never probed at load time.

```yaml
- insert:
    - id: tablegen-ods
      name: 'dsh-tablegen-ods'
      config:
        timeoutMs: 30000
        maxOutputBytes: 1048576
```

## Locating mlir-tblgen

Priority: `mlirTblgenPath` → `llvm.tools.mlirTblgen.path` inside the `toolchain.json` named by `MLIR_TOOLCHAIN_JSON` → auto-discovery (`../toolchain.json`, `./toolchain.json`, `<cwd>/toolchain.json`, `<cwd>/mlir-lang/toolchain.json`).

`includeDirs` are passed through as `-I`. Without them, `mlir/IR/OpBase.td` is located from `toolchain.json`, LLVM install/build trees, and the directory above the `mlir-tblgen` binary itself (including sibling `llvm-src/*/mlir/include` source trees). A missing toolchain never throws: you get `ok:false` plus a hint saying what to configure.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `toolchainPath` | auto | `toolchain.json` path; also `MLIR_TOOLCHAIN_JSON` |
| `mlirTblgenPath` | empty | Explicit `mlir-tblgen`, beats `toolchain.json` |
| `includeDirs` | `[]` | Extra `-I` directories |
| `timeoutMs` | `30000` | Per-invocation timeout (1000–600000) |
| `maxOutputBytes` | `1048576` | Cap for stdout/stderr; overflow keeps head and tail |
| `maxDiagnostics` | `100` | Diagnostics returned per call |
| `graceMs` | `5000` | Post-exit grace period |

## td_scaffold

```jsonc
{
  "dialect": "Toy",
  "cppNamespace": "::toy",
  "ops": [{
    "name": "Add",                  // Add / AddOp / Toy_AddOp / toy.add all accepted
    "operands": [{ "name": "lhs", "type": "I32" }],
    "results": [{ "name": "result", "type": "I32" }],
    "attributes": [{ "name": "value", "type": "I32Attr" }],
    "summary": "integer addition"
  }],
  "outDir": "path/to/dialect",
  "overwrite": false,
  "validate": true
}
```

Writes `ToyDialect.td`, `ToyOps.td`, `ToyDialect.h/.cpp`, `ToyOps.h/.cpp`, `CMakeLists.txt`.

- Records are `<Dialect>_<Name>Op`, mnemonics `<dialect>.<name>`;
- Type aliases are normalised (`i32` → `I32`, `Variadic<i32>` → `Variadic<I32>`), everything else passes through;
- Attributes are appended to `let arguments = (ins ...)`;
- The CMake file emits 4 `.inc` files via `mlir_tablegen` and builds a static dialect library with `add_mlir_dialect_library` (C++17, with an out-of-tree stand-in for the in-tree `mlir-headers` target);
- Output is deterministic: same input, byte-identical files;
- With `overwrite:false`, any existing target aborts the whole batch before a single byte is written;
- With `validate:true`, files are rendered into a temp directory, validated with four tblgen runs, and only committed on success.

## td_check

```jsonc
{ "tdDir": "path/to/dialect", "kinds": ["op-decls", "op-defs"] }
```

Kinds: `op-decls`, `op-defs`, `dialect-decls`, `dialect-defs`, `typedef-decls`, `typedef-defs`, `rewriters`, `rewriter-decls`. Omitting `kinds` or passing an empty array both fall back to `op-decls` / `op-defs`.

- Always passes `-I <tdDir>` and uses `tdDir` as cwd, so `include "ToyOps.td"` resolves;
- `.inc` output goes to the system temp directory and is deleted afterwards;
- Diagnostics are sorted by `file/line/col` and deduplicated across runs;
- Crash noise (`PLEASE submit a bug report`, `Stack dump`, `Program arguments`, stack frames) never becomes a `message`; `crashed:true` carries it instead;
- A `-gen-*` flag the local toolchain does not know (LLVM 23 dropped `-gen-typedef-decls`) is reported as a toolchain limitation, not as a `.td` error;
- `ok:true` requires: no unsupported kind, no timeout, no error-level diagnostic (warnings do not fail).

## td_explain

```jsonc
{ "stderr": "<raw mlir-tblgen stderr>", "tdFile": "path/to/ToyOps.td" }
```

`tdFile` or `source` is optional; when present, `record` is back-filled from the enclosing `def` and the fix quotes the corrected snippet. With neither given, the first `path:line:col:` in `stderr` is used as the `.td` (only if that file exists).

Kinds: `undefined-record`, `constraint`, `syntax`, `include`, and `other` (unknown messages keep `fix:null` — nothing is invented).

Example fix for `expected ')' in dag init` on `(ins I32 $x)`:

> 参数缺少冒号：该参数块应写成 `(ins I32:$x);`（类型与名字之间用冒号连接，名字带 $）。

## Safety

Everything runs through argv spawn (no shell, no string concatenation), writes are verified to stay inside `outDir`, identifiers are restricted to `[A-Za-z][A-Za-z0-9_]*`, and every failure path returns structured data with a hint instead of throwing.

## Development

```bash
npm test          # 55 tests; real-tblgen cases self-skip where spawning is blocked
npm run smoke     # toolchain-free smoke check
```

Real-tblgen integration tests default to `D:/Code/llvm-build/bin/mlir-tblgen.exe`; override with `TD_MLIR_TBLGEN`.

## License

MIT
