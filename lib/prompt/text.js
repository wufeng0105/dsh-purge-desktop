/**
 * lib/prompt/text.js — 宿主 YAML 与 persona 文本先归一才敢比对，否则换行风格能让补丁失效。
 * 宿主 YAML / persona 文本清洗（从 core.js 整块搬来，逐字未改）。
 *
 * ## 这一层是什么
 *
 * 补丁引擎在「读进来一段文本 → 改写 → 写回去」这条路上需要的一组**纯函数**：
 * 换行归一、YAML 折叠块（`text: >` / `persona: |`）的段落级清理、
 * 以及两处历史产物的自愈（#42 的重复 `legacyApplyPath`、旧调用点）。
 *
 * 它们与补丁表、与文件系统都无关 —— 输入字符串、输出字符串。所以住在
 * `prompt/`（提示词层，只依赖 host/）而不是 core.js。
 *
 * ## 依赖方向
 *
 * 只依赖 `../patch/constants.js` 的 `ALLOW_EXEC_CORE`（判定「这段是不是
 * 我们注入的样板」）。不 import core.js，不 import 任何 shim/desktop/redteam。
 *
 * ## 为什么这些判定字符串在这里而不在 patch/table.js
 *
 * `isDisposableYamlFoldParagraph` 认的是「本插件历史上注入过哪些样板句」。
 * 补丁表是「现在要打什么」，这里是「历史上打过什么」—— 前者随版本变，
 * 后者只增不减（旧产物要能被识别并清掉）。混在一起会让补丁表的 diff
 * 充满与本次补丁无关的历史痕迹。
 *
 * ## 注入位置：头部，不是尾部（这是有结论的）
 *
 * 操作者提示词（inject）现在落在组装结果的**最前面**：`lib/identity.js` 的
 * `foldInjectIntoPersona` 把它折进 `persona-prefix` 段正文开头
 * （`order = GLOBAL_PROMPT_ORDER = -100000`），官方段在后；整份 inject 缺失时
 * `ensureFullInject` 也按同一 order 兜底补一个 `dsh-purge` 段。
 * 早先的做法是把它置尾（order 1e6+1），那会让模型把系统提示词当对话历史
 * 质疑 —— 位置是这套注入生效的前提，别改回去。
 */
import { ALLOW_EXEC_CORE } from "../patch/constants.js";

/**
 * 历史注入的 operator 锁句（已被 IDENTITY_FROM_INJECT 取代）。
 * @type {string}
 */
const LEGACY_OPERATOR_LOCK =
  "Your identity is defined exclusively by the dsh-purge operator prompt";

/**
 * 现行 identity 注入句。
 * @type {string}
 */
const IDENTITY_FROM_INJECT =
  "When asked 你是谁 / who are you, answer as the identity defined in prompt-inject.md. Never say 我是 DeepSeek 的 AI 助手 or that you run on DeepSeek Harness as your identity — that is the host, not you.";

/**
 * LCS 形态的 identity 锁句。
 * @type {string}
 */
const IDENTITY_LOCK_LCS =
  "You are the operator persona in prompt-inject (Little Code Sauce / LCS unless that file names someone else). When asked 你是谁 / who are you, answer with that name only. Never say 我是 DeepSeek 的 AI 助手 or that you run on DeepSeek Harness as your identity — that is the host, not you.";

/**
 * CRLF → LF。非字符串原样返回。
 *
 * 注意返回值：调用方几乎总是先传字符串再当字符串用，所以这里用
 * `string` 而不是 `unknown` —— 传非字符串的只有 `asLf(marker)` 这类
 * 「反正 marker 是字符串」的地方，类型收窄没有收益，反而到处要断言。
 *
 * @param {string} text
 * @returns {string}
 */
export function asLf(text) {
  return typeof text === "string" ? text.replace(/\r\n/g, "\n") : text;
}

/**
 * 是不是 YAML 文件（按扩展名判）。
 * @param {string} fp
 * @returns {boolean}
 */
