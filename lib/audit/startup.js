/**
 * lib/audit/startup.js — 启动就绪事件：宿主这次启动读到了什么。
 *
 * 为什么需要它：apply 那一侧能证明「我把字节写到磁盘上了」，却证明不了「宿主下次启动
 * 真的读到了这些字节」。缺了这一条，用户问「我改了补丁、重启过，到底生效没有」时，
 * 日志里唯一能拿来反推的东西是「有没有出现某条失败事件」—— 那是否席证明，日志被截断
 * 时与沉默长得一模一样。
 *
 * 所以每次宿主启动无条件记一条：补丁对齐没对齐、对齐戳是哪一份、插件版本是多少。
 * 三条推论因此变成可判的：
 *   一、`apply.end` 的 `pendingRestart` 为真，之后有一次 `startup.ready` 且
 *      `patchesMatch` 为真 —— 改动被读进来了，这一轮生效；
 *   二、`pendingRestart` 为真，之后再没有 `startup.ready` —— 宿主没重启过，
 *      磁盘上的新字节运行中的进程一个都没读到；
 *   三、`patchesMatch` 为假 —— 启动是启动了，但补丁没对齐（宿主升级、戳丢了、
 *      被密封包盖回去），「加载了新版」与「加载了对齐的补丁」是两件事。
 *
 * 两处刻意的边界：
 *  - 它不是 apply，所以**不塞 `entry` 也不塞 `runId`**。硬塞会让「按 runId 捞一次
 *    apply」捞出一条与那轮无关的记录；读的人靠事件名就能分清启动与 apply。
 *  - 一个进程只记一条。插件在同一进程里被宿主重载不算启动；重载也记的话，
 *    「重启了吗」这个问题的答案会被重载刷出假的启动记录。
 *
 * 补丁是否对齐由**补丁引擎**判（判据在 lib/reapply.js），本模块不重算：它的职责是
 * 把结论与戳写成一行可 grep 的事实，而不是再算一遍判定。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { diagLog } from "../diag-log.js";
import { findDshHome } from "../host/paths.js";

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 插件版本：与补丁引擎读的是同一份 package.json，别在别处再抄一次版本号。 */
function pluginVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8")).version || "");
  } catch {
    return "";
  }
}

/** 对齐戳的落点：写侧在 lib/reapply.js，读侧只此一处，两边同一个文件。 */
function appliedStampPath(dshHome) {
  const home = String(dshHome || "").trim() || findDshHome();
  return path.join(home, "dsh-purge", "applied.json");
}

/**
 * 读对齐戳原文。
 *
 * 真实结构是 `{version, sha, at}`：version 是写戳那一刻的插件版本，sha 是补丁指纹，
 * at 是写入时刻。三样都不许省 —— 少了 at 就分不清这个戳是这次启动写的、还是上一次
 * 留下的；少了 sha 就分不清「对齐」是靠版本号凑上的还是指纹真的一致。
 *
 * 读不到返回 null：null 在日志里读作「没有戳」，与「戳对得上」是两件事。
 */
export function readAppliedStampForLog(dshHome) {
  try {
    const raw = JSON.parse(fs.readFileSync(appliedStampPath(dshHome), "utf8"));
    return {
      version: String(raw?.version || ""),
      sha: String(raw?.sha || ""),
      at: String(raw?.at || ""),
      // 落账那一刻的 apply 身份。有它，「这次启动对应哪一次 apply」才是读得出来的事实，
      // 而不是靠「把戳的 at 与 diag 里的时间对齐」推出来 —— 那是推断，不是记录。
      runId: String(raw?.run_id || ""),
      // 写这份戳时宿主是哪一版。官方升级换掉整棵树之后，这个字段是「宿主变了」的
      // **唯一记录来源**：现场只能读到新版本，旧版本只存在于戳里。
      hostVersion: String(raw?.hostVersion || ""),
    };
  } catch {
    return null;
  }
}

/** 戳折成一行：`<version>@<sha>@<at>`；没有戳给空串（空串 = 没有，不是对齐）。 */
export function formatAppliedStamp(stamp) {
  if (!stamp) return "";
  return [stamp.version, stamp.sha, stamp.at]
    .map((part) => String(part || "").trim())
    .filter((part) => part !== "")
    .join("@");
}

