/**
 * lib/stamp.js — 版本账本的读与写。
 *
 * 为什么单列一个模块：账本回答的是「上一次 apply 是哪一版表、写了哪些字节、那时宿主是哪一版」，
 * 它与「这一轮 apply 怎么打」是两条变化线 —— 判据改一次不该让应用流程重读一遍，反之亦然。
 * 拆开之后 `lib/reapply.js` 只保留对齐判据与应用流程，本模块只管账本的读、写与戳判据。
 *
 * 三条边界：
 *   · 只读写 `$DSH_HOME/dsh-purge/` 下的文件（applied.json / installed-rev / settle-restart.guard）；
 *     不碰宿主树。
 *   · 写侧只记事实：写过什么、核对过什么、宿主是谁、这一轮收成什么样。**只有干净轮**才写
 *     `run_id` 与 `audit`——那是「最后一次成功 apply」的身份，失败的一轮不许占住它。
 *   · 判据不猜：读不到就返回空 / null，由调用方决定「不可判」怎么处置。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import * as core from "./core.js";
import { fileContentKey, patchFingerprints, readStampIdentity, tableFingerprint } from "./patch/table-fingerprint.js";
import { readHostVersion } from "./host-version.js";
import { sameMajorMinor } from "./version.js";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * 插件自己的版本（写进对齐戳的那一份）。
 *
 * 戳的判据用 `sameMajorMinor` 而不是严格相等：stamp 记的是**上次应用那一刻**的插件版本，
 * 任何 patch 级修复都会让严格相等恒 false —— 每次开 dsh 都全量 revert + reapply。
 * 取 major.minor 是因为 minor 变了可能动了补丁表或注入内容（那**应该**重打一次），
 * patch 变了只说明修了 bug。
 */

export function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

function installedRevPath() {
  return path.join(core.findDshHome(), "dsh-purge", "installed-rev");
}

export function installedRev() {
  try {
    return fs.readFileSync(installedRevPath(), "utf8").trim();
  } catch {
    return "";
  }
}

function appliedStampPath() {
  return path.join(core.findDshHome(), "dsh-purge", "applied.json");
}

function settleGuardPath() {
  return path.join(core.findDshHome(), "dsh-purge", "settle-restart.guard");
}