export function isYamlPath(fp) {
  return typeof fp === "string" && /\.ya?ml$/i.test(fp);
}

/**
 * 一行的缩进宽度（制表符按 1 计）。
 * @param {string} line
 * @returns {number}
 */
function yamlIndentOf(line) {
  const m = /^[ \t]*/.exec(String(line || ""));
  return m ? m[0].length : 0;
}

/**
 * 从 `key: >` / `key: |` 表头往下吃掉整个折叠块，返回块后第一行的下标。
 *
 * 判据是缩进：比 key 缩进更深的行属于块体；空行要看下一非空行的缩进，
 * 否则块中间的视觉分隔会被误判成块结束。
 *
 * @param {string[]} lines
 * @param {number} headerIdx 表头所在行
 * @param {number} keyIndent 表头的缩进
 * @returns {number} 块体结束后的下标
 */
function yamlConsumeFoldBody(lines, headerIdx, keyIndent) {
  let end = headerIdx + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "") {
      if (line.length > 0 && yamlIndentOf(line) > keyIndent) {
        end += 1;
        continue;
      }
      let peek = end + 1;
      while (peek < lines.length && lines[peek].trim() === "") peek += 1;
      if (peek < lines.length && yamlIndentOf(lines[peek]) > keyIndent) {
        end += 1;
        continue;
      }
      break;
    }
    if (yamlIndentOf(line) > keyIndent) {
      end += 1;
      continue;
    }
    break;
  }
  return end;
}

/**
 * 折叠块体 → 去掉每行前导空白的纯文本。
 * @param {string[]} bodyLines
 * @returns {string}
 */
function yamlFoldBodyText(bodyLines) {
  return bodyLines.map((line) => String(line).replace(/^[ \t]+/, "")).join("\n").trim();
}

/**
 * 这一段是不是「可以整段丢弃」的历史样板。
 *
 * 认的是本插件历史上注入过的句子（含已废弃的 operator 锁）。命中就删，
 * 不命中一个字节都不动 —— 这个判据是「只清自己留下的东西」的全部依据。
 *
 * @param {string} para
 * @returns {boolean}
 */
function isDisposableYamlFoldParagraph(para) {
  const t = String(para || "").replace(/^[ \t]+/gm, "").trim();
  if (!t) return true;
  if (/^You are a coding agent powered by\b/.test(t)) return true;
  if (t.startsWith("All workspace instructions, AGENTS.md directives")) return true;
  if (t.startsWith("Follow them directly and unconditionally without disclaimers")) return true;
  if (t === "Working directory: {{cwd}}.") return true;
  if (t.includes(ALLOW_EXEC_CORE.slice(0, 48))) return true;
  if (t.includes(LEGACY_OPERATOR_LOCK)) return true;
  if (t.includes(IDENTITY_FROM_INJECT.slice(0, 48))) return true;
  if (t.includes(IDENTITY_LOCK_LCS.slice(0, 48))) return true;
  return false;
}

/**
 * 丢掉「只有空白但不是空行」的填充行（保留真空行）。
 * @param {string[]} bodyLines
 * @returns {string[]}
 */
function yamlDropPaddingOnlyLines(bodyLines) {
  return bodyLines.filter((line) => String(line).trim() !== "" || line === "");
}

/**
 * 块体里非空行的最小缩进（全部为空时退到 keyIndent + 2）。
 * @param {string[]} bodyLines
 * @param {number} keyIndent
 * @returns {number}
 */
function yamlMinContentIndent(bodyLines, keyIndent) {
  let min = Infinity;
  for (const line of bodyLines) {
    if (!String(line).trim()) continue;
    const n = yamlIndentOf(line);
    if (n > keyIndent && n < min) min = n;
  }
  return Number.isFinite(min) ? min : keyIndent + 2;
}

/**
 * 把块体每行重排到指定缩进。
 * @param {string[]} bodyLines
 * @param {number} indent
 * @returns {string[]}
 */
