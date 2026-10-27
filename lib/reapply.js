/**
 * lib/reapply.js — 这一轮 apply 怎么跑。
 *
 * 版本账本（applied.json 的读/写、戳判据、装机指纹种子、重启冷却）已搬进 `lib/stamp.js`：
 * 它只碰 `$DSH_HOME`，与「往宿主文件里写字节」不是同一条变化线。这里保留两件事：
 *   一、对齐判据：逐补丁实检 + 戳归因（`patchAlignment` / `reconcileAlignment`）；
 *   二、应用流程：先还原再按当前表重打（`reapplyInstalled`）。
 *
 * 账本的对外 API 仍从这里转出（`markPatchesApplied` 等），调用方不必改 import。
 */
import path from "node:path";

import * as core from "./core.js";
import { currentApplyRun, newApplyRunId, withApplyRun } from "./diag-log.js";
import {
  appliedStampHostDrift,
  currentHostIdentity,
  ensureInstalledRevSeed,
  healEmptyAppliedStamp,
  installedRev,
  isCleanApplyRound,
  markPatchesApplied,
  markSettleRestart,
  noteAppliedAudit,
  patchesMatchInstall,
  pluginVersion,
  readAppliedStamp,
  readAppliedStampFull,
  recordApplyRound,
  shouldSkipSettleRestart,
} from "./stamp.js";

// 账本 API 的转出：外部（bin / index / 用例）一直从这里取，搬家不改进口。
export {
  appliedStampHostDrift,
  ensureInstalledRevSeed,
  healEmptyAppliedStamp,
  isCleanApplyRound,
  markPatchesApplied,
  markSettleRestart,
  noteAppliedAudit,
  readAppliedStamp,
  recordApplyRound,
  shouldSkipSettleRestart,
};

/**
 * 逐补丁对齐的**明细**：哪几条还没打上，以及它们在展示口径下落在哪一行。
 *
 * 为什么需要它：这里原来是一个布尔函数（`hostPatchesStillPending`），把 66 条 status
 * 压成一个 true/false，于是日志里 `patchesMatch="false"` 只说得清「没对齐」、说不清
 * **哪一条没对齐** —— 而读者要的正是后者。算出逐条状态之后又把它压掉，等于把答案留在
 * 内存里、只把结论写进日志。
 *
 * 两个清单都返回，因为它们是**两个分母**下的同一个事实：`pending` 是补丁号口径
 * （66 条的基准，判据与 CLI 摘要用它），`displayPending` 是展示行口径（设置页与
 * `/purge status` 那一屏的行）。只给一个，读的人就要拿另一个数去猜「为什么 UI 说 2 条、
 * 启动说 3 条」—— 那正是这一批要消掉的分歧。
 *
 * 读不到宿主 / 读的时候抛错：`ok=false` 且 `reason` 写明是哪一种，不许静默当成「已对齐」。
 *
 * @returns {Promise<{ok:boolean, reason:string, pending:string[], displayPending:string[]}>}
 */
export async function patchAlignment() {
  try {
    const aiBase = core.findAiBase();
    if (!aiBase) return { ok: false, reason: "no-ai-base", pending: [], displayPending: [] };
    const status = await core.patchStatus(aiBase);
    const byNumber = (list) => list.sort((left, right) => Number(left) - Number(right));
    const pending = byNumber(Object.entries(status)
      .filter(([, value]) => value === "pending")
      .map(([id]) => String(id))
      // 按补丁号数值排：日志里的顺序要能跟补丁表对读，字符串排会把 100 排在 20 前面。
    );
    // 展示行的待清洗：行状态是合并结论，所以「组里有一条 pending」就整行 pending。
    const displayPending = core.groupPatchesForDisplay(core.ALL_PATCHES, status)
      .filter((row) => row && row.status === "pending")
      .map((row) => String(row.id));
    return {
      ok: pending.length === 0,
      reason: pending.length === 0 ? "" : "pending",
      pending,
      displayPending,
    };
  } catch (e) {
    return { ok: false, reason: `read-error:${String(e && e.message ? e.message : e)}`, pending: [], displayPending: [] };
  }
}

