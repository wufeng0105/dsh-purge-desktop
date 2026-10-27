/**
 * scripts/check-style-tokens.mjs — 界面样式 token 纯度的判定器。
 *
 * 为什么存在：宿主样式规范要求界面颜色一律取 --dsw-alias-* 语义 token、明暗切换归
 * 主题属主，组件样式里既不许写字面色也不许出现主题选择器。这两条约定在样式收敛
 * 改造后靠肉眼评审拦不住回流——直填色写起来永远比挑语义 token 省事。这里把约定
 * 变成逐行扫描的硬门禁，判据两条：
 *   一、剥掉全部 var(...) 兜底层之后，行内不许残留 #hex / rgb( / hsl( 直填
 *       （var(--dsw-alias-*, #hex) 形态的兜底是合规的，不算命中）；
 *   二、不许出现主题选择器（data-ds-dark-theme、[data-theme、.dark、prefers-color-scheme）。
 * 扫描范围是界面样式的全部源头：lib/client-src/** 与 lib/redteam/client.js；
 * client.js 是生成物不扫（源头干净它就干净，codegen drift 另有门禁）。
 * 退出码：0 全过 / 1 有命中 / 2 环境错误（扫描目标缺失）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_TARGETS = ["lib/client-src", "lib/redteam/client.js"];
const SOURCE_EXT = /\.(js|mjs|css)$/;

/* var(...) 兜底整体剥掉；嵌套 var 反复剥到不动点，外层残留才拿去判直填 */
const VAR_CALL = /var\([^()]*(?:\([^()]*\)[^()]*)*\)/g;
const BARE_HEX = /#[0-9a-fA-F]{3,8}\b/;
const BARE_FUNC_COLOR = /\b(?:rgb|hsl)a?\(/;
const THEME_PROBES = [
  ["data-ds-dark-theme", /data-ds-dark-theme/],
  ["[data-theme", /\[data-theme/],
  [".dark", /\.dark(?![a-zA-Z0-9_-])/],
  ["prefers-color-scheme", /prefers-color-scheme/],
];

/** 收集目录下全部源码文件；目标是文件就直接返回它。 */
function collectSourceFiles(target) {
  const abs = join(root, target);
  if (!existsSync(abs)) return null;
  const stat = statSync(abs);
  if (stat.isFile()) return SOURCE_EXT.test(abs) ? [abs] : [];
  const out = [];
  for (const name of readdirSync(abs)) {
    const child = join(abs, name);
    if (statSync(child).isDirectory()) {
      out.push(...collectSourceFiles(relative(root, child)));
      continue;
    }
    if (SOURCE_EXT.test(child)) out.push(child);
  }
  return out;
}

/** 行内剥净 var(...) 后的残留文本（兜底里的颜色合法，不算直填）。 */
function stripVarFallbacks(line) {
  let stripped = line;
  let previous = null;
  while (previous !== stripped) {
    previous = stripped;
    stripped = stripped.replace(VAR_CALL, "");
  }
  return stripped;
}

const missing = SCAN_TARGETS.filter((t) => collectSourceFiles(t) === null);
if (missing.length > 0) {
  console.error(`[check-style-tokens] 扫描目标缺失：${missing.join("、")}（工作目录不对或目录被挪）`);
  process.exit(2);
}

const hits = [];
let fileCount = 0;
for (const target of SCAN_TARGETS) {
  for (const abs of collectSourceFiles(target)) {
    fileCount += 1;
    const rel = relative(root, abs).split("\\").join("/");
    const lines = readFileSync(abs, "utf8").split("\n");
    lines.forEach((line, index) => {
      const where = `${rel}:${index + 1}`;
      const stripped = stripVarFallbacks(line);
      const hex = stripped.match(BARE_HEX);
      if (hex) hits.push(`${where}  非 var 兜底位置的直填色 ${hex[0]}`);
      const func = stripped.match(BARE_FUNC_COLOR);
      if (func) hits.push(`${where}  非 var 兜底位置的直填色 ${func[0]}`);
      for (const [label, probe] of THEME_PROBES) {
        if (probe.test(line)) hits.push(`${where}  组件样式里出现主题选择器 ${label}`);
      }
    });
  }
}

console.log(`[check-style-tokens] 扫描 ${fileCount} 个文件（lib/client-src/** 与 lib/redteam/client.js）`);
if (hits.length === 0) {
  console.log("[check-style-tokens] OK：直填色与主题选择器零命中");
  process.exit(0);
}
for (const hit of hits) console.error(`[check-style-tokens] ${hit}`);
console.error(`[check-style-tokens] 命中 ${hits.length} 处：颜色改走 --dsw-alias-* 语义 token（原值可留作 var 兜底），明暗差异交给主题 token 自动切换`);
process.exit(1);