/**
 * 这一行诊断事件的字段。值一律由调用方给或从文件读，不在这里二次判断。
 *
 * 两个「一个布尔说不清」的地方在这层展开成明细：
 *  - `patchesMatch` 只说「对齐没对齐」，`pending` / `pendingCount` / `alignmentReason`
 *    说清**哪几条**没对齐、以及是「戳没对上」还是「戳对上了但补丁没打上」；
 *  - `appliedStamp` 只说「有个戳」，`appliedRunId` 说清**这次启动读的是哪一次 apply**。
 *
 * 取不到明细时给空串（空串 = 没读到），**不是**空数组 —— 空数组会被读成「一条不缺」。
 *
 * @param {{version:string, patchesMatch:boolean, appliedStamp:object|null,
 *   alignment?:{ok:boolean, reason:string, pending:string[]}|null, appliedRunId?:string}} input
 */
export function startupReadyFields({ version, patchesMatch, appliedStamp, alignment, appliedRunId } = {}) {
  const detail = alignment && typeof alignment === "object" && Array.isArray(alignment.pending)
    ? alignment
    : null;
  const stamp = appliedStamp && typeof appliedStamp === "object" ? appliedStamp : null;
  const runId = appliedRunId === undefined ? (stamp ? String(stamp.runId || "") : "") : String(appliedRunId || "");
  // 展示口径的待清洗：与补丁号口径是同一个事实的两种分母，两个都写出来，
  // 「UI 说 2 条、启动说 3 条」才有据可查（见 lib/patch/counts.js）。
  const displayPending = detail && Array.isArray(detail.displayPending)
    ? detail.displayPending.map(String)
    : [];
  return {
    version: String(version || ""),
    patchesMatch: patchesMatch === true,
    appliedStamp: formatAppliedStamp(appliedStamp),
    // 逐补丁明细：诊断轨的值一律字符串化，所以用逗号串（与 track 里其他列表同形）。
    pending: detail === null ? "" : detail.pending.join(","),
    pendingCount: detail === null ? "" : String(detail.pending.length),
    pendingDisplay: detail === null ? "" : displayPending.join(","),
    pendingDisplayCount: detail === null ? "" : String(displayPending.length),
    alignmentReason: detail === null ? "" : String(detail.reason || ""),
    // 戳里的 apply 身份；空串 = 戳里没这一项（老戳），不是「对不上」。
    appliedRunId: runId,
    // 归因用的两个宿主版本：`hostVersion` 是现场，`stampHostVersion` 是写戳那一刻。
    // 两者不同就是在读侧成立的「宿主被官方换过」，不需要拿时间戳去猜。
    hostVersion: detail && detail.hostVersionTo ? String(detail.hostVersionTo) : "",
    stampHostVersion: detail && detail.hostVersionFrom
      ? String(detail.hostVersionFrom)
      : String(stamp?.hostVersion || ""),
  };
}

/** 一个进程只记一条：值一旦置真不再回退，测试里也别指望它能被重置。 */
let announced = false;

/**
 * 记一条启动就绪事件。永远不抛错（诊断轨的第一条约束：日志失败不许影响宿主启动）。
 *
 * @param {{patchesMatch?:boolean, version?:string, dshHome?:string,
 *   appliedStamp?:object|null}} [input] 版本与戳都可以显式给，缺省读真实文件
 * @returns {{logged:boolean, path:string}}
 */
export function noteStartupReady({ patchesMatch, version, dshHome, appliedStamp, alignment } = {}) {
  if (announced) return { logged: false, path: "" };
  announced = true;
  const home = String(dshHome || "").trim() || findDshHome();
  const fields = startupReadyFields({
    version: version === undefined ? pluginVersion() : version,
    patchesMatch,
    appliedStamp: appliedStamp === undefined ? readAppliedStampForLog(home) : appliedStamp,
    alignment,
  });
  const written = diagLog("startup.ready", fields, home);
  return { logged: written !== "", path: written };
}