/**
 * fast path 与逐补丁实检的**一次量完**版本：启动路径只调它，避免同一件事算两遍。
 *
 * 返回 `stampOk` 是为了让日志能分清「戳没对上」与「戳对上了但有补丁没打上」——
 * 这两种在布尔版里都是 `false`，处置办法却完全不同。
 *
 * @returns {Promise<{ok:boolean, stampOk:boolean, reason:string, pending:string[]}>}
 */
/**
 * 把「戳对不对」与「补丁在不在」两份结论合成一个判定，并给出**归因**。
 *
 * 抽成纯函数是因为这条判据的两种输入（戳旧/戳对 × 实检过/不过）在真实宿主上才凑得齐，
 * 本机没有宿主、`patchAlignment()` 一律返回 `no-ai-base`，测不出四象限。纯函数让四象限
 * 在本机就能钉住，`patchesAlignmentStrict()` 只负责取数。
 *
 * 归因（`reason`）是这一版的重点：原来只有 `stamp` 一个字，读的人分不清「有人动了文件」
 * 与「官方升级整棵树换了」—— 这两种的处置完全相反（前者要查改动，后者只要重新 apply）。
 * 现在按「戳里记的宿主版本 vs 现场宿主版本」分开，并把两个版本号一起带出去。
 *
 * @param {{stampOk:boolean, alignment:{ok:boolean, reason:string, pending:string[],
 *   displayPending?:string[]}, stampHostVersion?:string, hostVersion?:string,
 *   markersPresent?:boolean|null}} input
 * @returns {{ok:boolean, stampOk:boolean, reason:string, pending:string[],
 *   displayPending:string[], hostVersionFrom:string, hostVersionTo:string, hostChanged:boolean}}
 */
export function reconcileAlignment(input = {}) {
  const stamp = input.stampOk === true;
  const alignment = input.alignment;
  const isObject = Boolean(alignment) && typeof alignment === "object";
  const checked = isObject ? alignment : { ok: false, reason: "", pending: [] };
  const pending = Array.isArray(checked.pending) ? checked.pending : [];
  const displayPending = Array.isArray(checked.displayPending) ? checked.displayPending : [];
  const hostVersionFrom = String(input.stampHostVersion || "");
  const hostVersionTo = String(input.hostVersion || "");
  // 两边都读得到且不同，才算「宿主换过」。读不到就退回原归因：不可判不许冒充结论。
  const hostChanged = hostVersionFrom !== "" && hostVersionTo !== "" && hostVersionFrom !== hostVersionTo;
  const attribution = hostChanged ? "host-updated" : "stamp";
  const markersPresent = input.markersPresent;
  const base = { stampOk: stamp, displayPending, hostVersionFrom, hostVersionTo, hostChanged };
  // 实检说没有 pending：宿主上的补丁集就是齐的，戳旧只说明「上一次 apply 是对旧版本做的」。
  // 这一档必须 `ok=true`——否则界面显示「需重载」而补丁一条不缺，同一个启动两个相反结论。
  if (checked.ok === true) {
    return { ...base, ok: true, reason: stamp ? "" : (hostChanged ? "host-updated" : "stamp-stale"), pending: [] };
  }
  const detail = String(checked.reason || "");
  // 读不到宿主 / 读的时候抛错：这是「没判」，不是「没对齐」，单独成档。
  if (detail === "no-ai-base") return { ...base, ok: false, reason: "no-ai-base", pending: [] };
  if (detail.startsWith("read-error")) return { ...base, ok: false, reason: "read-error", pending };
  // 实检不过时按归因分开：戳也不对优先记归因（要重打），否则记实检自己的原因（缺哪几条）。
  if (pending.length > 0) {
    return { ...base, ok: false, reason: stamp ? "pending" : attribution, pending };
  }
  // 一条 pending 都没有却没对齐：清洗标记不在了（宿主原文回来了）。这一档只可能是
  // 官方替换或有人手工还原 —— 与「有活没干」是两件事。
  if (markersPresent === false) {
    return { ...base, ok: false, reason: hostChanged ? "host-updated" : "markers-missing", pending };
  }
  return { ...base, ok: false, reason: stamp ? detail : attribution, pending };
}


