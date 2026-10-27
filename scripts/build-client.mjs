/**
 * scripts/build-client.mjs — 片段只有一处装配入口，产物才是纯输出。
 * client.js 的唯一生成入口：**单向装配**。
 *
 *   输入：lib/client-src/shell.js        （模板：ModuleLoader 外壳 + 占位符 + apply/inject）
 *         lib/client-src/**\/*.js         （各模块正文，由占位符整行替换进来）
 *         lib/redteam/client.js          （演练台片段，嵌进 drill marker 之间）
 *   输出：client.js
 *
 * ## 单向装配的前提
 *
 * 老链是「读产物 → 拼接/替换 → 写回」，产物既是输入又是输出，于是：
 *   - 从零复现不可能（产物里有什么才留下什么）
 *   - 任何只存在于产物里的代码，跑一次 build 就静默消失
 *
 * 现在产物**只是输出**：删掉 client.js 也能一字不差地重建它，
 * `npm run build:client && git diff --exit-code client.js` 才是有意义的门禁。
 *
 * ## 占位符
 *
 * shell.js 里的 `/* __DSHP_SLOT:<name>__ *\/` 是**整行**占位符，替换后不带缩进
 * （正文自带）：源文件里的 tab 缩进会原样落进产物。这是「逐字节相同」的前提 ——
 * 改这一段时别加/减缩进，也别顺手改排版。
 *
 * 用法：node scripts/build-client.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "lib", "client-src");
const shellPath = join(srcDir, "shell.js");
const drillSrc = join(root, "lib", "redteam", "client.js");
const clientPath = join(root, "client.js");

const BEGIN = "/* __DSH_PURGE_DRILL_BEGIN__ */";
const END = "/* __DSH_PURGE_DRILL_END__ */";

/**
 * 占位符 → 源文件。**这份映射是唯一权威**：少登记一个占位符，build 直接报错，
 * 而不是把占位注释静默留在产物里。
 */
const SLOT_FILES = {
  i18n: "i18n.js",
  "design-tokens": "design/tokens.js",
  "design-components": "design/components.js",
  "design-layout": "design/layout.js",
  "purge-css": "dock/purge-css.js",
  "settings-rows": "settings/rows.js",
  "settings-store": "settings/store.js",
  "settings-ui": "settings/ui.js",
  "settings-page": "settings/page.js",
  "settings-status-tab": "settings/status-tab.js",
  "settings-patches-tab": "settings/patches-tab.js",
  "settings-config-tab": "settings/config-tab.js",
  "settings-skills-tab": "settings/skills-tab.js",
  "settings-diagnostics-tab": "settings/diagnostics-tab.js",
  "settings-host": "settings/host.js",
  "rewind-ui": "rewind/rewind-ui.js",
  "dock-auth": "dock/auth.js",
  "dock-auth-gate": "dock/auth-gate.js",
  "dock-env-gate": "dock/env-gate.js",
  "rewind-install": "rewind/install.js",
  "settings-p1-section": "settings/p1-section.js",
  "drill-copy": "main/drill-copy.js",
  "main-drill-panel": "main/drill-panel.js",
  "welcome-helpers": "welcome-helpers.js",
  "welcome-notice": "welcome-notice.js",
};

/** 剥掉文件头块注释与紧随的空行，返回正文（逐字节）。 */
function bodyOf(name) {
  const rel = SLOT_FILES[name];
  if (!rel) throw new Error(`未登记的占位符：${name}（先加到 SLOT_FILES）`);
  const file = join(srcDir, rel);
  if (!existsSync(file)) throw new Error(`missing source: lib/client-src/${rel}`);
  const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (!raw.startsWith("/**")) {
    throw new Error(`lib/client-src/${rel} 必须以块注释开头（说明这个文件为什么存在）`);
  }
  const at = raw.indexOf("*/");
  if (at < 0) throw new Error(`lib/client-src/${rel} 的块注释没有闭合`);
  // 块注释与正文之间的空行只是排版分隔，不属于正文 —— 正文逐字节内联。
  //
  // 正文**尾部**：每个源文件恰好以一个换行收尾（编辑器/git 的要求），那个换行
  // 不是正文的一部分 —— 剥掉**一个**。区域内部的空行（含末尾的空行，那是模块之间
  // 的排版胶水）全部原样保留，剥多了会把模块间距压没。
  const body = raw.slice(at + 2).replace(/^\n+/, "").replace(/\n$/, "");
  if (!body.trim()) throw new Error(`lib/client-src/${rel} 的正文是空的`);
  return body;
}