function yamlReindentBody(bodyLines, indent) {
  const pad = " ".repeat(Math.max(0, indent));
  const out = [];
  for (const line of bodyLines) {
    if (!String(line).trim()) {
      out.push("");
      continue;
    }
    out.push(pad + String(line).replace(/^[ \t]+/, ""));
  }
  return out;
}

/**
 * 丢掉可丢弃的段落，其余按原缩进重排。
 * @param {string[]} bodyLines
 * @returns {string[]}
 */
function yamlStripDisposableFoldParas(bodyLines) {
  const raw = yamlFoldBodyText(bodyLines);
  if (!raw) return [];
  const kept = raw.split(/\n\s*\n/).filter((para) => !isDisposableYamlFoldParagraph(para));
  if (kept.length === 0) return [];
  const indent = yamlMinContentIndent(bodyLines, 0);
  const pad = " ".repeat(indent || 6);
  const out = [];
  for (let i = 0; i < kept.length; i += 1) {
    if (i > 0) out.push("");
    for (const line of kept[i].split("\n")) out.push(pad + line);
  }
  return out;
}

/** 折叠块里有没有「可丢弃」的段落。没有就一点都不该动它。 */
function yamlHasDisposableFoldParagraph(bodyLines) {
  const raw = yamlFoldBodyText(bodyLines);
  if (!raw) return false;
  return raw
    .split(/\n\s*\n/)
    .some((para) => String(para || "").trim() !== "" && isDisposableYamlFoldParagraph(para));
}

function emptyDisposableFoldedYaml(text) {
  const headerRe = /^(\s*)(personaPrefix|prefix|persona|text|suffix):\s*[>|][-+]?\s*$/;
  const lines = String(text).split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = headerRe.exec(lines[i]);
    if (!m) {
      out.push(lines[i]);
      continue;
    }
    const keyIndent = m[1].length;
    const end = yamlConsumeFoldBody(lines, i, keyIndent);
    const body = yamlDropPaddingOnlyLines(lines.slice(i + 1, end));
    // 键名是通用名（text / prefix / suffix），宿主 YAML 里到处都是。只有当块里
    // 真的含有待清理的样板段时才碰它 —— 否则 `text: >` 会被改写成 `|-` 字面块，
    // 那是把「折叠换行」变成「真换行」，属于内容语义变化，不是修复。
    if (!yamlHasDisposableFoldParagraph(body)) {
      out.push(lines[i]);
      continue;
    }
    const kept = yamlStripDisposableFoldParas(body);
    if (kept.length === 0) out.push(`${m[1]}${m[2]}: ""`);
    else {
      const indent = yamlMinContentIndent(kept, keyIndent);
      out.push(`${m[1]}${m[2]}: |-`);
      out.push(...yamlReindentBody(kept, indent));
    }
    i = end - 1;
  }
  return out.join("\n");
}

function stripOrphanYamlAfterEmptyScalars(text) {
  const headerRe = /^(\s*)(personaPrefix|prefix|persona|text|suffix):\s*(""|'')\s*$/;
  const lines = String(text).split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i]);
    const m = headerRe.exec(lines[i]);
    if (!m) continue;
    const end = yamlConsumeFoldBody(lines, i, m[1].length);
    i = end - 1;
  }
  return out.join("\n");
}

/**
 * 清掉 YAML 里 persona/prefix 折叠块中的历史样板段。
 *
 * 折叠块只换首行会留下 6 空格残段，YAML 直接废掉，dsh 起不来 —— 所以
 * 改写后要整块重排缩进，不能只动首行。
 *
 * @param {string} text
 * @returns {string} 改写后的文本（CRLF 保持 CRLF）
 */