export async function patchesAlignmentStrict(deps = {}) {
  // 戳不再是闸，只决定归因：`patchesMatchInstall()` 说的是「上一次 apply 是否针对这一版做的」，
  // 不是「宿主上的补丁还在不在」。戳旧而补丁齐是常见形态（同补丁集换了版本号，或 heal 刚补过戳），
  // 早先在这里短路成 `ok=false`，于是启动日志说「没对齐」、界面提示「需重载」，而宿主上的补丁
  // 一条不缺 —— 同一个启动给出两个相反结论。真相只有 patchAlignment() 一个来源。
  // 取数入口可注入：它们都要真实宿主，本机测不到，于是这条接线一行覆盖都没有
  // （审计实测：把它改成恒返回 `{ok:true}`，565 个用例全绿）。注入之后四象限能在本机钉住。
  const stampMatch = typeof deps.stampMatch === "function" ? deps.stampMatch : patchesMatchInstall;
  const align = typeof deps.patchAlignment === "function" ? deps.patchAlignment : patchAlignment;
  const identity = typeof deps.hostIdentity === "function" ? deps.hostIdentity() : currentHostIdentity();
  const stampHostVersion = typeof deps.stampHostVersion === "string"
    ? deps.stampHostVersion
    : String(readAppliedStampFull()?.hostVersion || "");
  return reconcileAlignment({
    stampOk: stampMatch(),
    alignment: await align(),
    stampHostVersion,
    hostVersion: identity.hostVersion,
    markersPresent: identity.markersPresent,
  });
}

/** fast path 过了也要再做一次逐补丁 pending 实检,避免 DSH 升级 marker 漂移时永不重打。 */
export async function patchesMatchInstallStrict() {
  return (await patchesAlignmentStrict()).ok;
}

/**
 * 宿主上的清洗还在，只是版本戳旧了。启动时不能因此 revertAll，
 * 否则用户点应用并重启后，页面会回到「要重新清洗」。
 */
export async function hostCleanEnoughToKeep() {
  let aiBase = "";
  try {
    aiBase = core.findAiBase() || "";
  } catch {
    return false;
  }
  if (!aiBase || !core.hostCleanMarkersPresent(aiBase)) return false;
  const status = await core.patchStatus(aiBase);
  return !Object.values(status).some((row) => row === "pending");
}

