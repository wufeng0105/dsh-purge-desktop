/**
 * test/helpers/settings-fragment.mjs — 在 VM 里跑设置页片段里的纯函数，并解析 i18n 文案。
 *
 * 为什么需要它：设置页的判定（结论句、计数、人话映射、导航条目）住在
 * `lib/client-src/settings/**` 的片段里 —— 那些文件被文本装配进 `client.js`，
 * `node --test` 不能 import 它。若判据只做「源码里有没有某个字符串」，
 * 「pending 存在时不得说全部生效」这种分支就没人守得住。
 *
 * 这里的做法：把片段正文放进最小 VM 求值（片段顶层只有函数声明与常量，不求值渲染路径），
 * 再把需要的纯函数取出来。渲染函数（`SettingsPage`）在 VM 里只是被**定义**，不会被调用。
 *
 * 模块顶层零副作用：不读文件、不建 VM —— 一切都在函数里（`node --test` 会加载本文件）。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const readRepo = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

/**
 * 求值一个片段，取回它里面的纯函数。
 *
 * @param {string} rel 片段相对仓库根的路径
 * @param {string[]} names 要取回的函数名
 * @returns {Record<string, Function>}
 */
export function loadFragmentHelpers(rel, names) {
  const source = readRepo(rel);
  const context = vm.createContext({});
  const exportLine = `\n;globalThis.__helpers = { ${names.map((n) => `${n}: typeof ${n} === "function" ? ${n} : undefined`).join(", ")} };\n`;
  vm.runInContext(source + exportLine, context, { filename: rel });
  const helpers = context.__helpers || {};
  const missing = names.filter((name) => typeof helpers[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`${rel} 里取不到这些纯函数：${missing.join("、")}（片段结构变了，判据已失效）`);
  }
  return helpers;
}

/**
 * i18n 的两份词典文本（不含 `const zh = {` / `const en = {` 那一行）。
 *
 * @returns {{zh:string, en:string}}
 */
export function dictionaryTexts() {
  const text = readRepo("lib/client-src/i18n.js");
  const zhAt = text.indexOf("const zh = {");
  const enAt = text.indexOf("const en = {");
  if (zhAt < 0 || enAt <= zhAt) throw new Error("i18n.js 的两份词典结构变了");
  return { zh: text.slice(zhAt, enAt), en: text.slice(enAt) };
}

/**
 * 一份词典里某个键的文案原文。
 *
 * 找不到返回 null（而不是抛错）：调用方要能对「缺键」给出自己的失败信息。
 *
 * @param {string} dict 词典文本
 * @param {string} key 键名
 * @returns {string|null}
 */
export function textOfKey(dict, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`"${escaped}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(dict);
  if (!m) return null;
  return JSON.parse(`"${m[1]}"`);
}

/**
 * 按 `t(key, params)` 的约定把占位符换掉：`{name}` → params.name。
 *
 * 与客户端的 t 口径一致；缺参数时保留占位符原样（那样用例会看见 `{pending}` 而红）。
 *
 * @param {string} text 文案原文
 * @param {Record<string,string>} [params] 占位符取值
 */
export function fillTemplate(text, params = {}) {
  return String(text).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => (
    Object.hasOwn(params, name) ? String(params[name]) : whole
  ));
}

/**
 * 某一条命令输出里「渲染文本」的证据：把键解析成两份词典里的句子。
 *
 * @param {string} key 文案键
 * @param {Record<string,string>} [params] 占位符
 * @returns {{key:string, zh:string, en:string}}
 */
export function renderKey(key, params = {}) {
  const dict = dictionaryTexts();
  const zh = textOfKey(dict.zh, key);
  const en = textOfKey(dict.en, key);
  if (zh === null || en === null) throw new Error(`词典里缺键：${key}`);
  return { key, zh: fillTemplate(zh, params), en: fillTemplate(en, params) };
}
