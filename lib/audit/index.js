/**
 * lib/audit/index.js — 审计日志的唯一对外出口，调用方只从这里取能力。
 * 审计日志的对外入口：证据构造 + 存储 + 落账 + 查询。
 *
 * 调用方只关心三件事 ——「我怎么描述一条证据」「我怎么把它写下去」「我怎么把它查回来」，
 * 它们分别落在 events / store / report，但对外是一个模块：从这里出去的导出面就是审计
 * 日志的全部能力，别处不该再按文件去取。入口侧（lib/index.js、bin）只 import 本文件。
 *
 * 四个 apply 入口的落账段也在这里（`recordApplyRun` / `collectApplyBefore`）：折落点、
 * 采 before、按入口的 runId 写盘这三步必须一起做对，分给调用方各自拼就会有人漏一步。
 * 本模块不读宿主状态（依赖规则同样禁止 audit 回引 core），落点表由调用方给。
 */
import { diagError, diagLog, currentApplyRun } from "../diag-log.js";
import { appendEvent, localIso, prune, readEvents, resolveAuditDir, tail, why, MAX_FILE_BYTES } from "./store.js";
import { fileEvidence, makeEvent, refEvidence, validateEvent } from "./events.js";
import { deliverReadme, writeRunCard } from "./handout.js";
import { summarizeLayers } from "./layers.js";
import { auditCounts, auditRowsFromReport, fileDigest, recordApply } from "./report.js";
import { noteStartupReady } from "./startup.js";
import { runAuditCli } from "./check.js";
import { runAuditQuery } from "./query.js";
import { REMEDY_CARDS, matchRemedies, remedyCard, renderRemedies } from "./remedy.js";

export {
  appendEvent,
  localIso,
  prune,
  readEvents,
  resolveAuditDir,
  tail,
  why,
  MAX_FILE_BYTES,
};

export {
  fileEvidence,
  makeEvent,
  refEvidence,
  validateEvent,
};

export { summarizeLayers };

export { auditCounts, auditRowsFromReport, fileDigest, recordApply };

// 启动就绪事件：它不是 apply，但同样只写审计轨的诊断面，入口不该绕过本模块去取。
export { noteStartupReady };

// 完整性判定只对外给一个命令行入口：判什么、怎么判全留在 ./check.js，
// 这里不把内部函数摊出去 —— 摊出去的下场是又多一个「按文件取能力」的接缝。
export { runAuditCli };

// 查询面（tail / why / remedy 的 CLI）也只从这里出：它读同一份存储，与 check 共用退出码口径。
export { runAuditQuery };

// 症候卡：`audit why` 末尾那一段「下一步」的数据源。给调用方的是「按现场挑卡」
// 与「渲染成行」两件事，卡片表本身只读不改 —— 改文案进 remedy.js，别在调用处拼。
export { REMEDY_CARDS, matchRemedies, remedyCard, renderRemedies };

/**
 * 把 `core.targetFiles(aiBase)` 的形状折成 `auditRowsFromReport` 要的解析器。
 *
 * targetFiles 的返回值有三种形态：字符串（首个命中）、数组（mode:all）、以及数组里
 * 套数组；两种空形态（空串、undefined）都不是落点。这些形状只在这里解释一次。
 *
 * @param {Record<string, string|string[]>} [targets]
 * @returns {(patch:object) => string[]}
 */
export function applyTargetResolver(targets) {
  const table = targets && typeof targets === "object" ? targets : {};
  return (patch) => {
    const keys = Array.isArray(patch?.file) ? patch.file : [patch?.file];
    const out = [];
    for (const key of keys) {
      if (key === undefined || key === null) continue;
      const hit = table[key];
      if (Array.isArray(hit)) out.push(...hit.flat(2));
      else if (typeof hit === "string" && hit !== "") out.push(hit);
    }
    return out.filter((file) => typeof file === "string" && file !== "");
  };
}

/**
 * 动手之前采 before 摘要。
 *
 * 必须在引擎写盘之前调用：apply 一旦写过，「改之前」就再也读不回来，而审计的
 * `detail.completeness.files` 正是按这张表判的。审计不适用的补丁不采（它们不落账）。
 * 单个文件读不到时值是 null —— 那是留了痕的缺口，不是错误。
 *
 * @param {Array<object>} patches 补丁表
 * @param {Record<string, string|string[]>} [targets] 与落账同一张落点表
 * @returns {Record<string, {sha256:string, bytes:number}|null>}
 */
