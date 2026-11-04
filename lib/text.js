const TRUNCATION_MARKER = '\n...truncated...\n';

/** 按 UTF-8 字节数截断，且不切断多字节字符。 */
function sliceBytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

/** stderr/stdout 统一截断：保留头尾，中间标 ...truncated...。 */
export function clipHeadTail(text, maxBytes) {
  const value = typeof text === 'string' ? text : '';
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text: value, truncated: false };
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  const head = sliceBytes(value, Math.ceil(budget * 0.6));
  const tail = sliceBytes(value.slice(head.length), Math.floor(budget * 0.4));
  return { text: head + TRUNCATION_MARKER + tail, truncated: true };
}

/** 只要头部的截断（用于错误清单这类结构化输出）。 */
export function clipHead(text, maxBytes) {
  const value = typeof text === 'string' ? text : '';
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text: value, truncated: false };
  const out = sliceBytes(value, maxBytes);
  return { text: out === value ? value : out + '...', truncated: out !== value };
}
