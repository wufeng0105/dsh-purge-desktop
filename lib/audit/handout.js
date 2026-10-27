/**
 * lib/audit/handout.js — 把读法与失败卡放到日志现场，让没有源码的人也能读完。
 *
 * 为什么要有这一份：读法原先只躺在仓库的 `docs/readme-for-ai.md` 里，而真正的现场
 * （`<DSH_HOME>/dsh-purge/audit/`）只有日志，没有说明书 —— 做出来的东西用户拿不到。
 * 失败卡同理：`lib/audit/remedy.js` 的十二张卡是内存里按现场挑的，不落盘、事后回看不了。
 *
 * 两条纪律：
 *   一、**读法只有一份内容**。这里做的是把仓库里那份拷到现场，不另写一份摘要；
 *      两处内容分叉比没有读法更糟，因为读者无法判断自己看的是哪一版。
 *   二、**投递失败不阻断 apply**。写不进去是「现场缺了一份说明书」，
 *      不是「这一轮没打成」；失败原因会出现在 `audit.recorded` 的 `readme` 字段上。
 */
import fs from "node:fs";
import path from "node:path";

import { matchRemedies, renderRemedies } from "./remedy.js";

/** 仓库里那一份读法；装成插件后它在 `<插件根>/docs/`，与这里只差两层。 */
const README_SOURCE = new URL("../../docs/readme-for-ai.md", import.meta.url);

/** 卡片目录名。与 `.jsonl` 分开放，`--dir` 那套判据不会把它当日志读。 */
const CARDS_DIR = "cards";

/** 现场那份读法的文件名：写侧与对账侧都从这一个常量取，别各写一份字面量。 */
export const README_NAME = "README-for-ai.md";

/** 本地时刻的紧凑戳（YYYYMMDDTHHMMSS），只为文件名排序，不带偏移。 */
function stampOf(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 把读法拷到审计目录。
 *
 * 已经有**同样内容**时不重写：`apply` 一天可能跑好几次，每次重写一遍会让文件的
 * mtime 一直是新的，看起来像「读法刚变过」。
 *
 * @param {string} auditDir 审计目录（`resolveAuditDir` 的产物）
 * @returns {{status:"installed"|"kept"|"failed", path:string, error?:string}}
 */
export function deliverReadme(auditDir) {
  const target = path.join(auditDir, README_NAME);
  let source;
  try {
    source = fs.readFileSync(README_SOURCE);
  } catch (error) {
    // 源码树之外的打包形态可能没带 docs/：那是「没东西可投递」，不是「投递失败」。
    return { status: "failed", path: target, error: `读不到读法源文件（${error.message}）` };
  }
  try {
    const existing = fs.readFileSync(target);
    if (existing.equals(source)) return { status: "kept", path: target };
  } catch {
    // 现场还没有这一份，或者读不动它 —— 往下走，写一次。
  }
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(target, source);
    return { status: "installed", path: target };
  } catch (error) {
    return { status: "failed", path: target, error: error.message };
  }
}

/**
 * 这一轮落过哪几张卡。
 *
 * 卡的文件名是 `<戳>-<runId>.md`，戳只影响排序，所以按「后缀是不是 -<runId>.md」认 ——
 * 从文件名反解时间戳会让读侧依赖写侧的戳格式，那是把两件事绑在一起。
 *
 * 写侧（`writeRunCard`）是唯一的落盘方，读侧只有这一个入口：两处各自拼目录名，
 * 「卡到底落在哪」就会变成两份口头约定。
 *
 * @param {string} auditDir 审计目录（`resolveAuditDir` 的产物）
 * @param {string} runId 这一轮的身份
 * @returns {string[]} 卡的绝对路径，按文件名升序（戳在名字里，升序即时间序）
 */
export function listRunCards(auditDir, runId) {
  const want = String(runId || "").trim();
  if (typeof auditDir !== "string" || auditDir === "" || want === "") return [];
  const dir = path.join(auditDir, CARDS_DIR);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(`-${want}.md`))
    .sort()
    .map((name) => path.join(dir, name));
}

/** 「这一轮有什么值得回看的」：任何一层不是 ok，或者有写不出证据的补丁号。 */
function needsCard({ layers, unresolved }) {
  if (Array.isArray(unresolved) && unresolved.length > 0) return true;
  for (const value of Object.values(layers || {})) {
    const result = value && value.result;
    if (result === "fail" || result === "partial") return true;
  }
  return false;
}

/** 一层一行的计数摘要：读的人不必再打开 jsonl 数。 */
function layerLine(layers) {
  const parts = [];
  for (const [layer, value] of Object.entries(layers || {})) {
    const tally = value && typeof value === "object" ? value : {};
    parts.push(`${layer}=${String(tally.result || "?")}(+${tally.applied || 0}/-${tally.failed || 0}/~${tally.skipped || 0})`);
  }
  return parts.join(" ");
}

/**
 * 给这一轮写一张卡。
 *
 * 卡是**落账那一刻**写的，不是事后渲染：事后渲染依赖「那时的现场还在」，
 * 而诊断轨只留一代，等读者想起要看，能判断的资料已经滚掉了。
 *
 * @param {object} input
 * @param {string} input.auditDir 审计目录
 * @param {string} input.runId 这一轮的身份
 * @param {string} [input.entry] 哪个入口触发的
 * @param {string} [input.actor] 谁写的这一行
 * @param {object} [input.layers] 每层的 `{applied, failed, skipped, result}`
 * @param {Array<number>} [input.unresolved] 写不出证据的补丁号
 * @param {Date} [input.now] 仅测试用
 * @returns {{path:string, cards:number}|null} 不需要写卡或写失败时返回 null
 */
export function writeRunCard({ auditDir, runId, entry, actor, layers, unresolved, now } = {}) {
  if (typeof auditDir !== "string" || auditDir === "") return null;
  if (!needsCard({ layers, unresolved })) return null;
  const at = now instanceof Date ? now : new Date();
  const dir = path.join(auditDir, CARDS_DIR);
  const file = path.join(dir, `${stampOf(at)}-${String(runId || "unknown")}.md`);
  // 卡里那一段「下一步」直接复用症候卡：同一个症候在两处给出不同命令，读者只能二选一。
  const cards = matchRemedies({
    run: { closed: true, lastEvent: "" },
    auditRows: Object.entries(layers || {}).map(([layer, value]) => ({
      layer,
      result: String(value && value.result ? value.result : ""),
      detail: {
        completeness: null,
        status: "",
        patchId: null,
      },
    })),
    diagRows: [],
  });
  const lines = [
    `run: ${String(runId || "")}`,
    `entry: ${String(entry || "（未声明）")}  actor: ${String(actor || "（未声明）")}`,
    `layers: ${layerLine(layers)}`,
    `unresolved: ${(Array.isArray(unresolved) ? unresolved : []).join(",") || "（无）"}`,
    `card: ${file}`,
    "",
    ...renderRemedies(cards),
    "",
  ];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, lines.join("\n"), "utf8");
    return { path: file, cards: cards.length };
  } catch {
    return null;
  }
}