export function collectApplyBefore(patches, targets) {
  const resolve = applyTargetResolver(targets);
  const files = new Set();
  for (const patch of Array.isArray(patches) ? patches : []) {
    if (patch?.auditExempt === true) continue;
    for (const file of resolve(patch)) files.add(file);
  }
  const before = {};
  for (const file of files) before[file] = fileDigest(file);
  return before;
}

/**
 * 一次 apply 的审计落账。
 *
 * 写盘失败不吞：先把失败记成诊断轨的 `apply.audit.fail`（带入口 runId），再原样抛给
 * 调用方 —— 审计写不进去是「这一轮没有证据」，不许只留一句 console.warn。
 * 成功侧补一条 `audit.recorded`：失败有记录、成功没有的话，「审计写成功了」这件事
 * 就永远只能靠「没看到 fail」反推 —— 那是缺席证明，不是证据。
 *
 * 报告为空时返回 null：引擎没跑到逐补丁判定的轮次没有「落在哪个文件」可言，
 * 写一条空壳审计会让层结论与诊断轨凭空对不上。
 *
 * @param {object} input
 * @param {string} input.dshHome 审计落点
 * @param {Array<object>} input.report 引擎的 apply 报告
 * @param {Array<object>} input.patches 补丁表
 * @param {Record<string, string|string[]>} [input.targets] 落点表
 * @param {Record<string, object|null>} [input.before] 动手前的摘要表
 * @param {string} [input.runId] 入口已经开出的身份，与诊断轨同一个值
 * @param {string} [input.entry] 哪个入口触发的（`cli` / `http` / `command` / `tool`）；
 *   缺省取当前身份环境里的 entry。写进每一行审计行，供事后只读审计轨时判来源。
 * @returns {{rows:Array<object>, counts:object, record:object}|null}
 */
export function recordApplyRun({ dshHome, report, patches, targets, before, runId, entry } = {}) {
  const list = Array.isArray(report) ? report : [];
  if (list.length === 0) return null;
  const ambient = currentApplyRun();
  const wantEntry = typeof entry === "string" && entry.trim() !== ""
    ? entry.trim()
    : String(ambient?.entry ?? "").trim();
  const wantRunId = typeof runId === "string" && runId.trim() !== ""
    ? runId.trim()
    : String(ambient?.runId ?? "").trim();
  try {
    const rows = auditRowsFromReport(list, patches, applyTargetResolver(targets));
    const counts = auditCounts(rows, patches);
    const record = recordApply({
      dshHome,
      rows,
      before,
      patches,
      runId: wantRunId,
      entry: wantEntry,
    });
    const auditDir = resolveAuditDir(dshHome);
    // 读法与失败卡都在这一段落盘：现场只有日志、没有说明书的话，
    // 「做出来的东西用户拿不到」。两件事互不依赖，任何一件失败都不影响另一件。
    const readme = deliverReadme(auditDir);
    const card = writeRunCard({
      auditDir,
      runId: record.runId,
      entry: record.entry,
      actor: record.actor,
      layers: record.layers,
      unresolved: record.unresolved,
    });
    // 成功侧的正向证据：哪一轮、落了几行、三层结论各是什么、还有没有缺口，
    // 以及读法与失败卡有没有投递到现场。缺了这一行，「审计这一层跑完了」
    // 只能靠「没看到 apply.audit.fail」反推 —— 那是缺席证明，不是证据。
    diagLog("audit.recorded", {
      runId: record.runId,
      entry: wantEntry,
      actor: record.actor,
      // 这一轮的最后一条 diag 事件就是它：盖章之后本轮的记录到此为止，后面不会再有
      // 带这个 runId 的行（`cli.apply.done` 不带 runId，不属于本轮）。读侧按「有没有
      // runEnd」判收尾，不按「最后一条是不是 apply.end」判 —— 那一条会随事件数量失效。
      runEnd: "audit",
      events: record.events,
      skipped: record.skipped,
      unresolved: record.unresolved.join(","),
      layers: Object.keys(record.layers).map((layer) => `${layer}:${record.layers[layer].result}`).join(","),
      readme: readme.status,
      ...(readme.status === "failed" ? { readmeError: String(readme.error || "") } : {}),
      cards: card ? card.cards : 0,
      cardPath: card ? card.path : "",
    }, dshHome);
    return { rows, counts, record };
  } catch (error) {
    diagError("apply.audit.fail", error, { runId: String(wantRunId || "") }, dshHome);
    throw error;
  }
}
