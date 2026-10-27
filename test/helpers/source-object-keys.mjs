/**
 * test/helpers\source-object-keys.mjs — 从源码文本里取对象字面量的顶层键名，供「字段必须登记」这类断言复用。
 *
 * 为什么要把这件事做成函数而不是每个用例各写一遍：按行号切源码的写法一旦被挪动就会
 * 静默取到别的对象，于是判据看起来还在、实际已经失效。这里只认「从 marker 里那个
 * `{` 起数平衡花括号」这一条口径，取错对象时会得到空键表并让断言直接红。
 *
 * 顶层键的判据：depth 1 且冒号前的最后一个词是标识符；`...` 展开行整行跳过 ——
 * 展开的键在静态文本里不可见，所以调用方必须另判「有没有展开行」。
 */

/**
 * 取 marker 之后第一个对象的**顶层**键名。
 *
 * @param {string} text 源码全文
 * @param {string} marker 以 `{` 结尾的切片起点（例如 `sendJson(response, 200, {`）
 * @returns {string[]} 顶层键名，按出现顺序
 */
export function topLevelKeysOf(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return [];
  const open = at + marker.length - 1;
  if (text[open] !== "{") return [];
  const keys = [];
  let depth = 0;
  let lineStart = open + 1;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") {
      lineStart = i + 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && ch === ":" && !/^\s*\.\.\./.test(text.slice(lineStart, i))) {
      const before = text.slice(lineStart, i);
      const found = before.match(/(?:^|[{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      if (found) keys.push(found[1]);
      lineStart = i + 1;
    }
  }
  return keys;
}

/**
 * marker 之后那个对象里有没有 `...` 展开行。
 *
 * 存在的意义：展开行里的键在源码文本里读不到，光看键表会漏登记。调用方用它把
 * 「静态可枚举」变成一条可断言的属性 —— 有展开就红，逼人改成显式键。
 *
 * @param {string} text 源码全文
 * @param {string} marker 以 `{` 结尾的切片起点
 * @returns {string[]} 展开行的原文（去掉缩进），没有则为空数组
 */
export function spreadsIn(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return [];
  const open = at + marker.length - 1;
  if (text[open] !== "{") return [];
  const out = [];
  let depth = 0;
  let lineStart = open + 1;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") {
      lineStart = i + 1;
      continue;
    }
    if (depth === 1 && ch === "." && text.startsWith("...", i) && /^\s*$/.test(text.slice(lineStart, i))) {
      const lineEnd = text.indexOf("\n", i);
      out.push(text.slice(i, lineEnd < 0 ? text.length : lineEnd).trim());
      i = lineEnd < 0 ? text.length : lineEnd;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return out;
}
