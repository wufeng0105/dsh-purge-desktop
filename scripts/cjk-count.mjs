/**
 * scripts/cjk-count.mjs — 硬编码中文的计数口径，只有一个实现。
 *
 * 为什么单独成文件：界面文案硬编码的度量（`scripts/measure.mjs` 的 measureCjk）与
 * 它的棘轮门禁（`test/rules-ratchet.test.mjs` 的模板串中文棘轮）必须看同一份口径 ——
 * 文件清单、正则、排除规则任何一处漂移，都会让「度量说没事、门禁说有事」或反过来。
 * 两边都从这里 import，改口径只改这一处。
 *
 * 口径（从 measure.mjs 原样搬来，未改一字）：
 *   命中 = 该行存在一个引号字面量（'…' / "…" / `…`），其内部含 CJK 统一表意文字。
 *   含模板字面量（反引号）与其中 ${} 插值里的字面量；不含跨行模板字面量的正文
 *   —— 跨行正文属样式段，由 measureCss 统计。
 *   排除 = 以双斜线、单星号、斜线星号开头的行；块注释区间内的行（简化状态机）。
 *   排除 = lib/client-src/i18n.js 本身（那是词典，不是待清零的硬编码）。
 *   排除 = 正则字面量里的 CJK：/不是红队/g 这类会让引号配对跨过正则边界，
 *          把两个不相邻的引号当成一对，数出并不存在的字符串。
 *   计数单位 = 行（hits）与字面量出现次数（matchTotal）两个都记，同一行多个只算 1 行。
 *
 * 本模块只读仓库文件，无副作用，可被脚本与测试同时引用。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 界面片段清单：度量与棘轮共用的文件集基础。
 * 它是口径的一部分——「哪些文件算界面文案载体」两处必须一致，所以清单也住在这里。
 */
export const CLIENT_SRC = [
  "i18n.js", "shell.js", "welcome-helpers.js", "welcome-notice.js",
  "dock/auth-gate.js", "dock/auth.js", "dock/env-gate.js", "dock/purge-css.js",
  "main/drill-panel.js",
  "rewind/install.js", "rewind/rewind-ui.js",
  "settings/host.js", "settings/p1-section.js", "settings/rows.js", "settings/ui.js", "settings/page.js", "settings/patches-tab.js", "settings/skills-tab.js",
];

/** 演练台片段：与 client-src 同一发稿单元，只扫一半等于没扫。 */
const DRILL_FRAGMENT = "lib/redteam/client.js";

/**
 * 棘轮与度量共同扫描的文件集（相对仓库根）。
 * i18n.js 是词典，它的中文是数据不是硬编码，不进这个集合。
 */
export function cjkTargets() {
  return [
    ...CLIENT_SRC.filter((f) => f !== "i18n.js").map((f) => `lib/client-src/${f}`),
    DRILL_FRAGMENT,
  ];
}

/** 正则字面量里的 CJK 先剥掉再数引号：不剥会把正则边界两侧的引号配成对，数出幽灵字符串。 */
const CJK_REGEX_LITERAL =
  /(?<=[(,=:!&|?{;[\s])\/(?:\\.|\[[^\]]*\]|[^\/\n\\'"`])*[\u4e00-\u9fff](?:\\.|\[[^\]]*\]|[^\/\n\\'"`])*\/[gimsuy]*/g;

/**
 * 数一个文件里的「引号字面量含 CJK」。
 * 块注释区间按简化状态机跳过：进入块注释后不计数，直到出现块注释收尾。
 *
 * @param {string} rel 相对仓库根的路径
 * @returns {{path:string, hits:number, matchTotal:number, lineNos:number[]}}
 */
export function countCjk(rel) {
  const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
  let inBlock = false;
  let hits = 0;
  let matchTotal = 0;
  const lineNos = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      return;
    }
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
      inBlock = true;
      return;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    const scanned = trimmed.replace(CJK_REGEX_LITERAL, "");
    const re = /(['"`])(?:\\.|(?!\1).)*[\u4e00-\u9fff](?:\\.|(?!\1).)*\1/g;
    const found = scanned.match(re) ?? [];
    if (found.length) {
      hits += 1;
      matchTotal += found.length;
      lineNos.push(i + 1);
    }
  });
  return { path: rel, hits, matchTotal, lineNos };
}
