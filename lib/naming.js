/** TableGen 记录名 / 类名：字母开头，其余字母数字下划线。 */
export const RECORD_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** 参数名（operand/result/attribute）：允许下划线开头，不进记录名。 */
export const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 类型约束里明确支持的别名（大小写不敏感归一）；其余字符串原样透传。 */
const TYPE_ALIASES = new Map([
  ['anyinteger', 'AnyInteger'],
  ['i1', 'I1'],
  ['i8', 'I8'],
  ['i16', 'I16'],
  ['i32', 'I32'],
  ['i64', 'I64'],
  ['index', 'Index'],
  ['f16', 'F16'],
  ['bf16', 'BF16'],
  ['f32', 'F32'],
  ['f64', 'F64'],
  ['anyfloat', 'AnyFloat'],
  ['anymemref', 'AnyMemRef'],
  ['anytype', 'AnyType'],
  ['nonetype', 'NoneType'],
]);

/** 类型约束里绝对不能出现的字符：会破坏 .td 结构或路径语义。 */
const FORBIDDEN_TYPE_RE = /["$;{}\\\/\u0000-\u001f]/;

/**
 * 规范化 dialect 名：接受 `toy` / `Toy` / `ToyDialect`，输出首字母大写的记录前缀。
 * @returns {{ok: boolean, error: string|null, dialect: string, lower: string}}
 */
export function normalizeDialect(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return fail('dialect 不能为空：给一个名字，例如 Toy。');
  if (/[\\/\s$]/.test(text) || text.includes('..')) {
    return fail('dialect 名字非法：不允许路径分隔符、空白、$、..（收到 ' + JSON.stringify(text) + '）。');
  }
  let base = text;
  if (base.length > 'Dialect'.length && base.endsWith('Dialect')) base = base.slice(0, -'Dialect'.length);
  if (base === '') return fail('dialect 名字非法：不能只有 Dialect。');
  if (base.toLowerCase() === 'dialect') {
    return fail('dialect 名字非法：' + JSON.stringify(text) + ' 只剩 Dialect 后缀，给一个真正的名字，例如 Toy。');
  }
  const dialect = base[0].toUpperCase() + base.slice(1);
  if (!RECORD_RE.test(dialect)) {
    return fail('dialect 名字非法：' + JSON.stringify(text) + '，要求 ' + RECORD_RE.source + '（字母开头，只含字母数字下划线）。');
  }
  return { ok: true, error: null, dialect, lower: dialect[0].toLowerCase() + dialect.slice(1) };
}

/**
 * 规范化 C++ 命名空间：接受 `toy` / `::toy` / `foo::bar`，统一成 `::foo::bar`。
 * 缺省用 `::<dialect 小写>`。
 */
export function normalizeNamespace(raw, dialectLower) {
  const fallback = '::' + dialectLower;
  if (raw === undefined || raw === null) return { ok: true, error: null, cppNamespace: fallback };
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { ok: true, error: null, cppNamespace: fallback };
  const body = text.startsWith('::') ? text.slice(2) : text;
  const segments = body.split('::');
  for (const segment of segments) {
    if (!RECORD_RE.test(segment)) {
      return fail('cppNamespace 非法：' + JSON.stringify(text) + '，每段都要求字母开头，只含字母数字下划线（如 ::toy 或 ::my::toy）。');
    }
  }
  return { ok: true, error: null, cppNamespace: '::' + segments.join('::') };
}

/**
 * 规范化 op 名：接受 `Add` / `AddOp` / `Toy_AddOp` / `toy.add`。
 * 记录名 = <Dialect>_<Name>Op，mnemonic = <dialect>.<name 小写>。
 * @returns {{ok: boolean, error: string|null, name: string, record: string, mnemonic: string}}
 */
export function normalizeOp(rawName, dialectInfo) {
  const text = typeof rawName === 'string' ? rawName.trim() : '';
  if (text === '') return fail('op 的 name 不能为空。');
  if (/[\\/\s$]/.test(text) || text.includes('..')) {
    return fail('op 名字非法：' + JSON.stringify(text) + '，不允许路径分隔符、空白、$、..。');
  }
  let base = text;
  if (text.includes('.')) {
    const parts = text.split('.');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      return fail('op mnemonic 非法：' + JSON.stringify(text) + '，应形如 toy.add（恰好一个点）。');
    }
    if (parts[0].toLowerCase() !== dialectInfo.lower.toLowerCase()) {
      return fail('op mnemonic 的方言前缀必须等于 dialect 名：期望 ' + dialectInfo.lower + '.' + parts[1] + '，收到 ' + text + '。');
    }
    base = parts[1];
  } else if (base.toLowerCase().startsWith(dialectInfo.dialect.toLowerCase() + '_')) {
    base = base.slice(dialectInfo.dialect.length + 1);
  }
  if (base.length > 2 && base.endsWith('Op')) base = base.slice(0, -2);
  if (base === '') return fail('op 名字非法：' + JSON.stringify(text) + '，去掉方言前缀与 Op 后缀后为空。');
  const name = base[0].toUpperCase() + base.slice(1);
  if (!RECORD_RE.test(name)) {
    return fail('op 名字非法：' + JSON.stringify(text) + '，规范化后为 ' + JSON.stringify(name) + '，要求 ' + RECORD_RE.source + '。');
  }
  return {
    ok: true,
    error: null,
    name,
    record: dialectInfo.dialect + '_' + name + 'Op',
    mnemonic: dialectInfo.lower + '.' + name.toLowerCase(),
  };
}

/**
 * 展开operand/result 类型约束：支持 Variadic<T> 递归与常见别名，其余原样透传。
 * @returns {{ok: boolean, error: string|null, text: string}}
 */
export function expandTypeConstraint(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { ok: false, error: 'type 不能为空：写类型约束，例如 I32 或 Variadic<I32>。', text: '' };
  if (FORBIDDEN_TYPE_RE.test(text)) {
    return { ok: false, error: 'type 含非法字符：' + JSON.stringify(text) + '（不允许引号、$、;、花括号、斜杠、控制字符）。', text: '' };
  }
  if (text.includes('..')) {
    return { ok: false, error: 'type 含非法字符序列 ..：' + JSON.stringify(text) + '。', text: '' };
  }
  const variadic = /^Variadic\s*<\s*([\s\S]+?)\s*>$/i.exec(text);
  if (variadic !== null) {
    const inner = expandTypeConstraint(variadic[1]);
    if (!inner.ok) return inner;
    return { ok: true, error: null, text: 'Variadic<' + inner.text + '>' };
  }
  const alias = TYPE_ALIASES.get(text.toLowerCase());
  return { ok: true, error: null, text: alias === undefined ? text : alias };
}

/**
 * 校验参数名（operand/result/attribute 的 $name 部分）。
 * @returns {{ok: boolean, error: string|null}}
 */
export function checkParamName(raw, what) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return fail(what + ' 的 name 不能为空。');
  if (!PARAM_RE.test(text)) {
    return fail(what + ' 的 name 非法：' + JSON.stringify(text) + '，要求 ' + PARAM_RE.source + '（不能含 $、空白、路径分隔符）。');
  }
  return { ok: true, error: null };
}

/** TableGen 字符串字面量转义：反斜杠、双引号、换行。 */
export function escapeTdString(raw) {
  const text = typeof raw === 'string' ? raw : '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** 统一的失败返回形状（dialect/op/type 三类规范化共用）。 */
function fail(error) {
  return { ok: false, error, dialect: '', lower: '', name: '', record: '', mnemonic: '', cppNamespace: '' };
}