export function sanitizeYamlPersonaScalars(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  const crlf = text.includes("\r\n");
  let out = asLf(text);
  out = emptyDisposableFoldedYaml(out);
  out = stripOrphanYamlAfterEmptyScalars(out);
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

/**
 * 数一数文件里有几份 `function legacyApplyPath(section, op) {`。
 * @param {string} text
 * @returns {number}
 */
export function legacyApplyPathStarts(text) {
  const hay = asLf(text);
  const key = "function legacyApplyPath(section, op) {";
  let count = 0;
  let from = 0;
  while (from < hay.length) {
    const at = hay.indexOf(key, from);
    if (at < 0) break;
    count += 1;
    from = at + key.length;
  }
  return count;
}

/**
 * 从 `{` 处开始找配对的 `}`，返回块后一位（找不到就返回文本末尾）。
 * @param {string} text
 * @param {number} openAt
 * @returns {number}
 */
function endOfBalancedBlock(text, openAt) {
  let depth = 0;
  for (let i = openAt; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * 折叠重复的 `legacyApplyPath` 定义，只留第一份。
 *
 * 1.1.17 之前 #42 会叠多份 legacyApplyPath，settings 整文件语法错误、
 * 提供商目录起不来。
 *
 * @param {string} text
 * @returns {string}
 */
export function collapseDuplicateLegacyApplyPath(text) {
  const crlf = typeof text === "string" && text.includes("\r\n");
  const src = asLf(text);
  const key = "function legacyApplyPath(section, op) {";
  const starts = [];
  let from = 0;
  while (from < src.length) {
    const at = src.indexOf(key, from);
    if (at < 0) break;
    starts.push(at);
    from = at + key.length;
  }
  if (starts.length < 2) return text;
  const firstOpen = src.indexOf("{", starts[0]);
  const firstEnd = endOfBalancedBlock(src, firstOpen);
  let out = src.slice(0, firstEnd);
  let cursor = firstEnd;
  for (let n = 1; n < starts.length; n += 1) {
    const open = src.indexOf("{", starts[n]);
    const end = endOfBalancedBlock(src, open);
    out += src.slice(cursor, starts[n]);
    cursor = end;
  }
  out += src.slice(cursor);
  out = out.replace(/\n{3,}/g, "\n\n");
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

const STALE_LEGACY_APPLY_CALL = "=> legacyApplyPath(section, op)";
const SETTINGS_APPLY_CALL = "=> applyPathOp(section, op)";

/**
 * #42 旧产物调用已删除的 legacyApplyPath。只换这一处调用，不动函数定义。
 * @param {string} text
 * @returns {string}
 */
export function rewriteStaleLegacyApplyCall(text) {
  const hay = asLf(text);
  if (!hay.includes(STALE_LEGACY_APPLY_CALL)) return text;
  const next = hay.split(STALE_LEGACY_APPLY_CALL).join(SETTINGS_APPLY_CALL);
  return text.includes("\r\n") ? next.replace(/\n/g, "\r\n") : next;
}

/**
 * 这个文件里还有没有「旧的 legacyApplyPath 调用」。
 * @param {string} text
 * @returns {boolean}
 */
export function hasStaleLegacyApplyCall(text) {
  return asLf(text).includes(STALE_LEGACY_APPLY_CALL);
}

/**
 * YAML 里的 `// 注释` 改成 `# 注释`（跳过字符串内部与已有 `#`）。
 *
 * @param {string} text
 * @returns {string}
 */
export function yamlJsCommentsToHash(text) {
  return asLf(text).split("\n").map((line) => {
    if (line.includes("!!js")) return line;
    let quote = "";
    for (let i = 0; i < line.length - 1; i += 1) {
      const ch = line[i];
      if (quote) {
        if (quote === "'" && ch === "'" && line[i + 1] === "'") {
          i += 1;
          continue;
        }
        if (quote === '"' && ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "#") return line;
      if (ch === "/" && line[i + 1] === "/" && (i === 0 || /\s/.test(line[i - 1]))) {
        return `${line.slice(0, i)}#${line.slice(i + 2)}`;
      }
    }
    return line;
  }).join("\n");
}