/** 有 applied 戳但宿主已回到密封 asar / 清洗标记没了：面板提示「补丁已丢失」（#57）。找不到根不算丢失。 */
export function patchesLostAfterHostReset() {
  const stamp = readAppliedStamp();
  if (!stamp?.version || !stamp?.sha) return false;
  try {
    if (core.desktopAsarStillSealed()) return true;
  } catch {
    /* 非桌面面 */
  }
  try {
    const aiBase = core.findAiBase();
    if (aiBase && !core.hostCleanMarkersPresent(aiBase)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 先把宿主文件从备份还原，再按当前这份插件的补丁重写。
 * 低版本带着自己的补丁列表，高版本带着自己的；回退到哪一版就打哪一版。
 */
export async function reapplyInstalled(options = {}) {
  core.applyRuntimeEnv();
  let aiBase = null;
  let handoff = null;
  let freshExtract = null;
  try {
    const state = await core.gatherState();
    aiBase = state.ai_base;
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  const sealed = core.sealedAsarHandoff();
  if (!aiBase || sealed) {
    try {
      const opened = await core.openSealedDesktopHost({
        upgrade: options.upgrade === true,
        forApply: true,
      });
      if (opened.aiBase) aiBase = opened.aiBase;
      if (opened.swapAsar) handoff = opened;
      if (opened.extracted) freshExtract = opened;
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  } else {
    core.rememberUnpackedArchive();
  }
  if (!aiBase) return { ok: false, error: core.missingAiBaseMessage() };
  // 刚解开的是官方原件。已经在用的目录仍先还原再按这一版重打。
  const preserveClientBundles = options.preserveClientBundles !== false;
  // DSH 自升级会把宿主文件整个换成新版,但旁边老 bak 不变。此时直接 revertAll 会把当前新版
  // 写回成旧版 → 新旧混码直接崩。先把"原文无 dsh-purge marker 却和 bak 字节不同"的 bak
  // 刷到 current,再 revertAll 就不会毁掉新宿主,下面 applyPatches 把 marker 补回来。
  if (!freshExtract) {
    try {
      const refreshed = core.refreshStaleBaksForUpgrade(aiBase);
      if (refreshed.length) {
        console.warn(`[dsh-purge] refreshed ${refreshed.length} stale bak(s) before revert:`, refreshed);
      }
    } catch (e) {
      console.warn("[dsh-purge] refresh stale bak failed:", String(e && e.message ? e.message : e));
    }
  }
  const reverted = freshExtract ? { reverted: [] } : await core.revertAll(aiBase, { preserveClientBundles });
  if (!freshExtract) await core.revertAllShims();
  // 这条调用在宿主进程与重启脚本子进程里各跑一次，两侧的 entry 必须能分开：
  // 外层已经有身份就沿用它（子进程入口声明的是自己），没有才声明这里是宿主内重打。
  const ambientIdentity = currentApplyRun();
  const identity = ambientIdentity || { entry: "reapply", runId: newApplyRunId() };
  const multi = await withApplyRun(identity, () => core.applyPatchesAllHosts(core.ALL_PATCHES, { preserveClientBundles, forApply: true }));
  await core.patchAllShims();
  const flash = core.silenceCmdFlash(multi.hosts[0]?.aiBase || aiBase);
  const summary = core.summarizeApplyReport(multi.report);
  const clean =
    summary.failed.length === 0 &&
    (core.allPatchHostsWritten(multi.hosts) || core.hostCleanMarkersPresent(aiBase));
  if (clean && flash.ok !== true) {
    console.warn("[dsh-purge] cmd flash patch did not apply cleanly; clean flow continues, UI shows cmdFlashOk=false");
  }
  if (!clean && freshExtract) {
    // 这一轮把整棵解开的树放回去了：写过的字节已经不在了，这时往账本里记「写过它们」
    // 是假供词 —— 事实要记的是**现在还在磁盘上的东西**，所以这一档一个字都不落。
    const restored = core.restoreSealedExtract(freshExtract.appDir, freshExtract.prev);
    return {
      ok: false,
      error: restored ? "清洗没有完成，已放回上一份解开目录" : "清洗没有完成",
      restored,
      version: pluginVersion(),
      reverted: 0,
      applied: summary.applied || 0,
      failed: summary.failed.length,
      renamed: false,
      needsFullQuit: false,
      cmdFlashOk: flash.ok === true,
    };
  }
  // 账本：事实每轮都写，身份（run_id）只给干净轮。`recordApplyRound` 收到空 runId 时
  // 沿用旧戳里的值，于是失败轮既留下证据、又不占住「最后一次成功 apply」。
  //
  // 少了失败轮这一份，跨代升级后的第一次自愈就会把整轮证据丢掉：那一轮真写过的补丁
  // 在账本里没有记录，下一轮仍按旧世代判它们待应用 —— 正是「要跑两次 apply」的死结。
  const ledger = recordApplyRound({
    entry: currentApplyRun()?.entry || "reapply",
    runId: identity.runId || "",
    clean,
    report: multi.report,
    evidence: multi.evidence,
    hostWritten: core.allPatchHostsWritten(multi.hosts) || core.hostCleanMarkersPresent(aiBase),
  });
  if (ledger.error) console.warn("[dsh-purge] applied.json:", ledger.error);
  if (clean) {
    if (freshExtract?.archive) core.writeUnpackedAsarStamp(freshExtract.archive);
    try {
      const seed = core.seedPromptInjectAtBoot(core.findDshHome());
      if (seed && seed.action === "error") {
        console.warn("[dsh-purge] seed prompt-inject failed:", seed.reason);
      }
    } catch (e) {
      console.warn("[dsh-purge] seed prompt-inject exception:", String(e && e.message ? e.message : e));
    }
  }
  let renamed = false;
  if (clean && handoff?.asar && options.scheduleSwap !== false) {
    const swapped = core.scheduleSealedDesktopRestart(handoff);
    renamed = Boolean(swapped?.renamed);
  }
  const pending = Boolean(handoff?.asar && !renamed && options.scheduleSwap !== false);
  // 只有真的挪开了 app.asar，当前进程才还在旧包上，需要再开一次。
  // 官方端已经在 resources/app 里跑时，不能仅因 ELECTRON_RUN_AS_NODE 再弹「需要重启」，
  // 否则每次打开面板都会再要一次重启。
  return {
    ok: clean,
    error: clean ? "" : "清洗没有完成",
    version: pluginVersion(),
    reverted: reverted.reverted?.length || 0,
    applied: summary.applied || 0,
    failed: summary.failed.length,
    renamed,
    needsFullQuit: renamed || pending,
    cmdFlashOk: flash.ok === true,
  };
}
