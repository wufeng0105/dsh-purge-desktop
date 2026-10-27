/**
 * 样式收敛后的四条纪律，全部从 CSS 本体反查（不依赖中间产物）。
 *
 * 为什么从 CSS 反查：中间映射表能写成任何形状，而门禁要守的是**最终样式**。
 * 这里直接解析三段 CSS 的声明，按属性族判断变量用得对不对 —— 表写错但 CSS 对，算过；
 * 表写对却有人往 CSS 里塞回一个字面量，这里红。
 *
 *   A 变量与属性族匹配：前景属性不得出现 scrim / bg-*；背景属性不得出现 text*。
 *   B 状态变量只能出现在状态语境选择器上（stage / badge / alert / 错误 / 得分…）。
 *   C 没有游离颜色字面量：CSS 里剩下的每个颜色都必须出现在 :root 的兜底里。
 *   D 兜底收敛：:root 里不同兜底字面量 ≤ 20，且与 CSS 里出现的颜色集合逐一对齐。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const FG_PROPS = new Set(["color", "fill", "stroke", "-webkit-text-fill-color"]);
const BG_PROPS = new Set(["background", "background-color", "box-shadow", "background-image"]);
const BORDER_PROPS = /^(border|border-[a-z-]+|outline|outline-[a-z-]+)$/;
const STATE_SELECTOR_RE = /stage|badge|alert|warn|danger|error|err\b|success|\bok\b|fail|score|risk|tag|pill/i;
const STATE_VARS = /--dshp-c-(warn|danger|info|brand|accent)\b/;

/** 样式正文分三份片段存放；拼接入口里只剩一行加法，没有声明可读。 */
function cssSegments() {
  const out = [];
  for (const rel of [
    "lib/client-src/design/tokens.js",
    "lib/client-src/design/components.js",
    "lib/client-src/design/layout.js",
    "lib/client-src/rewind/rewind-ui.js",
  ]) {
    for (const m of read(rel).match(/`[\s\S]{500,}?`/g) || []) {
      if (m.includes("{") && m.includes(":")) out.push({ rel, css: m.slice(1, -1) });
    }
  }
  const drill = read("lib/redteam/client.js");
  const anchor = drill.search(/const\s+CSS\s*=\s*`/);
  if (anchor >= 0) {
    const open = drill.indexOf("`", anchor);
    out.push({ rel: "lib/redteam/client.js", css: drill.slice(open + 1, drill.indexOf("`", open + 1)) });
  }
  return out;
}

/**
 * 扫描集合：A/B 的判据形状是「遍历片段、把违规项收进 bad、断言 bad 为空」——片段清单读不到
 * 内容时循环空转，`deepEqual([], [])` 照样通过，门禁静默变绿。所以先断言集合非空（三份片段
 * 加演练台那一段，至少 3 段），A/B 再从这份集合取片段，清单写错或片段被清空都会红。
 */
function scannedSegments() {
  const segs = cssSegments();
  assert.ok(
    segs.length >= 3,
    `扫描集合只有 ${segs.length} 个片段（期望 ≥3）：cssSegments() 的清单与磁盘不符，A/B 会空转成假绿`,
  );
  return segs;
}

/** 把一小段 CSS 拆成 {selector, prop, value}（单层规则与 @media 内单层够用）。 */
function declarations(css) {
  const out = [];
  const stack = [];
  let pending = "";
  let decl = "";
  let depth = 0;
  const flush = () => {
    const text = decl;
    decl = "";
    const colon = text.indexOf(":");
    if (colon < 0) return;
    out.push({ selector: stack.join(" "), prop: text.slice(0, colon).trim(), value: text.slice(colon + 1) });
  };
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (depth === 0) {
      if (c === "{") { stack.push(pending.trim()); pending = ""; depth += 1; continue; }
      pending += c;
      continue;
    }
    if (c === "{") { stack.push(""); depth += 1; continue; }
    if (c === "}") { flush(); stack.pop(); depth -= 1; continue; }
    if (c === ";") { flush(); continue; }
    decl += c;
  }
  flush();
  return out;
}

const familyOf = (prop) => {
  const p = prop.toLowerCase();
  if (FG_PROPS.has(p)) return "fg";
  if (BG_PROPS.has(p)) return "bg";
  if (BORDER_PROPS.test(p)) return "border";
  return "other";
};

function rootFallbacks() {
  const tokens = read("lib/client-src/design/tokens.js");
  const rootMatch = /:root\{([^}]*)\}/.exec(tokens);
  assert.ok(rootMatch, "找不到 :root 里的桶定义");
  const fallbacks = new Set();
  for (const decl of rootMatch[1].split(";")) {
    const m = /var\(--dsw-alias-[a-z0-9-]+,\s*([^)]+)\)/.exec(decl);
    if (m) { fallbacks.add(m[1].trim().toLowerCase()); continue; }
    for (const c of decl.match(COLOR_RE) || []) fallbacks.add(c.toLowerCase());
  }
  return fallbacks;
}

test("A：变量与属性族匹配（前景不许 bg/scrim，背景不许 text）", () => {
  const bad = [];
  for (const seg of scannedSegments()) {
    for (const d of declarations(seg.css)) {
      const family = familyOf(d.prop);
      if (family === "fg" && /--dshp-c-(scrim|bg-[a-z-]+)\b/.test(d.value)) bad.push(`${seg.rel} ${d.selector} {${d.prop}: ${d.value.trim()}}`);
      if (family === "bg" && /--dshp-c-text(-muted)?\b/.test(d.value)) bad.push(`${seg.rel} ${d.selector} {${d.prop}: ${d.value.trim()}}`);
    }
  }
  assert.deepEqual(bad, [], `属性族与变量不匹配：\n  ${bad.join("\n  ")}`);
});

test("B：状态变量只出现在状态语境的选择器上", () => {
  const bad = [];
  for (const seg of scannedSegments()) {
    for (const d of declarations(seg.css)) {
      if (!STATE_VARS.test(d.value)) continue;
      if (/^--dshp-/.test(d.prop)) continue; // 变量定义本身
      if (STATE_SELECTOR_RE.test(d.selector)) continue;
      bad.push(`${seg.rel} ${d.selector} {${d.prop}: ${d.value.trim()}}`);
    }
  }
  assert.deepEqual(bad, [], `状态变量用在了非状态语境：\n  ${bad.join("\n  ")}`);
});

test("C：没有游离颜色字面量（剩下的颜色必须全部出现在 :root 兜底里）", () => {
  const fallbacks = rootFallbacks();
  const stray = [];
  for (const seg of cssSegments()) {
    for (const c of seg.css.match(COLOR_RE) || []) {
      if (!fallbacks.has(c.toLowerCase())) stray.push(`${seg.rel}: ${c}`);
    }
  }
  assert.deepEqual(stray, [], `有绕过变量的字面量：\n  ${stray.join("\n  ")}`);
});

test("D：兜底收敛（不同兜底 ≤20，且与 CSS 里出现的颜色集合一致）", () => {
  const fallbacks = rootFallbacks();
  assert.ok(fallbacks.size <= 20, `:root 兜底有 ${fallbacks.size} 个，超过 20`);
  const all = new Set();
  for (const seg of cssSegments()) for (const c of seg.css.match(COLOR_RE) || []) all.add(c.toLowerCase());
  assert.deepEqual([...all].sort(), [...fallbacks].sort(), "CSS 里出现的颜色集合与 :root 兜底不一致");
});