/** 整份戳（读侧只用 version / sha，其余字段是给「版本账本 ↔ apply 轮」对账用的）。 */
export function readAppliedStampFull() {
  try {
    const raw = JSON.parse(fs.readFileSync(appliedStampPath(), "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

export function readAppliedStamp() {
  const raw = readAppliedStampFull();
  if (!raw) return null;
  const identity = readStampIdentity(raw);
  const audit = raw.audit && typeof raw.audit === "object" && !Array.isArray(raw.audit) ? raw.audit : null;
  return {
    version: String(raw.version || ""),
    sha: String(raw.sha || ""),
    tableSha: identity.tableSha,
    // 状态层契约的 audit 块读这两项：`run_id` 回答「最近一轮成功 apply 是哪一次」，
    // `audit` 是那一轮的审计摘要。读不到就是 null，不凭空造一份。
    runId: String(raw.run_id || ""),
    audit,
  };
}

function sameRev(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function isApplyPlaceholder(sha) {
  const text = String(sha || "");
  return text.startsWith("apply:") || text === "applied";
}

function applyPlaceholderVersion(sha) {
  const m = String(sha || "").trim().match(/^apply:(.+)$/);
  return m ? m[1] : "";
}

function refreshStaleApplyPlaceholder(sha) {
  const ver = pluginVersion();
  const oldVer = applyPlaceholderVersion(sha);
  if (oldVer && ver && oldVer !== ver) return `apply:${ver}`;
  return String(sha || "").trim();
}

/** 手动应用未必写过 installed-rev；空 sha 会让 settle 永远判未对齐并无限重启。 */
export function resolveApplySha(explicit) {
  const wanted = String(explicit == null ? "" : explicit).trim();
  if (wanted) return refreshStaleApplyPlaceholder(wanted) || wanted;
  const rev = installedRev();
  if (rev) return refreshStaleApplyPlaceholder(rev) || rev;
  const ver = pluginVersion();
  return ver ? `apply:${ver}` : "applied";
}

function writeInstalledRev(sha) {
  const value = String(sha || "").trim();
  if (!value) return;
  const fp = installedRevPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${value}\n`, "utf8");
}

/**
 * 收尾时**真写过**的文件的字节指纹。
 *
 * 为什么只收传入清单、不再按宿主根全量扫：原先按 `targetFiles(base)` 把每个目标文件的
 * 当时字节都记进账本，于是「没写过的旧字节」也拿到了这一版表的认证 —— 下一轮比对自然
 * 相等，marker 换成了戳。写入清单由引擎逐文件收集（`written_files`），这里只负责哈希；
 * 读不到的文件不记（缺失 ≠ 一致）。
 *
 * @param {string[]} files 本轮真的落过盘的目标文件绝对路径
 * @returns {Record<string,string>} 归一化路径 → sha256
 */
function contentHashesOfFiles(files) {
  const out = {};
  for (const fp of Array.isArray(files) ? files : []) {
    if (typeof fp !== "string" || fp === "") continue;
    try {
      out[fileContentKey(fp)] = createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
    } catch {
      /* 读不到就不记，见上面的说明 */
    }
  }
  return out;
}

/**
 * 写对齐戳。
 *
 * 为什么带 `run_id`：版本账本原先只有 `{version, sha, at}` 三个字段，于是「最后一次
 * 成功 apply 是哪一次」这个问题答不出来 —— `at` 只是个时间点，日志里的 `runId` 才是
 * 能 join 的键。
 *
 * **空 `run_id` 时沿用旧戳里的值，不是抹掉。** 启动路径（settle / reapply）刷戳时拿不到
 * 入口身份，但它在做的只是「确认对齐还在」——那**不该**把上一次用户 apply 留下的身份
 * 清掉。清掉的后果是：`run_id` 只在「apply 之后、下次启动之前」那个窗口里存在，而
 * `startup.ready` 恰恰是启动时写的，于是 `appliedRunId` 永远读到空 —— 键形同虚设。
 *
 * `audit` 摘要同理：它由 `noteAppliedAudit` 在落账之后并进来，而刷戳发生在它之后的下一次
 * 启动。刷戳只重写 `version` / `sha` / `at` 三样事实，`audit` 块按旧戳原样沿用 ——
 * 否则「戳里带这一轮的审计摘要」只在两次启动之间成立，重启一次就没了。
 *
 * 指纹三项（`tableSha` / `patchShas` / `contentSha`）加一份写入清单（`patchesWritten`）
 * 是判据的锚点：表指纹回答「这一版表还是打戳那一版吗」，逐补丁指纹回答「这条补丁的
 * 正文变没变」，写入清单回答「这一版表真动过哪条补丁」，内容指纹回答「文件还是那一轮
 * 收尾时那份字节吗」。只比指纹不够 —— 把旧字节的哈希和旧表指纹一起重写一遍，指纹也会
 * 一致；写入清单与内容指纹都只按「真写过」记账，才挡得住这形态。
 *
 * 旧戳没有指纹，升级后的第一次启动会补写一次并留下 `migratedAt`（**不**认证字节、
 * 不重打）—— 那是这套判据唯一一次可见的迁移代价，之后就走真判据。
 *
 * 缺席（整份文件没有 `run_id`）仍然有意义：它说「这一版插件从来没有被 apply 写过戳」，
 * 与「这次刷写不是 apply 写的」是两件事，别混。
 */
function writeAppliedStamp(sha, runId, identity = {}, extra = {}) {
  const fp = appliedStampPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const id = String(runId || "").trim();
  let carriedRunId = "";
  let carriedAudit = null;
  if (id === "") {
    try {
      const previous = JSON.parse(fs.readFileSync(fp, "utf8"));
      carriedRunId = String(previous?.run_id || "").trim();
      // 只认对象形态：数组 / 字符串是坏数据，凭空「沿用」它只会把坏数据写回去。
      if (previous && typeof previous.audit === "object" && !Array.isArray(previous.audit)) carriedAudit = previous.audit;
    } catch {
      carriedRunId = "";
    }
  }
  const fields = {};
  // 指纹三项各自「有才写」：读侧把缺字段读成「缺失」，与没写同义；但写一个空映射会
  // 让账本看起来「记过了」，所以空值干脆不落盘。
  if (identity && typeof identity.tableSha === "string" && identity.tableSha) fields.tableSha = identity.tableSha;
  if (identity && identity.patchShas && Object.keys(identity.patchShas).length > 0) fields.patchShas = identity.patchShas;
  if (identity && identity.contentSha && Object.keys(identity.contentSha).length > 0) fields.contentSha = identity.contentSha;
  // 两个清单都总是写（空数组有意义）；写入清单回答「动过哪些补丁」，核对清单是同一条口径的另一半。
  fields.patchesWritten = Array.isArray(identity?.patchesWritten)
    ? identity.patchesWritten.map(String)
    : [];
  fields.patchesSettled = Array.isArray(identity?.patchesSettled) ? identity.patchesSettled.map(String) : [];
  if (fields.contentSha) fields.filesWritten = Object.keys(fields.contentSha);
  // 排除记录只在真的出现过「没写但核对过」的那一轮才落盘。空数组不写：它与「这一版没有
  // 任何需要排除的文件」是同一件事，写出来只会让每个账本都多一段噪声。
  if (Array.isArray(identity?.evidenceExcluded) && identity.evidenceExcluded.length > 0) {
    fields.evidenceExcluded = identity.evidenceExcluded;
  }
  if (typeof identity?.migratedAt === "string" && identity.migratedAt) fields.migratedAt = identity.migratedAt;
  const stampIdentity = id || carriedRunId;
  // 宿主身份与「这一轮发生了什么」：前者回答「这份账本说的是哪一版宿主」（官方升级后
  // 归因要用），后者回答「最后一次 apply 收成什么样」—— 它们都不是「成功凭证」，
  // 所以不进 run_id / audit 那两个只记干净轮的字段。
  const hostVersion = String(extra?.hostVersion || "").trim();
  const round = extra?.round && typeof extra.round === "object" ? extra.round : null;
  fs.writeFileSync(fp, `${JSON.stringify({
    version: pluginVersion(),
    sha: String(sha || "").trim(),
    at: new Date().toISOString(),
    ...(hostVersion === "" ? {} : { hostVersion }),
    ...fields,
    ...(stampIdentity === "" ? {} : { run_id: stampIdentity }),
    ...(carriedAudit === null ? {} : { audit: carriedAudit }),
    ...(round === null ? {} : { lastRound: round }),
  }, null, 2)}\n`, "utf8");
}

/**
 * 把这一轮审计的摘要挂到对齐戳上。
 *
 * 为什么不在写戳那一刻一起写：HTTP 那条路上戳在 apply 收尾时就写了，而审计落账在
 * 之后才发生（它要读 after 摘要）。所以先写戳、再把审计摘要并回去 —— 两件事分开，
 * 任何一步失败都不会让对方写不成。
 *
 * @param {{runId?:string, events?:number, layers?:Record<string,{result?:string}>,
 *   unresolved?:Array<number>}} input
 * @returns {boolean} 写成了没有（读不到戳时返回 false，不凭空造一份）
 */
export function noteAppliedAudit(input = {}) {
  const current = readAppliedStampFull();
  if (!current) return false;
  const layers = input && typeof input.layers === "object" && input.layers !== null ? input.layers : {};
  const summary = {};
  for (const [layer, value] of Object.entries(layers)) {
    summary[layer] = String(value && value.result ? value.result : "");
  }
  const next = {
    ...current,
    audit: {
      events: Number.isInteger(input.events) ? input.events : 0,
      layers: summary,
      unresolved: Array.isArray(input.unresolved) ? input.unresolved : [],
    },
  };
  if (typeof input.runId === "string" && input.runId.trim() !== "") next.run_id = input.runId.trim();
  try {
    fs.writeFileSync(appliedStampPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 当前插件版本和已写入补丁的版本在同一主次版本上时，启动不必再还原重打。
 *
 * `tableSha` 是可选的第四项：给了就要求账本里的表指纹与它一致。补丁表一改，上一轮
 * 收尾时写下的 marker 就不能再证明「这一版表已经打上了」——正文换代而 marker 不变的
 * 那类补丁正是漏网的形态。缺省（不传）保持原来的三项判据，调用方是启动路径与测试。
 */
export function stampMatches(stamp, version, rev, tableSha = "") {
  if (!stamp || !stamp.version || !version) return false;
  // 主次版本相同即算对齐（patch / prerelease 不参与比较）。
  //
  // 老判据是 `stamp.version !== version` 严格相等。它的问题是：stamp 记录的是
  // **上次应用那一刻**的插件版本，所以任何版本号变动都会让它恒 false，
  // 于是每次启动都全量 revert + reapply 所有补丁 —— 一次 patch 级修复变成
  // 「每开一次 dsh 就重打一遍」。1.0.0 → 1.2.0 这次收口正是这个形态。
  //
  // 为什么只放 patch：minor 变动可能动了补丁表 / 注入内容，那**该**重打一次；
  // patch 变动只说明修了 bug，不该连带重打。任意版本都算对齐就太松了。
  if (!sameMajorMinor(stamp.version, version)) return false;
  // sha 为空表示 stamp 不完整（曾误写空串），不能当作已对齐（#56）。
  if (!stamp.sha) return false;
  // 表指纹：旧戳没有这一项 ⇒ 不认。启动路径见「戳旧但补丁齐」会补写一次指纹，不重打；
  // 之后同表不再重打，表一变就重打。
  if (tableSha) {
    const stored = String(stamp.tableSha || "").trim();
    if (!stored || stored !== String(tableSha).trim()) return false;
  }
  const current = String(rev || "").trim();
  if (!current) return true;
  // 手动应用占位戳与后续 git rev 并存时，只认 version，避免再空转重启。
  if (isApplyPlaceholder(stamp.sha) || isApplyPlaceholder(current)) return true;
  if (!sameRev(current, stamp.sha)) return false;
  return true;
}

/**
 * stamp 对上了，但宿主被官方更新打回 sealed / 清洗标记没了时仍算未对齐（#57）。
 * 找不到插件根（web 启动早期、纯 CLI）不等于补丁丢失，否则会无限重打+重启（#59）。
 */
export function hostStillHasAppliedPatches() {
  try {
    if (core.desktopAsarStillSealed()) return false;
  } catch {
    /* 非桌面面 */
  }
  try {
    const aiBase = core.findAiBase();
    if (!aiBase) return true;
    return core.hostCleanMarkersPresent(aiBase);
  } catch {
    return true;
  }
}

/** 空 sha 只有在「不是密封、也不是明确缺标记」时才允许就地补戳。 */
export function canHealEmptyStamp({ sealed = false, hasAiBase = false, markersPresent = false } = {}) {
  if (sealed) return false;
  if (hasAiBase && !markersPresent) return false;
  return true;
}

export function patchesMatchInstall() {
  if (!stampMatches(readAppliedStamp(), pluginVersion(), installedRev(), tableFingerprint())) return false;
  return hostStillHasAppliedPatches();
}

/**
 * 账本记的宿主版本 vs 现场宿主版本。
 *
 * 这是「官方升级换掉了整棵宿主树」与「有人动了文件」这两件事唯一的机械区分点：
 * 现场只能读到新版本，旧版本只存在于账本里。两边都读得到且不同，就是宿主换过 ——
 * 那时补丁树是被官方更新覆盖的，处置是重新 apply，而不是去查谁改了文件。
 *
 * @returns {{recorded:string, current:string, changed:boolean, known:boolean}}
 */
export function appliedStampHostDrift() {
  const raw = readAppliedStampFull();
  const recorded = String(raw?.hostVersion || "");
  const current = currentHostIdentity().hostVersion;
  return {
    recorded,
    current,
    changed: recorded !== "" && current !== "" && recorded !== current,
    known: recorded !== "" && current !== "",
  };
}

/**
 * 这一轮 apply 配不配在版本账本里留名。
 *
 * 为什么单列：CLI 原先只要走到收尾就写戳，于是「最后一次成功 apply」会被写成「最后一次
 * **尝试**」——部分失败（`failed` 里有 `failed` / `read_error` / `write_error`）的那一轮
 * 占住了 `run_id`，`startup.ready.appliedRunId` 跟着指错，而真相是那一轮没洗完。
 *
 * 判据与面板那条路同源：没有硬失败、清洗标记真的落到宿主上、安全阀还原没有失败。
 * 软失败（`pattern_not_found` 且补丁声明可接受）不进 `failed`，与面板的 `complete` 同一口径。
 *
 * @param {{failed?:number, hostWritten?:boolean, hookDenyRestoreFailed?:boolean}} [input]
 * @returns {boolean}
 */
export function isCleanApplyRound(input = {}) {
  const options = input && typeof input === "object" ? input : {};
  const failed = Number.isInteger(options.failed) ? options.failed : 0;
  return failed === 0 && options.hostWritten === true && options.hookDenyRestoreFailed !== true;
}

/**
 * 一轮 apply 收尾时的账本记账 —— 四个入口（面板 / 命令 / 工具 / CLI）共用这一处。
 *
 * 事实与身份分开写，分工由 `writeAppliedStamp` 定：
 *   · 事实：本轮真写过 / 核对过哪些字节、这一轮几个 applied / pending —— **每轮都写**；
 *   · 身份：`run_id` / `audit`（最后一次**成功收尾**的是哪一轮）—— **只给干净轮**。
 *     `run_id` 传空串时写侧沿用旧戳里的值，于是失败轮既留下证据、又不占住那个身份。
 *
 * 为什么失败轮的事实最值钱：跨代升级后的第一次 apply 里，真写过的补丁在旧账本里没有
 * 这一版表的记录，这一轮若是把整份写入也省掉，下一轮就仍按旧世代判它们待应用 ——
 * 「pending 让轮次不干净、不干净就不写账本、账本不写下一轮还判 pending」，
 * 这条循环闭合之后，单次 apply 永远收敛不了。
 *
 * `clean` 由**调用方**判：三个入口用 `isCleanApplyRound` 的三档，面板那条路还多一道
 * flash 门槛（那一档不在三输入里）。这里不重算，免得同一件事有两个判据。
 *
 * @param {{entry?:string, runId?:string, clean?:boolean, report?:Array<object>,
 *   evidence?:object, hostWritten?:boolean, roundFailed?:boolean}} input
 * @returns {{clean:boolean, round:object, error:string}}
 */
export function recordApplyRound(input = {}) {
  const report = Array.isArray(input.report) ? input.report : [];
  // 这一轮的收成：与面板 / 诊断轨读的是同一份汇总，不在这里另算一套计数。
  const summary = core.summarizeApplyReport(report);
  const hostWritten = input.hostWritten === true;
  const hookDenyRestoreFailed = input.hookDenyRestoreFailed === true;
  const clean = input.roundFailed !== true
    && (input.clean === true
      || isCleanApplyRound({ failed: summary.failed.length, hostWritten, hookDenyRestoreFailed }));
  const round = {
    at: new Date().toISOString(),
    entry: String(input.entry || ""),
    runId: String(input.runId || ""),
    applied: summary.applied,
    already: summary.already,
    pending: report.filter((row) => row.status === "pending").length,
    failed: summary.failed.length,
    clean,
  };
  let error = "";
  try {
    markPatchesApplied(input.sha, {
      runId: clean ? String(input.runId || "") : "",
      ...(input.evidence && typeof input.evidence === "object" ? input.evidence : {}),
      round,
    });
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }
  return { clean, round, error };
}

/**
 * 手动「应用」成功后也要打戳，否则重启后 settle 会以为补丁未对齐再要求重启。
 *
 * `options.runId` 是「写这份戳的那一轮」：入口知道就传进来（HTTP apply 那条路），
 * 启动路径没有就留空 —— 留空是「不知道」，不许拿时间邻近猜一个。
 *
 * `options.patchesWritten` / `options.filesWritten` 是本轮**真的落过盘**的补丁与文件：
 * 四个 apply 入口从引擎的逐文件结果里收集（`applyPatchesAllHosts().evidence`），
 * 原样传进来。不传 = 这一轮什么都没写（启动刷新戳 / 迁移写），不许拿目标文件的当前
 * 字节倒推认证 —— 那会把没写过的旧文件也记成这一版表的产物。
 *
 * 同一表指纹下的多轮会累积写入清单与内容指纹：`contentSha` 里的条目都是某一轮真写过
 * 的字节，且此后没被重写；文件被外部改动时状态侧会拿现场哈希比对并判待应用。
 *
 * @param {string} [sha] 安装 rev / apply 占位
 * @param {{runId?:string, patchesWritten?:Array<string|number>, filesWritten?:string[],
 *   excludedWrites?:Array<{patchId:string, file:string, verified?:boolean, contentSha?:string}>,
 *   evidence?:{patchesWritten?:Array<string|number>, filesWritten?:string[],
 *   excludedWrites?:Array<{patchId:string, file:string, verified?:boolean, contentSha?:string}>}}} [options]
 * @returns {string} 最终写入的 sha
 */
export function markPatchesApplied(sha, options = {}) {
  const resolved = resolveApplySha(sha);
  const current = installedRev();
  // 已有更新通道写入的 git rev 时沿用；否则用 resolve 结果（含 apply:version 占位）。
  const finalSha = current && !isApplyPlaceholder(current) ? current : resolved;
  writeInstalledRev(finalSha);
  const previous = readAppliedStampFull();
  const prevIdentity = readStampIdentity(previous);
  const tableSha = tableFingerprint();
  const patchShas = patchFingerprints();
  const evidence = options && typeof options.evidence === "object" ? options.evidence : {};
  const writtenPatches = uniqueIds(options?.patchesWritten ?? evidence.patchesWritten);
  const writtenFiles = uniqueFiles(options?.filesWritten ?? evidence.filesWritten);
  // 表没换：上一版表写过的证据继续有效（它认证的字节没变）；表换了：旧证据作废，
  // 只认这一轮真写过的。两条合起来才能回答「这个文件是这一版表打出来的吗」。
  const sameTable = prevIdentity.tableSha !== "" && prevIdentity.tableSha === tableSha;
  const legacy = Boolean(previous) && prevIdentity.tableSha === "" && Object.keys(prevIdentity.patchShas).length === 0;
  const patchesWritten = sameTable
    ? uniqueIds([...prevIdentity.patchesWritten, ...writtenPatches])
    : writtenPatches;
  const settledNow = options?.patchesSettled ?? evidence.patchesSettled ?? [];
  const patchesSettled = uniqueIds(sameTable ? [...prevIdentity.patchesSettled, ...settledNow] : settledNow);
  // 排除记录（自愈轮不写 client bundle）与写入清单同一条累积规则：表没换才继承，
  // 表换了必须由这一轮重新核对一遍 —— 旧记录的补丁指纹可能已经对不上新表了。
  const excludedNow = uniqueExclusions(
    options?.excludedWrites ?? evidence.excludedWrites,
    patchShas,
  );
  const evidenceExcluded = sameTable
    ? uniqueExclusions([...prevIdentity.evidenceExcluded, ...excludedNow])
    : excludedNow;
  const writtenHashes = contentHashesOfFiles(writtenFiles);
  const excludedHashes = {};
  for (const row of evidenceExcluded) {
    if (row.verified === true && row.contentSha) excludedHashes[row.file] = row.contentSha;
  }
  const contentSha = sameTable
    ? { ...prevIdentity.contentSha, ...writtenHashes, ...excludedHashes }
    : { ...writtenHashes, ...excludedHashes };
  // 旧账本只给一次放行：迁移写留下时间戳，读侧据此只认「还没迁移过」的旧戳。
  const migratedAt = prevIdentity.migratedAt || (legacy ? new Date().toISOString() : "");
  writeAppliedStamp(finalSha, options && options.runId, {
    tableSha,
    patchShas,
    contentSha,
    patchesWritten,
    patchesSettled,
    evidenceExcluded,
    migratedAt,
  }, {
    hostVersion: currentHostIdentity().hostVersion,
    round: options && options.round,
  });
  return finalSha;
}

/**
 * 补丁号清单：字符串化、去空、去重。账本里统一存字符串，内存里数字与字符串都可能来。
 * @param {unknown} value
 * @returns {string[]}
 */
function uniqueIds(value) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const id = String(raw == null ? "" : raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 文件清单：归一化路径、去空、去重。与内容指纹表共用 `fileContentKey`，否则写侧与
 * 读侧各归一一次，早晚会漂成两个键。
 * @param {unknown} value
 * @returns {string[]}
 */
function uniqueFiles(value) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const key = fileContentKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 排除记录归一：只收「补丁 id + 文件」齐全的条目。
 *
 * 补丁指纹缺省用当前表补齐：调用方（引擎）只需要说清「这条补丁的哪个文件没写、
 * 现场核对结果如何」，指纹由写账本这一层按同一份表算 —— 两处各算一次必然漂。
 * 同一补丁同一文件只留一条：后来的覆盖先前的（同表累积时以最近一轮为准）。
 *
 * @param {unknown} value 引擎证据里的 excludedWrites
 * @param {Record<string,string>} [patchShas] 当前表的逐补丁指纹
 * @returns {Array<{patch:string, patchSha:string, file:string, contentSha:string, verified:boolean}>}
 */
function uniqueExclusions(value, patchShas = {}) {
  const out = [];
  const index = new Map();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== "object") continue;
    const patch = String(raw.patchId ?? raw.patch ?? "").trim();
    const file = typeof raw.file === "string" && raw.file.trim() !== "" ? fileContentKey(raw.file) : "";
    if (!patch || !file) continue;
    const item = {
      patch,
      patchSha: typeof raw.patchSha === "string" && raw.patchSha ? raw.patchSha : (patchShas[patch] || ""),
      file,
      contentSha: typeof raw.contentSha === "string" ? raw.contentSha : "",
      verified: raw.verified === true,
    };
    const key = `${patch}\u0000${file}`;
    if (index.has(key)) out[index.get(key)] = item;
    else {
      index.set(key, out.length);
      out.push(item);
    }
  }
  return out;
}

/**
 * #59/#60：空 sha 或缺失 installed-rev 会让 settle 每次启动都 reapply+restart。
 * 版本已对齐时先补非空戳 / 种子 rev，打断自重启；真正缺补丁再由后续逻辑重打。
 */
export function healEmptyAppliedStamp() {
  const stamp = readAppliedStamp();
  const version = pluginVersion();
  // 与 stampMatches 同一判据（主次版本相同即算对齐）。这里原来也是严格相等，
  // 于是版本号一动，「空 sha 自愈」这条路一起失效 —— 两个洞会叠成同一个症状：
  // 每次启动都 revert + reapply。改一处漏另一处等于没改，所以两处都改。
  if (!stamp || !sameMajorMinor(stamp.version, version)) return false;
  if (stamp.sha) {
    if (!installedRev()) writeInstalledRev(stamp.sha);
    return false;
  }
  let sealed = false;
  try { sealed = core.desktopAsarStillSealed(); } catch { /* ignore */ }
  let hasAiBase = false;
  let markersPresent = false;
  try {
    const aiBase = core.findAiBase();
    hasAiBase = Boolean(aiBase);
    markersPresent = Boolean(aiBase && core.hostCleanMarkersPresent(aiBase));
  } catch {
    /* 根还没定位 */
  }
  // 密封或明确没打上清洗标记：不能补戳装成已对齐，否则 #57 不再自愈。
  if (!canHealEmptyStamp({ sealed, hasAiBase, markersPresent })) return false;
  markPatchesApplied();
  return true;
}

/** 安装后还没有 installed-rev 时先落盘占位（tarball / 手动应用常见）。 */
export function ensureInstalledRevSeed() {
  const current = installedRev();
  if (current) {
    const next = refreshStaleApplyPlaceholder(current);
    if (next && next !== current) {
      writeInstalledRev(next);
      return next;
    }
    return current;
  }
  const stamp = readAppliedStamp();
  if (stamp?.sha) {
    writeInstalledRev(stamp.sha);
    return stamp.sha;
  }
  const sha = resolveApplySha();
  writeInstalledRev(sha);
  return sha;
}

/** settle 刚重启过则冷却，防止「重打→重启→再重打」打成死循环。 */
export function shouldSkipSettleRestart(windowMs = 180000) {
  try {
    const raw = JSON.parse(fs.readFileSync(settleGuardPath(), "utf8"));
    if (String(raw.version || "") !== pluginVersion()) return false;
    const at = Date.parse(String(raw.at || "")) || 0;
    return at > 0 && Date.now() - at < windowMs;
  } catch {
    return false;
  }
}

export function markSettleRestart() {
  const fp = settleGuardPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify({
    version: pluginVersion(),
    at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

/**
 * 现场宿主身份：版本号 + 清洗标记在不在。
 *
 * 两个值都可能读不到（宿主未定位、asar 密封）。读不到时返回空串 / null，
 * 由 `reconcileAlignment` 决定「不可判」，这里不猜。
 *
 * @returns {{hostVersion:string, markersPresent:boolean|null, aiBase:string}}
 */
export function currentHostIdentity() {
  let aiBase = "";
  try {
    aiBase = core.findAiBase() || "";
  } catch {
    aiBase = "";
  }
  if (!aiBase) return { hostVersion: "", markersPresent: null, aiBase: "" };
  let hostVersion = "";
  try {
    hostVersion = readHostVersion(aiBase);
  } catch {
    hostVersion = "";
  }
  let markersPresent = null;
  try {
    markersPresent = core.hostCleanMarkersPresent(aiBase);
  } catch {
    markersPresent = null;
  }
  return { hostVersion, markersPresent, aiBase };
}