const SLOT_RE = /^\t\t\/\* __DSHP_SLOT:([a-z0-9-]+)__ \*\/$/;
/** 只出现在文件头注释里的示意写法，不算占位符。 */
const SLOT_HINT_RE = /__DSHP_SLOT:<name>__/;

// ── 1) 装配占位符 ───────────────────────────────────────────────────────────
const shellText = readFileSync(shellPath, "utf8").replace(/\r\n/g, "\n");
// 文件头块注释要跳过：里面解释占位符格式时写的就是 `/* __DSHP_SLOT:<name>__ */`，
// 那不是占位符。正文从块注释闭合的 `*/` 之后开始。
const headerEnd = shellText.indexOf("*/");
if (!shellText.startsWith("/**") || headerEnd < 0) {
  throw new Error("lib/client-src/shell.js 必须以块注释开头（说明这个文件为什么存在）");
}
const shellLines = shellText.slice(headerEnd + 2).replace(/^\n+/, "").split("\n");
const used = new Set();
const assembled = [];
for (const line of shellLines) {
  const m = SLOT_RE.exec(line);
  if (!m) {
    // 正文里写了个像占位符但格式不对的行时，它会作为普通注释静默留在产物里 —— 直接拒绝。
    if (line.includes("__DSHP_SLOT:") && !SLOT_HINT_RE.test(line)) {
      throw new Error(`占位符格式不对（必须是整行 \`\\t\\t/* __DSHP_SLOT:<name>__ */\`）：${line}`);
    }
    assembled.push(line);
    continue;
  }
  const slot = m[1];
  if (used.has(slot)) throw new Error(`占位符重复：${slot}（会被装配两次）`);
  used.add(slot);
  assembled.push(bodyOf(slot));
}
let outText = assembled.join("\n");

const missing = Object.keys(SLOT_FILES).filter((n) => !used.has(n));
if (missing.length) {
  throw new Error(
    `shell.js 里缺这些占位符：${missing.join(", ")} —— 对应源文件会变成没人引用的死文件`,
  );
}

// ── 2) 嵌入演练台片段（lib/redteam/client.js → drill marker 之间）─────────────
let raw = readFileSync(drillSrc, "utf8").replace(/\r\n/g, "\n");
const startMark = "factory: (require) => {";
const start = raw.indexOf(startMark);
if (start < 0) throw new Error("cannot find ModuleLoader factory in drill client");
const endMark = "\n    return module.exports\n  },\n})";
const end = raw.lastIndexOf(endMark);
if (end < 0) throw new Error("cannot find factory end in drill client");
let body = raw.slice(start + startMark.length, end);

// 去掉末尾 exports（return 已在 endMark 外）
body = body
	.replace(/\n\s*exports\.apply\s*=\s*apply\s*\n/, "\n")
	.replace(/\n\s*exports\.inject\s*=\s*inject\s*\n/, "\n");

// 替换 apply(ctx)：不再自己注册座位，只导出 Panel / CSS / 状态
const applyAt = body.lastIndexOf("function apply(ctx) {");
if (applyAt < 0) throw new Error("apply(ctx) not found in drill client");
// apply() 本体没有嵌套函数花括号冲突到 CSS（CSS 在前面），用括号深度即可
let d = 0;
let j = body.indexOf("{", applyAt);
for (; j < body.length; j += 1) {
	const ch = body[j];
	if (ch === "{") d += 1;
	else if (ch === "}") {
		d -= 1;
		if (d === 0) {
			j += 1;
			break;
		}
	}
}
const applyParts = `function applyDrillParts() {
      return { CSS: CSS, Panel: Panel, setUI: setUI, useUI: useUI, isFullWindow: isFullWindow, setDockWidth: setDockWidth };
    }
`;
body = body.slice(0, applyAt) + applyParts + body.slice(j);

const fragment = `${BEGIN}
		// 内嵌演练台（源码在 lib/redteam，已并进本插件）
		const __dshPurgeDrill = (() => {
			var module = { exports: {} };
			var exports = module.exports;
${body}
			return applyDrillParts();
		})();
${END}`;

if (!outText.includes(BEGIN) || !outText.includes(END)) {
  throw new Error("shell.js missing drill markers");
}
const beginAt = outText.indexOf(BEGIN);
const endAt = outText.indexOf(END);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) throw new Error("drill markers out of order");
outText = outText.slice(0, beginAt) + fragment + outText.slice(endAt + END.length);

// ── 3) 写产物 ────────────────────────────────────────────────────────────────
writeFileSync(clientPath, outText);
console.log(
  `assembled client.js: ${used.size} client-src modules + drill fragment `
  + `(${Buffer.byteLength(fragment)} bytes fragment, ${Buffer.byteLength(outText)} bytes total)`,
);
