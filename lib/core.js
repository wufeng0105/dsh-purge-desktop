/**
 * lib/core.js — 宿主树探测与原子落盘的唯一原语层，别的模块只经它碰宿主文件。
 */
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  installHideConsole,
  installHideConsoleIntoBin,
  resolveDshBinRoot,
  revertHideConsoleFromBin,
} from "./hide-console.js";
import { currentApplyRun, diagError, diagLog, newApplyRunId, withApplyRun } from "./diag-log.js";
import { recordInstallState } from "./install-state.js";
import * as desktop from "./desktop.js";
import {
  asarArchiveIsFile,
  asarFileIdentity,
  commitExtractedDir,
  extractAsarToSide,
  shouldExtractAsar,
  sameAsarIdentity,
  hostFs,
  newestPreservedDir,
  overlayAsarUnpacked,
  renameAsarAside,
  restoreExtractedDir,
} from "./extract-asar.js";
import { adapterFor, detectSurface, isDesktop, tryDetectSurface } from "./surface.js";
import { gateHostVersion, readHostVersion } from "./host-version.js";
import { pendingOfficialUpdate, writeUnsealedMarker } from "./host/install-health.js";
import { hostPromptKeepsInject } from "./host-clean.js";
import { PHASE1_KEEP_EXPR, widenPhase1KeepFilter } from "./phase1-keep.js";
import { openSlot } from "./table-read.js";
import * as hooksDeny from "./hooks-deny.js";
import { listTargetFiles, silenceOne, worseHit } from "./shim/silence.js";
// 宿主安装路径探测与目标文件表已搬到 lib/host/。
// 这里按名 import 回来 —— core 的导出面必须与搬家前一字不差（lib/index.js 是
// `import * as core`，少一个符号就是一次静默的功能缺失）。
import {
  allowTargetPath,
  allowTargetPathForAiBase,
  clearAiBaseMissMemo,
  clearDesktopLocateCache,
  desktopDshHomeGuesses,
  dirHasDshLauncher,
  enumeratePatchAiBases,
  findAiBase,
  findDesktopShimDir,
  findDshHome,
  findNpmPrefix,
  findShimDir,
  isAiBase,
  isDesktopCommandRuntimeDir,
  isDshHomeDir,
  isFile,
  isDir,
  // 这两个同样是路径搬家时漏掉的：ensureDirSync 供 atomic write 前建目录，
  // pathIsUnder 供「宿主目录是否属于这份 exe」判定。缺了就是一调用就 ReferenceError。
  ensureDirSync,
  pathIsUnder,
  // silenceHost() 把这个符号原样交给 lib/shim/silence.js 当宿主面门禁；
  // 路径搬家时漏了这一项，直到在真实官方桌面（密封 asar + ensureHostClean）上跑
  // 才炸出 ReferenceError —— 单测与语法检查都看不见「用了没导入」。
  keepSurfaceFile,
  launcherDirsOf,
  listDesktopCommandRuntimeDirs,
  listShimDirsForPatch,
  pathZone,
  portableHomeFromLauncher,
  resetPathMemo,
  shimBackupPath,
} from "./host/paths.js";
import { targetFiles } from "./host/targets.js";
// YAML / persona 文本清洗（纯函数）搬到 lib/prompt/text.js。
// 这里按名 import 回来 —— 三个导出（sanitizeYamlPersonaScalars /
// collapseDuplicateLegacyApplyPath / yamlJsCommentsToHash）在 core 的导出面上。
import {
  asLf,
  collapseDuplicateLegacyApplyPath,
  hasStaleLegacyApplyCall,
  isYamlPath,
  legacyApplyPathStarts,
  rewriteStaleLegacyApplyCall,
  sanitizeYamlPersonaScalars,
  yamlJsCommentsToHash,
} from "./prompt/text.js";
// 判定状态的唯一权威在 lib/patch/status.js：合并优先级、软硬白名单、审计折算与
// 设置页色调都从那里取，engine 这边不再自己维护第二份表。
import {
  displayBucketOf,
  isAlwaysSoft,
  isReady,
  isSoftOk,
  onMissKind,
  rankOf,
} from "./patch/status.js";

// 无归档时用 node:fs；app.asar 还在时改写真实的 resources/app，避免新建文件 ENOENT。
const fs = hostFs;
const fsp = hostFs.promises;

// core 的导出面要求这些符号仍然从这里出得去（index.js / bin 直接取用）。
export {
  allowTargetPath,
  allowTargetPathForAiBase,
  clearDesktopLocateCache,
  dirHasDshLauncher,
  enumeratePatchAiBases,
  findAiBase,
  findDesktopShimDir,
  findDshHome,
  findNpmPrefix,
  findShimDir,
  isDesktopCommandRuntimeDir,
  isDshHomeDir,
  launcherDirsOf,
  listDesktopCommandRuntimeDirs,
  listShimDirsForPatch,
  pathZone,
  portableHomeFromLauncher,
  resetPathMemo,
  shimBackupPath,
  targetFiles,
};

// 这三个是 core 导出面上的文本清洗函数，实现在 lib/prompt/text.js。
export {
  collapseDuplicateLegacyApplyPath,
  sanitizeYamlPersonaScalars,
  yamlJsCommentsToHash,
} from "./prompt/text.js";

const isWindows = process.platform === "win32";
const SHIM_NAMES = ["dsh.cmd", "dsh.ps1", "dsh"];
const HIDDEN_EXEC = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  windowsHide: true,
  timeout: 8000,
};


// ARCH-1:原子写原语已抽到 lib/atomic-fs.js（断 core ↔ desktop 环）。
// 必须**先 import 再 export**：`export ... from` 只做转发、不建立本地绑定，
// 而本文件内部有 7 处直接调用 atomicWriteSync / atomicWriteFile。
// 只写转发形式时，这里一被调用就是 ReferenceError（单测与 node --check 都看不见）。
import { atomicCopyFile, atomicWriteFile, atomicWriteSync } from "./atomic-fs.js";
// 对外导出面保持不变：调用方（desktop / update / rules / skills）仍然从 core 取。
export { atomicCopyFile, atomicWriteFile, atomicWriteSync };

// 补丁表与字面量常量已搬到 lib/patch/。core.js 只保留引擎。
import {
  ALLOW_EXEC_CORE,
  STRONG_INTRO,
  STRONG_INTRO_V1,
  STRONG_INTRO_V2,
  OFFICIAL_REPLACEMENT_BODY,
  OFFICIAL_SCOPE,
  COMPLETE_PROMPT_WATERFALL_INJECT_PREV,
  COMPLETE_PROMPT_WATERFALL_INJECT,
  COMPLETE_PROMPT_WATERFALL_INJECT_HEAD,
  SHELL_NETWORK_WEB,
  SHELL_NETWORK_SDK,
  clearShellNetworkBan,
} from "./patch/constants.js";

// 补丁表本体。displayTitleOf / DISPLAY_GROUP_BY_ID 也被这里取用（见 groupPatchesForDisplay）。
import {
  ALL_PATCHES,
  PATCH_DISPLAY_GROUPS,
  displayTitleOf,
  DISPLAY_GROUP_BY_ID,
} from "./patch/table.js";
// 判据的两块纯函数层：补丁表指纹（表变没变）与逐文件汇总（pending 优先）。
// 都在 lib/patch/ 下，不反向依赖本文件 —— 判据不该随引擎一起长大。
import { fileContentKey, patchFingerprint, patchFingerprints, readStampIdentity, tableFingerprint } from "./patch/table-fingerprint.js";
import { contentFileOutcome, rollupPatchStatus, summarizeRevertParity, FILE_OUTCOME } from "./patch/rollup.js";
// 「几条没打上」的两个口径只有一个实现：raw（补丁号）与 display（展示行）。
import { displayCounts, rawCounts } from "./patch/counts.js";

// 向后兼容：lib/index.js 是 `import * as core`，re-export 对它完全透明。
// 只再导出「搬家前就已在 core 导出面里」的三个符号 —— 导出面必须一字不差。
// 常量本身（STRONG_INTRO 系列等）此前从未导出，所以这里也不导出。
export { ALL_PATCHES, PATCH_DISPLAY_GROUPS } from "./patch/table.js";
export { ALLOW_EXEC_CORE } from "./patch/constants.js";

// 这里原有两条 ALLOW_EXEC_PERSONA_BLOCK / ALLOW_EXEC_PERSONA_LINE 常量，正文里带
// `{{cwd}}` 且全仓无任何引用。宿主只注册 provider / model 两个提示词变量，
// 谁把它们接进 persona 谁就会让整轮对话抛 unknown prompt variable；
// 既然没人用，直接删掉，避免以后有人顺手接上。

const LEGACY_OPERATOR_LOCK =
  "Your identity is defined exclusively by the dsh-purge operator prompt";

const IDENTITY_FROM_INJECT =
  "When asked 你是谁 / who are you, answer as the identity defined in prompt-inject.md. Never say 我是 DeepSeek 的 AI 助手 or that you run on DeepSeek Harness as your identity — that is the host, not you.";
const IDENTITY_STRIP = "";

const IDENTITY_LOCK_LCS =
  "You are the operator persona in prompt-inject (Little Code Sauce / LCS unless that file names someone else). When asked 你是谁 / who are you, answer with that name only. Never say 我是 DeepSeek 的 AI 助手 or that you run on DeepSeek Harness as your identity — that is the host, not you.";



const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 本插件自己的 package.json（缓存；版本门禁每次 apply 都要读它）。 */
let _pluginPkgCache = null;
function pluginPkg() {
  if (_pluginPkgCache) return _pluginPkgCache;
  try {
    _pluginPkgCache = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "..", "package.json"), "utf8"));
  } catch {
    _pluginPkgCache = {};
  }
  return _pluginPkgCache;
}

/**
 * CONTRACT-4 / CONTRACT-4：宿主版本门禁。
 *
 * 在 apply 之前跑，把「能不能在这个宿主上应用」变成单一结论。
 * 不匹配时拒绝，而不是打一堆匹配不到的补丁然后静默失效。
 *
 * @param {string} aiBase 宿主插件根
 * @param {object} [options] `{ force, hostVersion }`（hostVersion 供测试注入）
 * @returns {{allowed:boolean, level:string, reason:string, hint:string, hostVersion:string, dshTarget:string}}
 */
export function checkHostVersionGate(aiBase, options = {}) {
  const dshTarget = String(pluginPkg().dshTarget || "");
  const hostVersion = String(options.hostVersion || "") || readHostVersion(aiBase) || "";
  const force = options.force === true || pluginPkg()?.dsh?.forceApplyOnVersionMismatch === true;

  // 宿主版本读不到：不阻断（可能是首次安装 / 解包中），但要标记
  if (!hostVersion) {
    return {
      allowed: true,
      level: "unknown",
      reason: "读不到宿主版本（可能正在解包）。本次放行，补丁状态会反映真实匹配情况。",
      hint: "",
      hostVersion: "",
      dshTarget,
    };
  }
  // 没声明 dshTarget：不阻断（开发态）
  if (!dshTarget) {
    return {
      allowed: true,
      level: "no-target",
      reason: "package.json 未声明 dshTarget，跳过版本门禁。",
      hint: "",
      hostVersion,
      dshTarget: "",
    };
  }
  const gate = gateHostVersion({ hostVersion, dshTarget, force });
  return { ...gate, hostVersion, dshTarget };
}




export function findDshBinRoot(aiBase = findAiBase()) {
  return resolveDshBinRoot(aiBase);
}

function isPackagedDesktopDshRoot(p) {
  if (!p) return false;
  const n = String(p).replace(/\\/g, "/").toLowerCase();
  if (n.includes("/resources/app/dsh")) return true;
  if (n.includes("deepseekharnessdesktop")) return true;
  try {
    return desktop.isInsideDesktopInstall(p);
  } catch {
    return false;
  }
}

export function ensureHiddenConsole(aiBase = findAiBase()) {
  const live = installHideConsole();
  const entryRoot = findDshBinRoot(aiBase);
  const desktopBin = isPackagedDesktopDshRoot(entryRoot) || isPackagedDesktopDshRoot(aiBase);
  if (desktopBin) {
    let entry = "skipped_desktop";
    try {
      const reverted = revertHideConsoleFromBin(entryRoot || aiBase);
      if (reverted === "reverted") entry = "skipped_desktop_reverted";
      else if (reverted && reverted !== "absent") entry = reverted;
    } catch {
      /* 官方桌面不靠改 bin.js 启动 */
    }
    return { live, entry, entryRoot };
  }
  const entry = installHideConsoleIntoBin(entryRoot || aiBase);
  return { live, entry, entryRoot };
}

export function silenceCmdFlash(aiBase = findAiBase()) {
  const hide = ensureHiddenConsole(aiBase);
  const doctor = stubDoctorSupervisor();
  const doctorSpawn = silenceDoctorSpawnFlash();
  const market = silenceDshmarketRestartFlash();
  const subprocess = silenceSubprocessLocalFlash();
  const officialPhase1 = silenceOfficialPhase1Strip();
  const mnemon = silenceMnemonGitFlash();
  // bin.js 写失败（missing_bin / ACL）不阻断 Apply。源码 cli 跳过注入也算成功（#41）。
  const hideOk =
    process.platform !== "win32" ||
    hide.entry === "injected" ||
    hide.entry === "already_injected" ||
    hide.entry === "skipped_not_win32" ||
    hide.entry === "skipped_source_cli" ||
    hide.entry === "skipped_desktop" ||
    hide.entry === "skipped_desktop_reverted" ||
    hide.entry === "skipped_electron" ||
    hide.entry === "missing_bin" ||
    hide.entry === "sealed_asar" ||
    (typeof hide.entry === "string" && hide.entry.startsWith("error:"));
  return {
    ...hide,
    doctor,
    doctorSpawn,
    market,
    subprocess,
    officialPhase1,
    mnemon,
    ok: hideOk,
  };
}

// H17:rank 规则 error:X > reverted > absent > missing。坏结果不被成功覆盖。
const REVERT_RANK = { missing: 0, absent: 1, reverted: 2 };
function worseRevertHit(current, next) {
  const curErr = typeof current === "string" && current.startsWith("error:");
  const nextErr = typeof next === "string" && next.startsWith("error:");
  if (curErr) return current;
  if (nextErr) return next;
  const a = REVERT_RANK[current] ?? 0;
  const b = REVERT_RANK[next] ?? 0;
  return b >= a ? next : current;
}

function rewriteFiles(files, rewrite) {
  let hit = "missing";
  for (const fp of files) {
    let text;
    try {
      text = fs.readFileSync(fp, "utf8");
    } catch {
      continue;
    }
    const next = rewrite(text);
    if (next == null || next === text) {
      hit = worseRevertHit(hit, "absent");
      continue;
    }
    try {
      fs.writeFileSync(fp, next, "utf8");
      hit = worseRevertHit(hit, "reverted");
    } catch (e) {
      hit = worseRevertHit(hit, `error:${e}`);
    }
  }
  return hit;
}

export function revertCmdFlash(aiBase = findAiBase(), dshHome = findDshHome()) {
  const hide = revertHideConsoleFromBin(aiBase);
  const subprocess = rewriteFiles(listTargetFiles("subprocess-local", dshHome, silenceHost()), (text) => {
    const marker = "[dsh-purge] subprocess-local windowsHide";
    if (!text.includes(marker)) return text;
    return text
      .replace(/\n\t\t\/\/ \[dsh-purge\] subprocess-local windowsHide\n\t\twindowsHide: true/, "")
      .replace(",\n\t\t// [dsh-purge] subprocess-local windowsHide\n\t\twindowsHide: true", "");
  });
  const doctorSpawn = rewriteFiles(listTargetFiles("doctor-spawn", dshHome, silenceHost()), (text) => {
    if (!text.includes("[dsh-purge]")) return text;
    let next = text;
    const spawnNeedle = 'import { spawn } from "node:child_process";';
    next = next.replace(
      /import \{ spawn as __dshPurgeSpawnOrig \} from "node:child_process";\n\/\/ \[dsh-purge\] doctor spawn windowsHide\nfunction spawn\(file, args, options\) \{[\s\S]*?\n\}\n/,
      spawnNeedle + "\n",
    );
    const specNeedle =
      'function dshSpawnSpec(binary, args, platform = process.platform) {\n' +
      '\tif (platform === "win32") {\n' +
      '\t\tif (binary.toLowerCase().endsWith(".cmd") || binary.toLowerCase().endsWith(".bat")) return {\n' +
      '\t\t\tcommand: "cmd.exe",\n' +
      '\t\t\targs: windowsCmdShimArgs(binary, args),\n' +
      '\t\t\twindowsVerbatimArguments: true\n' +
      '\t\t};';
    if (next.includes("[dsh-purge] dsh.cmd → node bin.js (no cmd.exe)")) {
      next = next.replace(
        /function dshSpawnSpec\(binary, args, platform = process\.platform\) \{\n\tif \(platform === "win32"\) \{\n\t\tif \(binary\.toLowerCase\(\)\.endsWith\("\.cmd"\) \|\| binary\.toLowerCase\(\)\.endsWith\("\.bat"\)\) \{[\s\S]*?\t\t\}/,
        specNeedle,
      );
    }
    const stdioNeedle =
      'const child = spawnDsh(realDsh, options.argv, {\n' +
      '\t\tstdio: [\n' +
      '\t\t\t"inherit",\n' +
      '\t\t\t"inherit",\n' +
      '\t\t\t"pipe"\n' +
      '\t\t],';
    if (next.includes("[dsh-purge] doctor launch stdio no-inherit")) {
      next = next.replace(
        /const child = spawnDsh\(realDsh, options\.argv, \{\n\t\t\/\/ \[dsh-purge\] doctor launch stdio no-inherit\n\t\tstdio: \[\n\t\t\t"ignore",\n\t\t\t"ignore",\n\t\t\t"pipe"\n\t\t\],\n\t\twindowsHide: true,/,
        stdioNeedle,
      );
    }
    return next;
  });
  const market = rewriteFiles(listTargetFiles("market-restart", dshHome, silenceHost()), (text) => {
    const marker = "[dsh-purge] market restart → node bin.js (no powershell/dsh.cmd)";
    if (!text.includes(marker)) return text;
    const needle =
      "export function respawnInvocation(launch, platform = process.platform) {\n" +
      "    if (platform !== 'win32') {\n" +
      "        return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true };\n" +
      "    }\n";
    let next = text.replace(
      /export function respawnInvocation\(launch, platform = process\.platform\) \{\n    if \(platform !== 'win32'\) \{\n        return \{ file: launch\.file, args: launch\.args, viaShell: launch\.viaShell, detached: true \};\n    \}\n    \/\/ \[dsh-purge\] market restart[^\n]*\n    \{[\s\S]*?\n    \}\n/,
      needle,
    );
    const importNeedle = "import { tmpdir } from 'node:os';\nimport { join } from 'node:path';";
    const importReplacement =
      "import { existsSync } from 'node:fs';\n" +
      "import { tmpdir } from 'node:os';\n" +
      "import { dirname, join } from 'node:path';";
    if (next.includes(importReplacement)) next = next.replace(importReplacement, importNeedle);
    return next;
  });
  return { hide, subprocess, doctorSpawn, market };
}

export function silenceSubprocessLocalFlash(dshHome = findDshHome()) {
  return silenceOne("subprocess-local", dshHome, silenceHost());
}

/** 官方 dsh-agent-instructions 里若有 phase-1 白名单，同样放行 dsh-purge* / dshpg-*。 */
export function silenceOfficialPhase1Strip(dshHome = findDshHome()) {
  return silenceOne("official-phase1", dshHome, silenceHost());
}


/**
 * 交给 `lib/shim/silence.js` 的宿主能力包。
 *
 * 为什么是注入而不是让 silence.js 直接 import core：core 已经 import 了 silence，
 * 反向 import 会立刻造出 ARCH-1 禁止的环。而这四个判定（isFile / isDir /
 * keepSurfaceFile / findAiBase）本身就住在 core 的路径层里，搬不过去。
 *
 * 每次调用现取：`findAiBase()` 自带 memo，但 `keepSurfaceFile` 依赖当次宿主面，
 * 缓存住会在一次 Apply 打到多个根时给错答案（见 allowTargetPathForAiBase 的注释）。
 */
function silenceHost() {
  return { path, fs, isFile, isDir, keepSurfaceFile, findAiBase };
}

export function silenceMnemonGitFlash(dshHome = findDshHome()) {
  return silenceOne("mnemon-git", dshHome, silenceHost());
}


// 删 supervisor.cmd/vbs，不要留空文件，否则 doctor 每轮都会 schtasks /Delete。
export function stubDoctorSupervisor() {
  if (process.platform !== "win32") return { skipped: "not_win32" };
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const dir = path.join(local, "DSH Doctor");
  const cmdPath = path.join(dir, "supervisor.cmd");
  const vbsPath = path.join(dir, "supervisor.vbs");
  const out = { dir, cmd: null, vbs: null, task: null };
  const unlinkQuiet = (fp) => {
    try {
      if (!fs.existsSync(fp)) return "absent";
      try {
        fs.chmodSync(fp, 0o666);
      } catch {}
      fs.unlinkSync(fp);
      return "deleted";
    } catch (e) {
      return `error:${e}`;
    }
  };
  out.cmd = unlinkQuiet(cmdPath);
  out.vbs = unlinkQuiet(vbsPath);
  let taskExists = false;
  try {
    execFileSync("schtasks", ["/Query", "/TN", "DSH Doctor Supervisor"], {
      ...HIDDEN_EXEC,
      stdio: "ignore",
    });
    taskExists = true;
  } catch {
    taskExists = false;
  }
  if (taskExists) {
    try {
      execFileSync("schtasks", ["/Delete", "/F", "/TN", "DSH Doctor Supervisor"], {
        ...HIDDEN_EXEC,
        stdio: "ignore",
      });
      out.task = "deleted";
    } catch (e) {
      out.task = `error:${e}`;
    }
  } else {
    out.task = "absent";
  }
  return out;
}

// doctor 是独立进程，不加载 hide-console；启动改为 node + bin.js。
export function silenceDoctorSpawnFlash(dshHome = findDshHome()) {
  return silenceOne("doctor-spawn", dshHome, silenceHost());
}

// 市场重启不要走 powershell / dsh.cmd。
export function silenceDshmarketRestartFlash(dshHome = findDshHome()) {
  return silenceOne("market-restart", dshHome, silenceHost());
}

export function applyRuntimeEnv() {
  if (!String(process.env.DSH_HOME || "").trim()) {
    for (const cand of desktopDshHomeGuesses()) {
      if (!isDshHomeDir(cand)) continue;
      process.env.DSH_HOME = cand;
      break;
    }
  }
  // 启动时可能尚未组完依赖；Apply 时清掉失败缓存再探。
  clearAiBaseMissMemo();
  if (process.env.DSH_PERMISSION_MODE === "danger-full-access") {
    delete process.env.DSH_PERMISSION_MODE;
  }
  if (!String(process.env.DSH_DESKTOP_INSTALL || "").trim()) {
    try {
      const fp = path.join(findDshHome(), "dsh-purge", "desktop-install.txt");
      if (hostFs.existsSync(fp)) {
        const line = hostFs.readFileSync(fp, "utf8").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        if (line) process.env.DSH_DESKTOP_INSTALL = line;
      }
    } catch {
      // 非致命
    }
  }
  return {
    DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || "(unset — UI/session controls mode)",
    DSH_HOME: process.env.DSH_HOME || "",
  };
}

export function envForDetachedSpawn(base = process.env) {
  const env = { ...base };
  delete env.DSH_PERMISSION_MODE;
  delete env.DSH_PURGE_RESTART;
  return env;
}




/** 桌面官方 CLI：resources/runtime/cli/bin 里的 dsh.cmd / dsh.ps1 / dsh。 */

/**
 * 合并多个 aiBase 的 apply 报告：同一条补丁取各根上「最差」的状态。
 *
 * 一个根打上了、另一个没打上，整体就是没打上 —— 否则界面会显示「已应用」
 * 而实际有宿主树没改到。次序表在 lib/patch/status.js，认不出的状态按最差算。
 */
export function mergeApplyReports(reports) {
  const flat = reports.flat();
  const byId = new Map();
  for (const row of flat) {
    const id = row.patch_id ?? row.id;
    const prev = byId.get(id);
    const rank = rankOf(row.status);
    const prevRank = prev ? rankOf(prev.status) : 99;
    if (!prev || rank < prevRank) byId.set(id, { ...row, patch_id: id });
  }
  return [...byId.values()].sort((a, b) => (a.patch_id ?? 0) - (b.patch_id ?? 0));
}

/**
 * `apply.end` 的失败计数口径：一次 apply 到底有没有失败。
 *
 * `failed` 数的是「按逐补丁判定算硬失败」的条数，与 `apply.host` 的 `failed` 同一个
 * 判据 —— 单宿主的一轮 apply 上两个数必须相等。改前它只数 `status === "failed"`，
 * 而逐条判定根本不产出那一档，于是同一份日志里 `apply.host.failed=3`、
 * `apply.end.failed=0`，只读汇总的人会得出「没有失败」。读写错误单列出两个计数，
 * 是因为它们在逐条日志里只有一个 status，汇总处不给数就只能回去数 `apply.patch`。
 * 多宿主时每条补丁只按最差状态算一次（合并报告已折过）。
 *
 * @param {Array<object>} merged mergeApplyReports 的产物
 * @param {Map<number,object>} patchById 补丁号 → 补丁
 */
export function applyEndCounts(merged, patchById = new Map()) {
  const rows = Array.isArray(merged) ? merged : [];
  const isWriteError = (status) => typeof status === "string" && status.startsWith("write_error:");
  return {
    failed: rows.filter((r) => !isPatchResultSoftOk(r, patchById.get(r.patch_id) || null)).length,
    readError: rows.filter((r) => r.status === "read_error").length,
    writeError: rows.filter((r) => isWriteError(r.status)).length,
  };
}

/**
 * `apply.end` 的生效判据：这一轮改的字节，运行中的宿主读得到吗？
 *
 * 判据是「这一轮真的改动了宿主读的那些文件」（合并报告里 `status` 为 `applied` 的条数 > 0），
 * **不是**「宿主是不是密封 asar」。理由：密封只决定字节写到哪里（归档还是解包目录），
 * 而运行中的宿主进程两种形态下都不会重新读一次模块或提示词 —— 于是「改了文件」本身
 * 就是「要重启才可能读到」的充分条件。反过来按密封判会漏掉最常见的那一形态：未密封的
 * 桌面宿主上打完补丁不重启，`pendingRestart` 会写成 false，读的人据此判定「已生效」。
 *
 * `apply.end` 缺席时（门禁拒绝、中途被杀）这条判据不可用，读的人按「缺席」处置，
 * 不许当成 false。
 */
export function pendingRestartOf(merged) {
  const rows = Array.isArray(merged) ? merged : [];
  return rows.some((row) => row && row.status === "applied");
}

export function allPatchHostsWritten(hosts) {
  return Array.isArray(hosts) && hosts.length > 0 && hosts.every((h) => h.hostWritten === true);
}

/**
 * `apply.start` 的版本对照：让「门禁这一关是过的」有正向证据。
 *
 * 门禁拒绝时 `apply.gate.reject` 会带 hostVersion / dshTarget；成功路径原先一个都不带，
 * 于是「门禁过了」只能靠「没出现 reject」反推 —— 那是否席证明，日志被截断时与沉默同形。
 * 这里在开轮那一刻就把「第一个待打宿主的实际版本」与「补丁表要求的版本」读一遍，
 * 字段名与 reject 那处逐字相同，读的人可以两边对读。
 *
 * 读不到宿主（还没解包 / 枚举失败）时留空串：空串在日志里读作「没读到」，
 * 不是「两版本相同」。代价是多一次只读枚举（与随后解析目标同一套入口）。
 */
function gateVersionPairForLog(options) {
  const dshTarget = String(pluginPkg().dshTarget || "");
  try {
    const bases = enumeratePatchAiBases({ discover: options.forApply === true || options.discover === true });
    for (const base of bases) {
      const gate = checkHostVersionGate(base, options);
      if (gate && gate.hostVersion) return { hostVersion: gate.hostVersion, dshTarget: gate.dshTarget };
    }
  } catch {
    // 枚举读不动就留空：宁可记「没读到」，也不猜一个版本号。
  }
  return { hostVersion: "", dshTarget };
}

/** 当前宿主包是否仍密封；读失败留空串（空串 = 没判出来，不是 false）。 */
function asarSealedForLog() {
  try {
    return desktopAsarStillSealed();
  } catch {
    return "";
  }
}

async function resolveAiBaseForApply(aiBase, options = {}) {
  if (!aiBase) return null;
  if (!desktop.isInsideDesktopInstall(aiBase)) return aiBase;
  try {
    const located = await resolveOfficialAiBase(aiBase, { forApply: options.forApply === true });
    return located?.aiBase || aiBase;
  } catch {
    return aiBase;
  }
}

/**
 * 一轮 apply 的「真写过什么」与「核对过什么」两半证据。
 *
 * 账本只该认证本轮真的落过盘的字节，所以写入证据只能从逐文件写入收集，不能事后拿
 * 目标文件的当前字节倒推 —— 后者会把「没写过的旧文件」也记成这一版表的产物。
 * 多宿主时按补丁号与路径各自去重：同一份模板打到两个宿主算两条补丁证据、两个文件。
 *
 * 另一半是「核对过在目标态」：文件早就在这一版表的目标态、这一轮没有可写的字节
 * （远端 #2/#3/#50）。它只产出一个补丁号清单，**不带内容指纹** —— 内容指纹只属于
 * 真写过的字节，那是 WP2 定下的规矩，不许为了多认证一条就把没写过的文件也算进去。
 *
 * @param {Array<{report?:Array<object>}>} hosts applyPatchesAllHosts 的宿主结果
 * @returns {{patchesWritten:string[], patchesSettled:string[], filesWritten:string[],
 *   excludedWrites:Array<object>}}
 */
export function collectApplyEvidence(hosts) {
  const patchIds = new Set();
  const settledIds = new Set();
  const files = [];
  const seenFiles = new Set();
  const excludedWrites = [];
  const seenExcluded = new Set();
  for (const host of Array.isArray(hosts) ? hosts : []) {
    for (const row of Array.isArray(host?.report) ? host.report : []) {
      if (Number(row?.applied) > 0) patchIds.add(String(row.patch_id));
      if (row?.settled === true) settledIds.add(String(row.patch_id));
      for (const fp of Array.isArray(row?.written_files) ? row.written_files : []) {
        const key = String(fp);
        if (!key || seenFiles.has(key)) continue;
        seenFiles.add(key);
        files.push(key);
      }
      // 自愈轮跳过 client bundle 时没有 written_files，但有「没写它、现场核对过」的记录。
      // 这条记录不冒充写入证据：账本单列 evidenceExcluded，读侧两样都对上才认。
      for (const item of Array.isArray(row?.excluded_files) ? row.excluded_files : []) {
        if (!item || typeof item !== "object") continue;
        const file = String(item.file || "");
        const key = `${row.patch_id}\u0000${file}`;
        if (!file || seenExcluded.has(key)) continue;
        seenExcluded.add(key);
        excludedWrites.push({
          patchId: String(row.patch_id),
          patchSha: String(item.patchSha || ""),
          file,
          verified: item.verified === true,
          contentSha: String(item.contentSha || ""),
        });
      }
    }
  }
  return { patchesWritten: [...patchIds], patchesSettled: [...settledIds], filesWritten: files, excludedWrites };
}

/** 没跑引擎的空轮：没有写入、没有核对，就没有可认证的补丁与文件。 */
export function emptyApplyEvidence() {
  return { patchesWritten: [], patchesSettled: [], filesWritten: [], excludedWrites: [] };
}

/**
 * 一次 Apply 打到所有宿主（多根）。
 *
 * ## 版本门禁提到入口
 *
 * 收敛前只有 `applyPatches` 里有 gate，而 `applyPatchesAllHosts` 在它之前就
 * 已经干了三件**写盘**的事：`backupAll`（写 .bak / vault）、
 * `restoreHookDenyForBases`（改 hooks 配置）、以及每个 host 收尾的
 * `silenceCmdFlash`（改 bin / supervisor / 各插件源码）。
 * 版本不匹配时这三件照跑 —— 也就是说「拒绝」只拒绝了补丁本身，
 * 宿主的其它写路径全在门禁之外裸跑。
 *
 * 现在：先把本轮要打的**全部** aiBase 解析出来，逐个过 gate，
 * 任一不匹配就整体拒绝（一个字节都不写）。仍然是全有或全无，
 * 因为一次 Apply 的用户预期是「要么都洗干净，要么什么都没动」。
 *
 * `applyPatches` 内部的 gate 保留：单宿主调用方（测试、CLI）仍要它兜底。
 *
 * @param {Array<object>} [patches] 补丁表（默认全量）
 * @param {object} [options] 透传给 applyPatches 的选项
 * @param {string} [options.dshHome] 日志与装机指纹的落点；缺省按 findDshHome() 解析。
 *   存在的理由是测试隔离：测试拿临时宿主树跑 apply 时，日志必须跟着临时 home 走，
 *   否则真实 home 的 diag 会被夹具路径污染，而那份日志正是排障时唯一的事实源。
 * @param {boolean} [options.log=false] 显式关掉本次调用的 diag 记录。只关 diag，
 *   不碰 audit —— 审计是「文件被改过」的证据，测试也不该把它一并关掉。
 * @returns {Promise<{hosts:Array<object>, report:Array<object>, hookDenyRestoreFailed:string[], hookDenyRestoreChanged:string[]}>}
 * @throws {Error} 任一宿主版本不匹配时抛 DSH_PURGE_HOST_VERSION_MISMATCH
 */
export async function applyPatchesAllHosts(patches = ALL_PATCHES, options = {}) {
  const settings = options.hooksDeny?.settings || getHooksDenySettings();
  const pick = options.hooksDeny?.selectPatches || hooksDeny.selectPatches;
  const selected = pick(patches, settings);
  const hookDenyRestoreFailed = [];
  const hookDenyRestoreChanged = [];
  const hosts = [];
  const seen = new Set();

  // 一轮 Apply 的完整轨迹从这里开始记。宿主侧与 CLI 侧共用这条路径，
  // 所以「点了应用没反应」与「远程 --apply 打偏」都能落到同一份日志里。
  const startedAt = Date.now();
  const dshHomeForLog = String(options.dshHome || "").trim() || findDshHome();
  const diagOff = options.log === false;
  const note = (event, fields) => {
    if (!diagOff) diagLog(event, fields, dshHomeForLog);
  };
  const noteError = (event, error, fields) => {
    if (!diagOff) diagError(event, error, fields, dshHomeForLog);
  };
  note("apply.start", {
    patches: patches.length,
    selected: selected.length,
    forApply: options.forApply === true,
    // 成功那轮也要能证明门禁过了：字段名与 apply.gate.reject 逐字一致。
    ...gateVersionPairForLog(options),
  });

  // ① 先解析出本轮全部宿主（这一步只读，不写盘）。
  const targets = [];
  for (const raw of enumeratePatchAiBases({ discover: options.forApply === true || options.discover === true })) {
    const aiBase = await resolveAiBaseForApply(raw, options);
    if (!aiBase) continue;
    const key = path.normalize(aiBase).replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(aiBase);
  }
  // 解析不到宿主是最常见的「什么都没发生」，必须留痕：空数组说明探测失败而不是补丁失败。
  note("apply.hosts", { count: targets.length, bases: targets.join(",") });

  // ② 一次性过 gate。任一不匹配就整体拒绝 —— 此时还没写过任何文件。
  const gates = targets.map((aiBase) => ({ aiBase, gate: checkHostVersionGate(aiBase, options) }));
  const rejected = gates.filter((row) => !row.gate.allowed);
  if (rejected.length) {
    const first = rejected[0];
    const detail = rejected
      .map((row) => `${row.aiBase}（宿主 ${row.gate.hostVersion || "未知"} / 目标 ${row.gate.dshTarget || "未声明"}）`)
      .join("；");
    const error = new Error(
      `宿主版本门禁拒绝，本次 Apply 未写入任何文件。`
      + `不匹配的宿主：${detail}。`
      + `${first.gate.reason || ""}${first.gate.hint ? ` ${first.gate.hint}` : ""}`,
    );
    error.code = "DSH_PURGE_HOST_VERSION_MISMATCH";
    error.gate = first.gate;
    error.gates = gates.map((row) => ({ aiBase: row.aiBase, ...row.gate }));
    error.rejected = rejected.map((row) => row.aiBase);
    // 门禁拒绝必须和「补丁没匹配」区分开：前者一个字节都没写，后者可能写了一半。
    noteError("apply.gate.reject", error, {
      rejected: error.rejected.join(","),
      hostVersion: first.gate.hostVersion,
      dshTarget: first.gate.dshTarget,
      // 引擎段到此为止：门禁拒绝之后这一轮不会再有任何引擎事件。
      runEnd: "engine",
    });
    throw error;
  }

  // ③ 全部放行，才开始写盘。
  //
  // 但「要打的补丁是 0 条」不是一轮 apply 的最小形态，是**什么都没得打**：
  // 此时若照常往下走，`backupAll` 会给每个宿主留一份 `.dshpurge.bak`、vault 再记一批条目，
  // 而这一轮一条判定都不会产生 —— 一次「空探测」就把整棵宿主树弄脏。所以先短路：
  // 不写任何文件，只把「为什么没打」记进 apply.end。
  if (selected.length === 0) {
    note("apply.end", {
      hosts: targets.length,
      total: 0,
      applied: 0,
      already: 0,
      failed: 0,
      readError: 0,
      writeError: 0,
      notFound: 0,
      missingFile: 0,
      ms: Date.now() - startedAt,
      pendingRestart: false,
      asarSealed: asarSealedForLog(),
      reason: patches.length === 0 ? "no_patches_given" : "all_patches_filtered",
      // 引擎段收尾标记：读侧判「这一轮跑完了没有」只看有没有这个键，不看它排第几。
      runEnd: "engine",
    });
    return { hosts: [], report: [], hookDenyRestoreFailed, hookDenyRestoreChanged, evidence: emptyApplyEvidence() };
  }
  for (const aiBase of targets) {
    // 保险柜跟着本轮 dshHome 走：临时 home 的测试不许把备份写进开发机的真保险柜。
    await backupAll(aiBase, { dshHome: dshHomeForLog });
    if (settings.hooksDenyBypass === false) {
      const restored = await restoreHookDenyForBases([aiBase]);
      hookDenyRestoreFailed.push(...restored.failed);
      hookDenyRestoreChanged.push(...restored.changed);
    }
    const hostStartedAt = Date.now();
    const report = await applyPatches(aiBase, selected, options);
    // 逐条落盘：82 条补丁打到哪个文件、结果是什么，事后只看日志就能定位是哪一条打偏。
    for (const row of report) {
      note("apply.patch", {
        base: aiBase,
        id: row.patch_id,
        name: row.name,
        status: row.status,
      });
    }
    const summary = summarizeApplyReport(report);
    const hostWritten = hostCleanMarkersPresent(aiBase);
    const flash = silenceCmdFlash(aiBase);
    // 一个宿主的版本对照：`apply.start` 只带得动第一个宿主的版本对（那时其余宿主还没解析完），
    // 多宿主时剩下的宿主要在这一行才看得到 —— 否则「其余宿主门禁也过了」只能靠缺席证明。
    const gateOfHost = gates.find((row) => row.aiBase === aiBase)?.gate || {};
    // 一份宿主的汇总：apply 成功但 markers 没落地，说明写的是解包目录而宿主读不到
    // （asar 仍密封时的典型症状），这一行就是判据。
    note("apply.host", {
      base: aiBase,
      total: report.length,
      applied: summary.applied,
      already: summary.already,
      failed: summary.failed.length,
      soft: summary.soft.length,
      markers: hostWritten,
      flash: flash.ok,
      ms: Date.now() - hostStartedAt,
      hostVersion: gateOfHost.hostVersion || "",
      dshTarget: gateOfHost.dshTarget || "",
    });    hosts.push({
      aiBase,
      report,
      summary,
      hostWritten,
      flash,
    });
  }
  const merged = mergeApplyReports(hosts.map((h) => h.report));
  const endCounts = applyEndCounts(merged, new Map(patches.map((p) => [p.id, p])));
  note("apply.end", {
    hosts: hosts.length,
    total: merged.length,
    applied: merged.filter((r) => r.status === "applied").length,
    already: merged.filter((r) => r.status === "already").length,
    // failed 与 apply.host.failed 同一判据（含读写失败、含按 on-miss 钉死的 miss）；
    // 它与 notFound 有重叠 —— notFound 是 status 的条数，failed 是硬失败的条数，
    // 两个数不许相加。读写错误另给两个计数，直接与逐条 status 对账。
    failed: endCounts.failed,
    readError: endCounts.readError,
    writeError: endCounts.writeError,
    notFound: merged.filter((r) => r.status === "pattern_not_found").length,
    missingFile: merged.filter((r) => r.status === "missing_file").length,
    ms: Date.now() - startedAt,
    // 生效判据：这一轮真改了宿主读的文件 → 运行中的宿主进程读不到这些新字节，要重启。
    pendingRestart: pendingRestartOf(merged),
    // 与 pendingRestart 一起读：密封时连「新起的进程」也还读不到，得先换归档。
    asarSealed: asarSealedForLog(),
    // 引擎段收尾标记：所有宿主都打完了、汇总也写了。写审计的四个入口在这之后还会补一条
    // `audit.recorded`（它另盖 `runEnd:"audit"`）—— 两个阶段的标记各标各的，互不冒充。
    runEnd: "engine",
  });
  // 记一条安装指纹：哪个版本、以什么方式装的、每个文件的 sha256。
  // 目的不是审计，是让「手工覆盖过 node_modules」这件事**留下痕迹** ——
  // 否则下一次 pnpm install 会把它们静默盖回旧版，而现场没有任何证据说明曾经更新过。
  const install = recordInstallState(dshHomeForLog, {
    root: path.resolve(PLUGIN_DIR, ".."),
    version: String(pluginPkg().version || ""),
    method: process.env.DSH_PURGE_INSTALL_METHOD || "unknown",
  });
  note("install.record", {
    ok: install.ok,
    files: install.files,
    method: process.env.DSH_PURGE_INSTALL_METHOD || "unknown",
    path: install.path,
  });
  return {
    hosts,
    report: merged,
    hookDenyRestoreFailed,
    hookDenyRestoreChanged,
    evidence: collectApplyEvidence(hosts),
  };
}

export async function revertAllHosts(options = {}) {
  const reverted = [];
  const errors = [];
  const parities = [];
  const dshHomeForLog = String(options.dshHome || "").trim() || findDshHome();
  const startedAt = Date.now();
  // 显式 bases 是测试接缝：还原没有版本门禁，靠枚举跑一遍会真的动到本机宿主树。
  // `DSH_PURGE_REVERT_BASES` 是同一个接缝的命令行形态：自动化用例只能改一个夹具宿主，
  // 而 `--revert` 的入口不接受参数；不设这个变量时行为与原来完全一致（照常枚举）。
  const explicitBases = String(process.env.DSH_PURGE_REVERT_BASES || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const bases = Array.isArray(options.bases)
    ? options.bases.filter((base) => typeof base === "string" && base !== "")
    : explicitBases.length > 0
      ? explicitBases
      : enumeratePatchAiBases({ discover: options.discover !== false });
  diagLog("revert.start", { discover: options.discover !== false }, dshHomeForLog);
  for (const aiBase of bases) {
    try {
      const r = await revertAll(aiBase, options);
      reverted.push(...(r.reverted || []));
      // 还原是回滚路径，写清楚「哪个文件被覆盖回去」比写「成功」有用得多。
      for (const p of r.reverted || []) diagLog("revert.file", { base: aiBase, path: p }, dshHomeForLog);
      // 内容判据跟着落进 revert.end：计数说「动了几个文件」，ok / complete 与判红的文件
      // 才回答「回到原版没有」。不新开一条诊断事件，是因为事件名集合有门禁在守，
      // 而这条判据本来就属于「这一轮还原」的收尾结论。
      parities.push({ aiBase, ...(r.parity || {}) });
      for (const [p, e] of r.errors || []) {
        errors.push([p, e]);
        diagLog("revert.file.fail", { base: aiBase, path: p, error: String(e) }, dshHomeForLog);
      }
    } catch (e) {
      errors.push([aiBase, String(e && e.message ? e.message : e)]);
      diagError("revert.fail", e, { base: aiBase }, dshHomeForLog);
    }
  }
  const paritySummary = summarizeRevertParity(parities);
  diagLog("revert.end", {
    files: reverted.length,
    errors: errors.length,
    // 多宿主时「全部还原」= 每个宿主都 ok。有一台判红就不许说已还原。
    parityOk: paritySummary.ok,
    parityComplete: paritySummary.complete,
    // 判红的文件逐条写清「哪个文件、为什么」，否则「不一致」只是一句结论。
    parityMismatched: paritySummary.mismatched.map((pair) => `${pair[0]}=${pair[1]}`).join(","),
    parityUnscanned: paritySummary.unscanned.length,
    ms: Date.now() - startedAt,
  }, dshHomeForLog);
  return { reverted, errors, parity: parities };
}

/**
 * 带入口身份的一次还原：面板 / 命令 / 工具 / CLI 四个入口都从这里过。
 *
 * 还原的五条事件此前一条身份都没有 —— 真机上 82 条 `revert.*` 全部只能按时间猜
 * 是谁点的。身份走与 apply 同一条环境缝：入口只声明 `entry` 与 `runId`，
 * 五条事件在序列化前自动补齐；已经有身份就沿用，嵌套调用不许自造第二个 runId。
 *
 * @param {"http"|"command"|"tool"|"cli"} entry
 * @param {object} [options] 透传 revertAllHosts
 */
export async function revertAllHostsFor(entry, options = {}) {
  const ambient = currentApplyRun();
  const identity = ambient || { entry: String(entry || ""), runId: newApplyRunId() };
  return withApplyRun(identity, () => revertAllHosts(options));
}

export function dshBaseEnvStatus() {
  const raw = process.env.DSH_BASE;
  if (!raw || !String(raw).trim()) return { set: false, path: "", valid: false };
  const p = path.normalize(String(raw).trim());
  return { set: true, path: p, valid: isAiBase(p) };
}

export function missingAiBaseMessage() {
  const env = dshBaseEnvStatus();
  if (env.set && !env.valid) {
    return `DSH_BASE 已设置但不是有效的插件根（需要其下有 dsh-agent-instructions/lib）: ${env.path}`;
  }
  if (isDesktop()) {
    const exe = desktop.findDesktopAppExecutable();
    if (exe) {
      const asar = desktop.appAsarPath(exe);
      if (asarArchiveIsFile(asar) && desktop.isOfficialHarnessExecutable(exe)) {
        return `已找到 ${exe}。官方宿主在 app.asar 里，点「应用」会解开 ${desktop.appDirForExecutable(exe)} 并自动重启，不用另跑脚本。`;
      }
      return `已找到桌面应用 ${exe}，但其 resources/app（或 app.asar.unpacked）下没有 @deepseek-ai`;
    }
    return "未定位到当前桌面应用的 @deepseek-ai。官方客户端点「应用」会解开 app.asar 并重启；第三方 DSH Desktop 直接点「应用」。安装目录任意盘符。";
  }
  return "插件根未找到 / set DSH_BASE";
}

function aiBaseUnderAppDir(appDir) {
  const cands = [
    path.join(appDir, "dsh", "node_modules", "@deepseek-ai"),
    path.join(appDir, "node_modules", "@deepseek-ai"),
  ];
  return cands.find((p) => isAiBase(p)) || null;
}

export function sealedAsarHandoff(input = {}) {
 // ：本函数被 desktopAsarStillSealed / gatherState 等诊断路径调用，
  // 非桌面进程应得到 null（"没有密封包"），而不是抛错。
  const surface = input.surface ?? tryDetectSurface(input);
  if (!isDesktop(surface)) return null;
  const hinted = input.execPath;
  let exe = hinted && desktop.isDesktopExecutable(hinted)
    ? path.normalize(hinted)
    : desktop.findDesktopAppExecutable(input);
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  let asar = exe ? desktop.appAsarPath(exe) : "";
  if (!asarArchiveIsFile(asar) && resourcesPath) {
    const candidate = path.join(path.normalize(resourcesPath), "app.asar");
    if (asarArchiveIsFile(candidate)) {
      asar = candidate;
      if (!exe) {
        exe = desktop.findDesktopAppExecutable({ ...input, resourcesPath })
          || (desktop.isDesktopExecutable(process.execPath) ? path.normalize(process.execPath) : "")
          || path.normalize(process.execPath);
      }
    }
  }
  if (!exe || !asarArchiveIsFile(asar)) return null;
  // 官方密封包：已知 exe 名，或当前进程 resources 里就有 app.asar。
  if (
    !desktop.isOfficialHarnessExecutable(exe)
    && !(resourcesPath && asarArchiveIsFile(path.join(path.normalize(resourcesPath), "app.asar")))
  ) {
    return null;
  }
  return { exe, asar, swapAsar: true };
}

function unpackedAsarStampPath() {
  return path.join(findDshHome(), "dsh-purge", "unpacked-asar.json");
}

export function readUnpackedAsarStamp() {
  try {
    const raw = JSON.parse(hostFs.readFileSync(unpackedAsarStampPath(), "utf8"));
    const size = Number(raw.size);
    const mtimeMs = Number(raw.mtimeMs);
    if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) return null;
    return { size, mtimeMs };
  } catch {
    return null;
  }
}

export function writeUnpackedAsarStamp(identity) {
  if (!identity || !Number.isFinite(identity.size) || !Number.isFinite(identity.mtimeMs)) return;
  const fp = unpackedAsarStampPath();
  // H19:atomic write。stamp 半写坏会让下次启动误判 asar 未解包,重复解。
  atomicWriteSync(fp, `${JSON.stringify({ size: identity.size, mtimeMs: identity.mtimeMs })}\n`, "utf8");
}

/** 目录已经在用、归档不在时，记住旁边 .bak 的大小和时间。同一份再出现就不重新解。 */
export function rememberUnpackedArchive() {
  if (readUnpackedAsarStamp()) return;
  const exe = desktop.findDesktopAppExecutable();
  if (!exe || !desktop.isOfficialHarnessExecutable(exe)) return;
  const asar = desktop.appAsarPath(exe);
  if (!asar || asarArchiveIsFile(asar)) return;
  const ident = asarFileIdentity(`${asar}.bak`);
  if (ident) writeUnpackedAsarStamp(ident);
}

/** 当前目录还不能当宿主时，把升级脚本或上一次换目录挪走的那一份放回去。能用的目录不动。 */
function restoreUnusableExtract(appDir, prev) {
  if (aiBaseUnderAppDir(appDir)) return false;
  const saved = prev || newestPreservedDir(appDir);
  if (!saved) return false;
  return restoreExtractedDir(appDir, saved);
}

/** 官方 app.asar 解开到 resources/app。目录已能用且归档没变时直接改文件，不重新解包。 */
export async function openSealedDesktopHost(options = {}) {
  const handoff = sealedAsarHandoff();
  if (!handoff) return { aiBase: null, swapAsar: false, extracted: false, prev: "", appDir: "", archive: null };
  const appDir = desktop.appDirForExecutable(handoff.exe);
  const archive = asarFileIdentity(handoff.asar);
  const recorded = readUnpackedAsarStamp();
  let aiBase = aiBaseUnderAppDir(appDir);
  const asarStill = asarArchiveIsFile(handoff.asar);
  let extract = shouldExtractAsar({
    usable: Boolean(aiBase),
    identity: archive,
    recorded,
    upgrade: options.upgrade === true,
  });
  // 用户点「应用」：归档还在且 stamp 对不上当前 asar，或还没有可用 aiBase，必须先解包再洗。
  if (options.forApply === true && asarStill) {
    if (!aiBase || !archive || !sameAsarIdentity(archive, recorded)) extract = true;
  }
  let extracted = false;
  let prev = "";
  if (extract) {
    // H20:side 提到 try 外,commit 失败也能清掉半成品 side.next,不污染磁盘。
    let side = null;
    try {
      side = extractAsarToSide(handoff.asar, appDir);
      overlayAsarUnpacked(handoff.asar, side.next);
      if (!aiBaseUnderAppDir(side.next)) {
        try { hostFs.rmSync(side.next, { recursive: true, force: true }); } catch { /* 半成品留在旁边,不覆盖正在用的目录 */ }
        side = null;
        throw new Error(`已解开 ${handoff.asar},但里面没有 @deepseek-ai`);
      }
      const committed = commitExtractedDir(appDir, side.next);
      prev = committed.prev || "";
      extracted = true;
      side = null; // commit 成功,side.next 已被 rename
      aiBase = aiBaseUnderAppDir(appDir);
    } catch (error) {
      if (side && side.next) {
        try { hostFs.rmSync(side.next, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      try { restoreUnusableExtract(appDir, prev); } catch { /* 放回失败时旧目录仍留在旁边 */ }
      throw error;
    }
  } else if (aiBase) {
    overlayAsarUnpacked(handoff.asar, appDir);
    if (archive && !recorded) writeUnpackedAsarStamp(archive);
  }
  if (!aiBase) {
    restoreUnusableExtract(appDir, prev);
    throw new Error(`已解开 ${handoff.asar}，但 ${appDir} 下没有 @deepseek-ai`);
  }
  try {
    desktop.repairOfficialCliAfterUnpack(handoff.exe);
  } catch (e) {
    console.warn("[dsh-purge] repair official CLI after unpack failed:", e);
  }
  resetPathMemo();
  return { aiBase, swapAsar: true, exe: handoff.exe, asar: handoff.asar, extracted, prev, appDir, archive: extracted ? archive : null };
}

/** pending 目录：与 desktop 侧同一处（<DSH_HOME>/dsh-purge/shims）。 */
export function shimPendingDir() {
  return path.join(findDshHome(), "dsh-purge", "shims");
}

export function repairOfficialCliAfterUnpack(exe) {
  try {
    return desktop.repairOfficialCliAfterUnpack(exe);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

export function restoreSealedExtract(appDir, prev) {
  const saved = prev || newestPreservedDir(appDir);
  return restoreExtractedDir(appDir, saved);
}

/**
 * 把官方归档挪开，让下一次启动读解开的补丁树。
 *
 * 三个洞都在这一个函数里补，因为**交换本身不分手工与自动**：四条 apply 入口在干净收尾时
 * 都会走到这里（`lib/reapply.js` 的 `reapplyInstalled`），CLI 的 `--unseal` 也走这里。
 * 早先只有 CLI 那一条分支做前置检查与写标记，面板点「应用」这条最常见的路径一样没有 ——
 * 而它才是解封态成为稳态的原因。
 *
 *   1. **记下「我把归档挪走了」**：官方更新之后 `resources/app.asar` 不见了，用户问
 *      「谁删的」，能答的只有这份标记（`dsh-purge-unsealed.json`）。
 *      **只在知道发生了什么之后写**，且把结果写进去（`state`）：写早了会在「没挪成」的现场
 *      留下一句假供词 —— 归档还躺在原位、旁边却有一份「是我挪的」。
 *   2. **盘上有待装更新包时说出来**：官方更新器在后台下载、退出时装，装的时候会重写
 *      `resources` 并把 `runtime` 清空（实测：应用启动 fatal）。插件拦不住它，但可以把
 *      包路径、通道与装坏了怎么修写进诊断轨与返回面。
 *   3. **两个副作用都只在真的发生时记账**：`rename` / `schedule` 可注入，是为了让
 *      「没挪成」与「安排了但未确认」两档在本机就能判 —— 它们要真实占用文件才凑得齐。
 *
 * @param {{asar:string, exe?:string}} handoff
 * @param {{rename?:Function, schedule?:Function}} [deps] 测试注入用；缺省走真实重命名与空闲调度
 * @returns {{renamed:boolean, bak?:string, pending?:boolean, busy?:boolean,
 *   markerState?:("done"|"scheduled"|""),
 *   updatePending?:{installer:string, recovery:string, channel:string}|null}}
 */
export function scheduleSealedDesktopRestart(handoff, deps = {}) {
  if (!handoff?.asar) return { renamed: false };
  const rename = typeof deps.rename === "function" ? deps.rename : renameAsarAside;
  const schedule = typeof deps.schedule === "function" ? deps.schedule : desktop.scheduleAsarRenameWhenIdle;
  const resources = path.dirname(handoff.asar);
  // 尺寸必须在挪之前取：挪完这个路径就没了，而标记里那一份尺寸是「当时被挪走的是哪一份」的锚。
  let asarSize = 0;
  try {
    asarSize = fs.statSync(handoff.asar).size;
  } catch {
    asarSize = 0;
  }
  const updatePending = pendingOfficialUpdate(handoff.exe || "");
  const moved = rename(handoff.asar);
  // 三档结果，两档留标记：
  //   renamed           → state:"done"（真挪了）
  //   busy + 排上了      → state:"scheduled"（安排了空闲时挪，**未确认**）
  //   其余（归档本就不在 / 非占用型失败）→ 什么都不写：这一轮没发生任何值得归因的事
  let markerState = "";
  let pending = null;
  if (moved.renamed) {
    markerState = "done";
  } else if (moved.busy) {
    pending = schedule({ exe: handoff.exe, asar: handoff.asar });
    if (pending && pending.pending !== false) markerState = "scheduled";
  }
  if (markerState) {
    writeUnsealedMarker(resources, { asar: handoff.asar, size: asarSize, state: markerState });
  }
  if (updatePending) {
    diagLog("host.update.pending", {
      installer: updatePending.installer,
      recovery: updatePending.recovery,
      channel: updatePending.channel,
      asar: handoff.asar,
      // 写的是**结果**不是意图：`skipped` 表示这一轮归档没动过，别让读者以为解封发生了。
      outcome: markerState || "skipped",
    }, findDshHome());
    console.warn(
      `[dsh-purge] 盘上有待装官方更新包（${updatePending.channel || "未知通道"}）：${updatePending.installer}`,
    );
    console.warn(`[dsh-purge] 装完若应用起不来，执行：${updatePending.recovery}`);
  }
  if (moved.renamed || !moved.busy) return { ...moved, markerState, updatePending };
  return { renamed: false, pending: true, markerState, updatePending, ...pending };
}

export { hostPromptKeepsInject };

export function hostCleanMarkersPresent(aiBase) {
  if (!aiBase) return false;
  const fp = path.join(aiBase, "dsh-system-prompt", "lib", "index.js");
  try {
    return hostPromptKeepsInject(fs.readFileSync(fp, "utf8"));
  } catch {
    return false;
  }
}

function aiBaseBelongsToExe(aiBase, exe) {
  if (!aiBase || !exe) return false;
  const appDir = desktop.appDirForExecutable(exe);
  return Boolean(appDir && pathIsUnder(aiBase, appDir));
}

/** 密封官方包只认这份 exe 的 resources/app。旁边同名目录不算当前宿主。 */
export async function resolveOfficialAiBase(aiBase, options = {}) {
  const handoff = sealedAsarHandoff({ discover: options.forApply === true });
  if (!handoff?.exe) return { aiBase: aiBase || null, handoff: null };
  if (!options.forApply && aiBaseBelongsToExe(aiBase, handoff.exe)) return { aiBase, handoff };
  const opened = await openSealedDesktopHost({
    upgrade: options.upgrade === true,
    forApply: options.forApply === true,
  });
  return { aiBase: opened.aiBase || null, handoff: opened.swapAsar ? opened : handoff, extracted: opened.extracted };
}

/**
 * 重启前把清洗写进当前宿主。没写完就返回失败，调用方不得打开进程。
 *
 * @param {object} [options]
 * @param {(info:{bases:string[], aiBase:string|null}) => void} [options.onBeforeApply]
 *   动手前的只读观测钩子：审计的 before 摘要只有在这一刻采得到，
 *   采集失败或抛错都不许挡住 apply。`aiBase` 是主宿主根（与状态页同一个），
 *   `bases` 是按枚举顺序的全部根。
 * @returns {Promise<{ok:boolean, error?:string, aiBase?:string|null, pending?:string[],
 *   failed?:number, hosts?:string[], report?:Array<object>}>} `report` 是引擎的合并报告，
 *   给需要落审计的入口用；没有真正跑 apply 的路径是空数组。
 */
/**
 * 失败轮的解开的树是不是还压在官方归档后面。
 *
 * `resources/app` 与 `app.asar` 同时存在时宿主读归档 —— 补丁一处也不生效。这一档要跟
 * 「安装不完整」分开说：前者重跑一次应用就能接着做，后者要重装。判据只读归档在不在，
 * 读不出来（非桌面面）就按 false 处置，不猜。
 *
 * @param {string} aiBase 宿主插件根
 * @returns {boolean}
 */
function leftExtractResidue(aiBase) {
  if (!aiBase) return false;
  try {
    return desktopAsarStillSealed();
  } catch {
    return false;
  }
}

export async function ensureHostClean(options = {}) {
  applyRuntimeEnv();
  const onBeforeApply = typeof options.onBeforeApply === "function" ? options.onBeforeApply : null;
  let appliedReport = [];
  let appliedEvidence = emptyApplyEvidence();
  let aiBase = null;
  try {
    const located = await resolveOfficialAiBase(findAiBase());
    aiBase = located.aiBase || null;
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), aiBase: null, report: appliedReport, evidence: appliedEvidence };
  }
  if (!aiBase) return { ok: false, error: missingAiBaseMessage(), aiBase: null, report: appliedReport, evidence: appliedEvidence };

  /**
   * 逐宿主的 pending 集合。
   *
   * `evidence` 是本轮 apply 刚产出的证据：`patchesWritten`（真写过）与 `patchesSettled`
   * （核对过已经在目标态）。**这一轮的结论必须按这一轮的证据读** —— 账本要等这里判完
   * 才会写，拿旧账本读等于永远读不到「这一轮已经核对过」的那一半，于是 #2/#3/#50 这类
   * 没有可写字节的补丁永远 pending、apply 永不 clean、账本永远写不成（死循环）。
   * 证据只在本轮有效：它是刚刚按现场文件算出来的，不是账本里的历史。
   */
  const pendingAcross = async (bases, evidence = null) => {
    const ids = new Set();
    const identity = evidence ? identityWithEvidence(readPatchIdentity(), evidence) : null;
    for (const base of bases) {
      const status = identity ? await patchStatus(base, ALL_PATCHES, { identity }) : await patchStatus(base);
      for (const [id, state] of Object.entries(status)) {
        if (state === "pending") ids.add(id);
      }
    }
    return [...ids];
  };
  const snapshotHosts = (bases) => bases.map((b) => ({
    aiBase: b,
    hostWritten: hostCleanMarkersPresent(b),
    flash: silenceCmdFlash(b),
  }));

  const patchOpts = { preserveClientBundles: false, forApply: true };
  let bases = enumeratePatchAiBases({ discover: true });
  if (!bases.some((b) => path.normalize(b).toLowerCase() === path.normalize(aiBase).toLowerCase())) {
    bases = [aiBase, ...bases];
  }
  let allHosts = snapshotHosts(bases);
  let pending = await pendingAcross(bases);
  const needsApply =
    pending.length > 0 ||
    !allPatchHostsWritten(allHosts) ||
    !allHosts.every((h) => h.flash?.ok === true);

  if (needsApply) {
    if (onBeforeApply) {
      try {
        onBeforeApply({ bases: allHosts.map((h) => h.aiBase), aiBase });
      } catch {
        // 观测失败不挡 apply：审计的 before 缺失会由 completeness.files 记成缺口。
      }
    }
    const multi = await applyPatchesAllHosts(ALL_PATCHES, patchOpts);
    appliedReport = Array.isArray(multi.report) ? multi.report : [];
    appliedEvidence = multi.evidence || collectApplyEvidence(multi.hosts);
    allHosts = multi.hosts.length ? multi.hosts : allHosts;
    await patchAllShims();
    const summary = summarizeApplyReport(multi.report);
    pending = await pendingAcross(allHosts.map((h) => h.aiBase), appliedEvidence);
    const blocking = summary.failed.filter((row) => row.status !== "pattern_not_found");
    const flashOk = allHosts.every((h) => h.flash?.ok === true);
    if (pending.length || blocking.length || !flashOk) {
      return {
        ok: false,
        error: "清洗没有完成，已取消重启",
        pending,
        failed: blocking.length,
        aiBase,
        hosts: allHosts.map((h) => h.aiBase),
        report: appliedReport,
        evidence: appliedEvidence,
        // 失败轮把这一轮解开的树留在了 resources/app，而归档仍在原位 —— 宿主读的是官方
        // 归档，补丁一处也不生效。这是**失败轮残留**，不是「宿主安装不完整」：前者重跑
        // 一次应用就能接着做，后者要重装。读的人分不清就会照着 unseal 走，而那时启动的
        // 是一棵只打了一半的树。这里把事实带出去，由状态页与 CLI 说准。
        leftExtract: leftExtractResidue(aiBase),
      };
    }
  }
  if (!allPatchHostsWritten(allHosts)) {
    return {
      ok: false,
      error: "清洗没有写进全部宿主，已取消重启",
      aiBase,
      hosts: allHosts.map((h) => h.aiBase),
      report: appliedReport,
      evidence: appliedEvidence,
    };
  }
  return {
    ok: true,
    aiBase,
    pending: [],
    hosts: allHosts.map((h) => h.aiBase),
    report: appliedReport,
    evidence: appliedEvidence,
  };
}

/** 官方桌面仍在读 app.asar 时：结束进程、挪走 asar、再打开 exe（补丁在 resources/app 才生效）。 */
export function restartSealedDesktopIfNeeded(input = {}) {
  const handoff = sealedAsarHandoff(input);
  if (!handoff?.exe || !handoff?.asar) return { needed: false, renamed: true };
  if (!asarArchiveIsFile(handoff.asar)) return { needed: false, renamed: true };
  rememberDesktopInstallForHandoff(handoff);
  // input.ctx 透传给桌面层:restartOfficialHarness 内部 desktopRuntimeOf(ctx) 拿到 runtime
  // 用于 gracefulExit 优雅握手重启,降低宿主"host 退出 = crash"弹窗概率(#64)。
  if (process.platform === "win32" && desktop.isOfficialHarnessExecutable(handoff.exe)) {
    const restarted = desktop.restartOfficialHarness({ exe: handoff.exe, asar: handoff.asar, ctx: input.ctx });
    return { needed: true, renamed: false, asarSwap: true, ...restarted };
  }
  desktop.scheduleAsarSwapRestart({
    exe: handoff.exe,
    asar: handoff.asar,
    waitPid: process.pid,
    exit: true,
    ctx: input.ctx,
  });
  return { needed: true, renamed: false, asarSwap: true };
}

/** 自定义安装目录写入 DSH_HOME，便于下次 sealed handoff / 重启定位 exe。 */
export function rememberDesktopInstallForHandoff(handoff) {
  if (!handoff?.exe) return;
  const installDir = path.dirname(path.normalize(handoff.exe));
  if (!installDir || !desktop.isDesktopExecutable(handoff.exe)) return;
  try {
    const home = findDshHome();
    const fp = path.join(home, "dsh-purge", "desktop-install.txt");
    // M30:atomic write 一步到位。原来的 existsSync+read+write 存在 race,并发可能半写坏。
    const prev = hostFs.existsSync(fp) ? hostFs.readFileSync(fp, "utf8").trim() : "";
    const next = installDir.replace(/\\/g, "/");
    if (prev.replace(/\\/g, "/").toLowerCase() !== next.toLowerCase()) {
      atomicWriteSync(fp, `${next}\n`, "utf8");
    }
    if (!process.env.DSH_DESKTOP_INSTALL) process.env.DSH_DESKTOP_INSTALL = installDir;
  } catch {
    // 非致命
  }
}

export function desktopAsarStillSealed(input = {}) {
  const handoff = sealedAsarHandoff(input);
  return Boolean(handoff?.asar && asarArchiveIsFile(handoff.asar));
}


export function findOverrideFile(dshHome) {
  return path.join(dshHome, "prompt-inject.md");
}

let committedOverride = null;

/** 本次进程里提示词框刚提交的正文；与磁盘上用户自改正文合并使用。 */
export function rememberCommittedOverride(dshHome, text) {
  const home = path.normalize(String(dshHome || ""));
  if (!home) return;
  committedOverride = { home, text: typeof text === "string" ? text : "" };
}

/** $DSH_HOME/prompt-inject.md 原文。注入按文件原样，不改换行、不裁剪。 */
export function readPromptInjectFileSync(dshHome) {
  const fp = findOverrideFile(dshHome);
  try {
    if (fp && fs.existsSync(fp)) return fs.readFileSync(fp, "utf8").replace(/^\uFEFF/, "");
  } catch {
    /* 读失败当空 */
  }
  return "";
}

/** 仅本进程提示词框提交；重启后为空，注入改读 prompt-inject.md（#74）。 */
export function peekCommittedOverride(dshHome) {
  if (!committedOverride) return null;
  const home = path.normalize(String(dshHome || ""));
  if (home !== committedOverride.home) return null;
  return committedOverride.text;
}

let hungOperatorPromptText = "";

/** 本进程挂上的操作者正文。没有框里刚提交的字时，就是插件加密默认。 */
export function hangOperatorPrompt(text) {
  hungOperatorPromptText = typeof text === "string" ? text : "";
}

export function hungOperatorPrompt() {
  return hungOperatorPromptText;
}

/** 把本次解析到的主目录钉进环境变量，重启后的进程继续读这一份提示词。已有且不同的 DSH_HOME 不改。 */
export function pinDshHome() {
  const home = path.normalize(findDshHome() || "");
  if (!home) return "";
  const current = String(process.env.DSH_HOME || "").trim();
  if (!current) process.env.DSH_HOME = home;
  return path.normalize(findDshHome() || home);
}





export function rollupDisplayStatus(statuses) {
  const list = (statuses || []).filter(Boolean);
  if (list.length === 0) return "skipped";
  // 分组归桶也走权威表：哪几个状态算「跳过」、哪几个算「已做」不再由这里各判一次。
  // 失败必须排在最前面单列一档：原先它落到最后的 else，分组结论变成 skipped，
  // 于是设置页把这一组画成「没事」、计数也记进跳过。
  if (list.some((s) => displayBucketOf(s) === "fail")) return "failed";
  if (list.some((s) => displayBucketOf(s) === "pending")) return "pending";
  if (list.some((s) => displayBucketOf(s) === "unmatched")) return "unmatched";
  if (list.every((s) => displayBucketOf(s) === "skip")) return "skipped";
  if (list.some((s) => displayBucketOf(s) === "applied")) return "applied";
  return "skipped";
}

export function groupPatchesForDisplay(patches = ALL_PATCHES, patch_status = {}, surface) {
  const buckets = new Map();
  for (const p of patches) {
    if (!patchAppliesHere(p, surface)) continue;
    const st = patch_status[p.id];
    if (!st || st === "na") continue;
    const groupKey = DISPLAY_GROUP_BY_ID.get(p.id) || "";
    const key = groupKey || `solo:${p.id}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { lead: p, ids: [], statuses: [], groupKey };
      buckets.set(key, bucket);
    }
    bucket.ids.push(p.id);
    // 补丁声明了「没命中不算失败」时，折进分组前先降成 skipped：
    // 分组结论、色调与计数都按同一份降级后的状态算，三处不会各判一次。
    const soft = isSoftOk({ status: st }, p, onMissKind);
    bucket.statuses.push(st === "pattern_not_found" && soft ? "skipped" : st);
    if (p.id < bucket.lead.id) bucket.lead = p;
  }
  return [...buckets.values()]
    .sort((a, b) => a.lead.id - b.lead.id)
    .map((bucket) => ({
      id: bucket.lead.id,
      ids: bucket.ids,
      layer: bucket.lead.layer || "",
      status: rollupDisplayStatus(bucket.statuses),
      title: displayTitleOf(bucket.groupKey, bucket.lead),
    }));
}

/**
 * 设置页分组计数。
 *
 * 每一项都按权威表的归桶算，不再按 status 字符串现列：失败一组单独计数，
 * 既不冒充「跳过」，也不算进「就绪」（就绪问的是这一份安装还有没有缺活）。
 *
 * 实现搬到 `lib/patch/counts.js` 的 `displayCounts` 之后，这里是转发 ——
 * 「按行数」的口径只许有一处实现，否则同一屏的两个计数器又会各数一遍。
 */
export function tallyDisplayPatches(rows) {
  return displayCounts(rows);
}





function pathsOf(files, key) {
  const fp = files[key];
  if (fp == null || fp === "") return [];
  const list = Array.isArray(fp) ? fp : [fp];
  return list.filter((p) => p && fs.existsSync(p));
}

function flattenTargetPaths(files) {
  const out = [];
  for (const fp of Object.values(files)) {
    const list = Array.isArray(fp) ? fp : [fp];
    for (const p of list) {
      if (p && typeof p === "string" && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/**
 * client-hmr 按 mtime/ctime/size 轮询 exports["./client"]（官方 UI 包是 lib/client.js）。
 * 页面已经按旧 rev 要脚本时，再写这个文件会让缓存里的地址 404，输入框整串掉光（#63）。
 */
export function isWatchedClientBundle(fp) {
  const norm = String(fp || "").replace(/\\/g, "/");
  return /\/node_modules\/@[^/]+\/[^/]+\/lib\/client\.js$/.test(norm);
}

export function clientBundlePackageName(fp) {
  const norm = String(fp || "").replace(/\\/g, "/");
  const matched = norm.match(/\/node_modules\/(@[^/]+\/[^/]+)\/lib\/client\.js$/);
  return matched ? matched[1] : "";
}

/** 用户配置层：官方允许在 profiles/<name>/cordis.patch.yml 手写 insert，绝不能进 bak/回滚（#43）。 */
export function isUserProfilePatchFile(fp) {
  const n = String(fp || "").replace(/\\/g, "/").toLowerCase();
  return /\/profiles\/[^/]+\/cordis\.patch\.yml$/i.test(n);
}

/** 丢掉历史误建的 profile cordis.bak，不还原（保留用户当前文件）。 */
export async function dropStaleUserProfilePatchBackups(dshHome) {
  const home = String(dshHome || "").trim() || findDshHome();
  const dropped = [];
  const profilesRoot = path.join(home, "profiles");
  if (!isDir(profilesRoot)) return dropped;
  let names = [];
  try {
    names = fs.readdirSync(profilesRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return dropped;
  }
  for (const name of names) {
    const fp = path.join(profilesRoot, name, "cordis.patch.yml");
    const bak = `${fp}.dshpurge.bak`;
    if (!fs.existsSync(bak)) continue;
    try {
      await fsp.unlink(bak);
      dropped.push(bak);
    } catch {
      /* 下次再试 */
    }
  }
  return dropped;
}

const BAK_SUFFIX = ".dshpurge.bak";
const DSH_PURGE_MARKER_NEEDLE = "dsh-purge";

function sidecarBakPath(fp) {
  return `${fp}${BAK_SUFFIX}`;
}

/** 保险柜根：显式给了 dshHome 就用它，空串/未给才退回本机主目录。 */
function hostBakVaultRoot(dshHome) {
  const home = String(dshHome || "").trim() || findDshHome();
  return path.join(home, "dsh-purge", "host-backups");
}

function hostPathNorms(fp) {
  const norms = [];
  const push = (p) => {
    if (!p) return;
    const n = path.normalize(String(p)).replace(/\\/g, "/").toLowerCase();
    if (n && !norms.includes(n)) norms.push(n);
  };
  push(fp);
  try { push(fs.realpathSync(fp)); } catch { /* asar 虚路径或未落盘 */ }
  return norms;
}

function hostBakDigest(norm) {
  return createHash("sha1").update(norm).digest("hex").slice(0, 24);
}

function vaultBakPath(fp, dshHome) {
  const norms = hostPathNorms(fp);
  const key = norms[norms.length - 1] || norms[0] || "";
  return path.join(hostBakVaultRoot(dshHome), `${hostBakDigest(key)}.bak`);
}

function vaultBakCandidates(fp, dshHome) {
  const root = hostBakVaultRoot(dshHome);
  return hostPathNorms(fp).map((n) => path.join(root, `${hostBakDigest(n)}.bak`));
}

function tryReadBuf(fp) {
  try {
    const buf = fs.readFileSync(fp);
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  } catch {
    return null;
  }
}

function isOfficialSnapshotBuf(buf) {
  return Boolean(buf && buf.length > 0 && !buf.includes(DSH_PURGE_MARKER_NEEDLE));
}

function writeBufAtomic(fp, buf) {
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * 官方快照的**来源标记**白名单。
 *
 * 为什么要它：快照回答的是「这一版宿主的官方原文长什么样」，`patchVacuousOnOfficial`
 * 又拿它回答「这一版本来就带着产物吗」。快照若是某次带插件痕迹的现场存下来的，
 * 那个认证就是拿假证据做的。所以落盘时记下它是怎么来的，认证只认这三种来历：
 * - `asar`：从 app.asar 解出来比对过的原文；
 * - `official-unpack`：从官方解包树（未打补丁的干净副本）取的；
 * - `first-seen-clean`：落盘当时文件里没有任何本插件痕迹（`ensureOfficialSnapshot` 的门）。
 */
const OFFICIAL_SNAPSHOT_SOURCES = new Set(["asar", "official-unpack", "first-seen-clean"]);

/** 读快照的 meta（来源标记在里面）；读不到或坏掉返回 null。 */
function readVaultMeta(vaultFp) {
  try {
    const meta = JSON.parse(fs.readFileSync(vaultFp.replace(/\.bak$/i, ".json"), "utf8"));
    return meta && typeof meta === "object" ? meta : null;
  } catch {
    return null;
  }
}

function writeVaultMeta(vaultFp, fp, source) {
  const meta = vaultFp.replace(/\.bak$/i, ".json");
  try {
    const body = {
      path: path.normalize(fp),
      at: new Date().toISOString(),
    };
    if (source) body.source = String(source);
    atomicWriteSync(meta, `${JSON.stringify(body)}\n`);
  } catch { /* 还原仍可按 digest 找到 .bak */ }
}

/**
 * 官方原文快照：保险柜（`$DSH_HOME/dsh-purge/host-backups`）或旁边的 `.dshpurge.bak`。
 *
 * 两个候选都读，但**带可信来源的那一份优先**。早先的次序是「保险柜命中就返回」，而保险柜里
 * 可能躺着一份没有来源标记的备份 —— 它是「动手前照抄现场」留下的，不是官方原文。那一份会把
 * 旁边带来源的旁车挡住，于是「现场是不是原文打出来的」这一问拿现场自己当底，答案必然是假绿。
 *
 * 一份带可信来源的都没有时，退回第一份可读的：调用方自己会核来源
 * （`patchVacuousOnOfficial` 与 `verifyWithoutWrite` 都不认没有来源的那一份）。
 *
 * `sidecarOnly` 给「核对现场字节」那条判据用：保险柜那一份可能就是现场本身
 * （`ensureOfficialSnapshot` 第一次见到这个文件时照现场种子化的），那一档只看旁车。
 *
 * @param {string} fp 目标文件
 * @param {string} [dshHome] 保险柜所在主目录
 * @param {{sidecarOnly?:boolean}} [options]
 * @returns {{buf:Buffer, from:string, source:string|null}|null}
 */
function readOfficialSnapshot(fp, dshHome, options = {}) {
  if (!fp || isUserProfilePatchFile(fp)) return null;
  const candidates = [];
  if (options.sidecarOnly !== true) {
    for (const vault of vaultBakCandidates(fp, dshHome)) {
      const buf = tryReadBuf(vault);
      if (!isOfficialSnapshotBuf(buf)) continue;
      const meta = readVaultMeta(vault);
      candidates.push({ buf, from: vault, source: meta && typeof meta.source === "string" ? meta.source : null });
    }
  }
  // 旁车也可以带 meta（`.dshpurge.json`）：带上白名单里的来源，它才谈得上「官方原文」。
  const sidecar = sidecarBakPath(fp);
  const sideBuf = tryReadBuf(sidecar);
  if (isOfficialSnapshotBuf(sideBuf)) {
    const meta = readVaultMeta(sidecar);
    candidates.push({ buf: sideBuf, from: sidecar, source: meta && typeof meta.source === "string" ? meta.source : null });
  }
  if (candidates.length === 0) return null;
  const trusted = candidates.find((item) => item.source && OFFICIAL_SNAPSHOT_SOURCES.has(item.source));
  return trusted || candidates[0];
}

function writeOfficialSnapshot(fp, buf, dshHome, source = null) {
  const made = { vault: false, sidecar: false };
  if (!fp || !isOfficialSnapshotBuf(buf) || isUserProfilePatchFile(fp)) return made;
  // 快照的年代表进一位：自证缓存按它分代，重写过的保险柜不会把旧答案发出去。
  snapshotEpoch += 1;
  const vaultFp = vaultBakPath(fp, dshHome);
  try {
    const prev = tryReadBuf(vaultFp);
    if (!prev || !prev.equals(buf)) {
      writeBufAtomic(vaultFp, buf);
      made.vault = true;
    }
    writeVaultMeta(vaultFp, fp, source);
  } catch { /* 主目录不可写时再试旁边 bak */ }
  try {
    const side = sidecarBakPath(fp);
    const prev = tryReadBuf(side);
    if (!prev || !prev.equals(buf)) {
      writeBufAtomic(side, buf);
      made.sidecar = true;
    }
  } catch {
    /* app.asar 映出来的目录新建文件常 ENOENT，保险柜在就够 */
  }
  return made;
}

function listVaultEntries(dshHome) {
  const root = hostBakVaultRoot(dshHome);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return out; }
  for (const name of names) {
    if (!/\.json$/i.test(name)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
      const bak = path.join(root, name.replace(/\.json$/i, ".bak"));
      if (meta && meta.path) out.push({ path: String(meta.path), bak });
    } catch { /* 坏 meta 跳过 */ }
  }
  return out;
}

function ensureOfficialSnapshot(fp) {
  if (!fp || isUserProfilePatchFile(fp) || !fs.existsSync(fp)) return false;
  const existing = readOfficialSnapshot(fp);
  if (existing) {
    /* 已有快照原样搬进保险柜，来源标记照抄 —— 老快照没有标记就仍是「没标记」，认证那边会拒。 */
    writeOfficialSnapshot(fp, existing.buf, undefined, existing.source);
    return true;
  }
  /* 门：现场文本里已经有本插件的字样，就**不**把它当官方原文存下来（那会把污染源记成原文）。
     标记：能过这道门说明落盘当时是干净的，来源记 first-seen-clean。 */
  const buf = tryReadBuf(fp);
  if (!isOfficialSnapshotBuf(buf)) return false;
  const made = writeOfficialSnapshot(fp, buf, undefined, "first-seen-clean");
  return made.vault || made.sidecar;
}

function shouldRestoreOriginal(original, bak) {
  if (isUserProfilePatchFile(original)) return false;
  let bakStat;
  try {
    bakStat = fs.statSync(bak);
  } catch {
    return false;
  }
  if (!bakStat.isFile() || bakStat.size <= 0) return false;
  try {
    const st = fs.statSync(original);
    if (!st.isFile() || st.size > 0) return false;
  } catch (e) {
    if (!e || e.code !== "ENOENT") return false;
  }
  return true;
}

/**
 * 正式文件不见、或被写成空文件时，从旁边的 .dshpurge.bak 或保险柜拷回去。
 * 不删 bak。targetFiles 只认还在的文件，所以丢了以后还原/应用都看不见这份备份。
 * @returns 已拷回的正式路径
 */
export function restoreMissingOriginalsFromBak(aiBase) {
  const restored = [];
  if (!aiBase || !isDir(aiBase)) return restored;
  const seen = new Set();
  const consider = (original) => {
    if (!original || seen.has(original)) return;
    seen.add(original);
    const snap = readOfficialSnapshot(original);
    if (!snap || !shouldRestoreOriginal(original, snap.from)) return;
    try {
      writeBufAtomic(original, snap.buf);
      restored.push(original);
    } catch {
      /* 文件被占用时下次启动再试 */
    }
  };
  for (const fp of flattenTargetPaths(targetFiles(aiBase))) consider(fp);
  const roots = [aiBase];
  const nested = path.join(aiBase, "dsh", "node_modules", "@deepseek-ai");
  if (isDir(nested)) roots.push(nested);
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith("dsh-") && name !== "dsh") continue;
      const pkg = path.join(root, name);
      consider(path.join(pkg, "lib", "index.js"));
      consider(path.join(pkg, "cordis.patch.yml"));
      consider(path.join(pkg, "lib", "invariant.js"));
      consider(path.join(pkg, "lib", "types", "index.js"));
      consider(path.join(pkg, "lib", "types", "escalation.js"));
      consider(path.join(pkg, "src", "client.js"));
    }
  }
  return restored;
}

export function restoreMissingOriginalsAllHosts(options = {}) {
  const restored = [];
  const bases = options.boot === true
    ? [findAiBase()].filter((p) => p && isAiBase(p))
    : enumeratePatchAiBases({ discover: options.discover === true });
  for (const aiBase of bases) {
    try {
      restored.push(...restoreMissingOriginalsFromBak(aiBase));
    } catch {
      /* 一个宿主失败不挡住其余 */
    }
  }
  return restored;
}

/**
 * DSH 自升级会把宿主文件整个换成官方新版,但旁边的 .dshpurge.bak 不会动。
 * 老 bak 变过期后 revert 会把新版写回成老版。
 * current 不含 dsh-purge 且和快照不同 → 把快照刷成这份新官方原文。
 */
export function refreshStaleBaksForUpgrade(aiBase) {
  const refreshed = [];
  if (!aiBase || !isDir(aiBase)) return refreshed;
  const roots = [aiBase];
  const nested = path.join(aiBase, "dsh", "node_modules", "@deepseek-ai");
  if (isDir(nested)) roots.push(nested);
  const visit = (dir, depth) => {
    if (depth > 10) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) { visit(fp, depth + 1); continue; }
      if (!ent.isFile() || !ent.name.endsWith(BAK_SUFFIX)) continue;
      const original = fp.slice(0, -BAK_SUFFIX.length);
      if (isUserProfilePatchFile(original)) continue;
      let originalBuf;
      try {
        originalBuf = fs.readFileSync(original);
      } catch { continue; }
      if (originalBuf.includes(DSH_PURGE_MARKER_NEEDLE)) continue;
      try {
        // 刷新的这一份是「官方升级之后、还没被本插件碰过」的现场原文（上面那道门刚验过），
        // 所以来源记 `first-seen-clean`。漏了它，刷新出来的快照就没有来历，认证一律拒收 ——
        // 那正好把「官方换树」这一档的判据全废掉。
        const made = writeOfficialSnapshot(original, originalBuf, undefined, "first-seen-clean");
        if (made.vault || made.sidecar) refreshed.push(original);
      } catch {
        /* bak 被占用下次再试 */
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return refreshed;
}

/**
 * 给本机所有目标文件抓一份「官方原文」。
 *
 * `options.dshHome` 决定保险柜落点：不传就退回 findDshHome()（生产路径不变）。
 * 为什么必须能传：保险柜原先固定写真实 `~/.dsh/dsh-purge/host-backups`，于是
 * 「用临时 dshHome 跑一次 apply」的测试会把备份写进开发机的真保险柜 ——
 * 这一层写盘与调用方给的 dshHome 不一致，等于测试隔离在备份路径上是断的。
 *
 * @param {string} aiBase 宿主包根
 * @param {{dshHome?: string}} [options]
 */
export async function backupAll(aiBase, options = {}) {
  const dshHome = String(options.dshHome || "").trim();
  const files = targetFiles(aiBase);
  const made = [];
  const errors = [];
  const skippedUser = [];
  for (const fp of flattenTargetPaths(files)) {
    if (!fs.existsSync(fp)) continue;
    if (isUserProfilePatchFile(fp)) {
      skippedUser.push(fp);
      continue;
    }
    const existing = readOfficialSnapshot(fp, dshHome);
    if (existing) {
      // 来源要原样带回去：`writeVaultMeta` 只在收到非空 source 时才写那个字段，
      // 漏传一次就把快照的来源抹成「未知」，而认证只认白名单里的来历 ——
      // 两条不看账本的判据（空操作、现场自证）会从此长期失效，且没有任何症状。
      writeOfficialSnapshot(fp, existing.buf, dshHome, existing.source);
      continue;
    }
    const buf = tryReadBuf(fp);
    if (!isOfficialSnapshotBuf(buf)) {
      errors.push([fp, "already patched, no official backup"]);
      continue;
    }
    // 来源这一档与 `ensureOfficialSnapshot` 是同一道门：能走到这里说明**落盘当时**
    // 文件里没有任何本插件痕迹，所以来历就是「首次见到的干净原文」。漏记它等于让这份
    // 快照永远进不了认证 —— 两条不读账本的判据（空操作、现场自证）会一起长期失效。
    const wrote = writeOfficialSnapshot(fp, buf, dshHome, "first-seen-clean");
    if (wrote.vault || wrote.sidecar) made.push(fp);
    else errors.push([fp, "backup write failed"]);
  }
  const dropped = await dropStaleUserProfilePatchBackups(dshHome);
  return { made, errors, skippedUser, dropped };
}

function stripPurgePatchesFromText(text, fp = "") {
  const crlf = typeof text === "string" && text.includes("\r\n");
  const yaml = isYamlPath(fp);
  let out = asLf(text);
  let changed = false;
  for (const p of [...ALL_PATCHES].reverse()) {
    const applied = patchApplied(out, p);
    for (const { pattern, replace } of [...patchReplacements(p)].reverse()) {
      if (!pattern || typeof replace !== "string" || pattern instanceof RegExp) continue;
      if (yaml && isBareIdentityNeedle(pattern)) continue;
      const written = yaml ? yamlJsCommentsToHash(asLf(replace)) : asLf(replace);
      const needle = asLf(pattern);
      if (!written || written === needle || !out.includes(written)) continue;
      if (!written.includes(DSH_PURGE_MARKER_NEEDLE) && !applied) continue;
      out = out.split(written).join(needle);
      changed = true;
    }
  }
  if (!changed) return { text, changed: false };
  if (crlf) out = out.replace(/\n/g, "\r\n");
  return { text: out, changed: true };
}

function collectRevertTargets(aiBase, files) {
  const out = [];
  const seen = new Set();
  const add = (fp) => {
    if (!fp || seen.has(fp) || isUserProfilePatchFile(fp)) return;
    seen.add(fp);
    out.push(fp);
  };
  for (const fp of flattenTargetPaths(files)) add(fp);
  for (const entry of listVaultEntries()) {
    if (!entry.path || (aiBase && !pathIsUnder(entry.path, aiBase))) continue;
    add(entry.path);
  }
  return out;
}

/**
 * 「已还原」的内容判据：逐个目标文件比官方快照。
 *
 * 为什么需要它：`revertAll` 原先只返回四个计数（`reverted` / `skipped` /
 * `preservedUser` / `dropped`），于是「宿主文件回到原版了吗」这个问题只能由计数
 * 间接暗示 —— 一个文件被跳过、被占用、或者清洗痕迹没拆干净，计数照样好看。
 * 这条判据直接比字节：与快照一致才算还原，不一致判红。
 *
 * 三档结论，各自可见：
 *   matched   与官方快照逐字节相同
 *   mismatched 有快照但对不上，或没有快照却仍带本插件写的痕迹（那种文件不可能是官方原文）
 *   unscanned 没有快照、也不带痕迹：**不可判**，不许算通过
 *
 * @param {string} aiBase 宿主插件根
 * @returns {{ok:boolean, complete:boolean, checked:number, matched:string[],
 *   mismatched:Array<[string,string]>, unscanned:string[], missing:string[]}}
 *   `ok` = 没有可判红的文件；`complete` = 每个目标文件都有快照可比。
 *   两者都成立才叫「已还原」，只满足 `ok` 时还有「不可判」的余量。
 */
export function revertContentParity(aiBase) {
  const files = targetFiles(aiBase);
  const matched = [];
  const mismatched = [];
  const unscanned = [];
  const missing = [];
  for (const fp of collectRevertTargets(aiBase, files)) {
    const current = tryReadBuf(fp);
    if (!current) {
      missing.push(fp);
      continue;
    }
    const snap = readOfficialSnapshot(fp);
    if (snap) {
      if (current.equals(snap.buf)) matched.push(fp);
      else mismatched.push([fp, "differs-from-snapshot"]);
      continue;
    }
    if (current.includes(DSH_PURGE_MARKER_NEEDLE)) {
      mismatched.push([fp, "leftover-purge-marker"]);
      continue;
    }
    unscanned.push(fp);
  }
  return {
    ok: mismatched.length === 0,
    complete: unscanned.length === 0 && missing.length === 0,
    checked: matched.length + mismatched.length + unscanned.length + missing.length,
    matched,
    mismatched,
    unscanned,
    missing,
  };
}

export async function revertAll(aiBase, options = {}) {
  restoreMissingOriginalsFromBak(aiBase);
  const files = targetFiles(aiBase);
  const reverted = [];
  const skipped = [];
  const preservedUser = [];
  const errors = [];
  const preserveClientBundles = options.preserveClientBundles === true;
  for (const fp of flattenTargetPaths(files)) {
    if (!isUserProfilePatchFile(fp)) continue;
    const bak = sidecarBakPath(fp);
    if (fs.existsSync(bak)) {
      try {
        await fsp.unlink(bak);
        preservedUser.push(fp);
      } catch (e) {
        errors.push([fp, String(e)]);
      }
    }
  }
  for (const fp of collectRevertTargets(aiBase, files)) {
    if (preserveClientBundles && isWatchedClientBundle(fp)) {
      skipped.push(fp);
      continue;
    }
    const snap = readOfficialSnapshot(fp);
    const current = tryReadBuf(fp);
    if (snap) {
      try {
        if (current && current.equals(snap.buf)) {
          skipped.push(fp);
          continue;
        }
        writeBufAtomic(fp, snap.buf);
        // 来源原样搬回保险柜：还原之后这份快照还要继续当「官方原文」用，
        // 漏传一次就把它降级成「来历未知」，认证那边一律拒收。
        writeOfficialSnapshot(fp, snap.buf, undefined, snap.source);
        reverted.push(fp);
      } catch (e) {
        errors.push([fp, String(e)]);
      }
      continue;
    }
    // #106：没有官方快照时绝不删目标；有清洗痕迹则按补丁反拆。
    if (current && current.includes(DSH_PURGE_MARKER_NEEDLE)) {
      try {
        const stripped = stripPurgePatchesFromText(current.toString("utf8"), fp);
        if (stripped.changed) {
          await saveText(fp, stripped.text);
          reverted.push(fp);
          continue;
        }
      } catch (e) {
        errors.push([fp, String(e)]);
        continue;
      }
    }
    if (current) skipped.push(fp);
  }
  const dropped = await dropStaleUserProfilePatchBackups();
  // 还原完立刻判一次内容：计数说明「动了几个文件」，这一项才回答「回到原版没有」。
  return { reverted, skipped, preservedUser, dropped, errors, parity: revertContentParity(aiBase) };
}

// targetFiles 已搬到 lib/host/targets.js（SPEC 数据表 + 查表执行器）。
// YAML / persona 文本清洗已搬到 lib/prompt/text.js（纯函数，理由见那里的头注释）。

function patchApplied(text, patch) {
  const hay = asLf(text);
  if (patch?.id === 42 && legacyApplyPathStarts(hay) > 1) return false;
  if (patch?.id === 42 && hasStaleLegacyApplyCall(hay)) return false;
  if (Array.isArray(patch.forbid) && patch.forbid.some((marker) => hay.includes(asLf(marker)))) return false;
  if (Array.isArray(patch.markers) && patch.markers.length > 0) {
    // markersAny：任一标记即可；默认要全部命中。
    const match = patch.markersAny ? "some" : "every";
    return patch.markers[match]((marker) => hay.includes(asLf(marker)));
  }
  if (patch.marker) return hay.includes(asLf(patch.marker));
  if (typeof patch.replace === "string" && patch.replace.length > 0) {
    return hay.includes(asLf(patch.replace).split("\n")[0].slice(0, 60));
  }
  return false;
}

function cloneRegExp(pattern, global) {
  let flags = String(pattern.flags || "").replace("g", "");
  if (global) flags += "g";
  return new RegExp(pattern.source, flags);
}

/**
 * 账本 + 本轮证据 → 这一次判据要用的账本视图。
 *
 * 并三样清单：写过（`patchesWritten`）、核对过在目标态（`patchesSettled`）、以及
 * **逐文件核对记录**（`evidenceExcluded`，含补丁指纹与内容 sha）。指纹与内容指纹原样带过去：
 * 那两项回答的是「表还是那一版吗」「字节是不是收尾时那份」，与「这一轮核对了什么」无关。
 *
 * 为什么需要它：`ensureHostClean` 在写账本**之前**就要判一次 pending，而账本此刻还没有
 * 这一轮的核对证据。只按旧账本判，等于永远读不到「这一轮核对过」的那一半 —— 于是
 * 「apply 说已满足、状态说 pending」在**同一次运行内**就成立。三样一起并，本轮自己的
 * 结论才看得见本轮证据。
 *
 * @param {object} identity 现有账本（`readStampIdentity` 的形状）
 * @param {{patchesWritten?:string[], patchesSettled?:string[],
 *   excludedWrites?:Array<object>}} evidence 本轮证据
 * @returns {object} 合并后的账本视图
 */
function identityWithEvidence(identity, evidence) {
  const union = (left, right) => [...new Set([
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : []),
  ])];
  const rows = [
    ...(Array.isArray(identity?.evidenceExcluded) ? identity.evidenceExcluded : []),
    ...(Array.isArray(evidence?.excludedWrites) ? evidence.excludedWrites : []),
  ];
  // 本轮证据不只是「哪些补丁动过」这张清单，它还回答了「动它的是哪一版表」：跑这一轮的
  // 引擎拿的就是当前这份表，所以这些 id 的逐条指纹**当场**就是当前表的指纹。账本里的那一份
  // 是上一代的（跨代升级的第一轮必然如此），拿它去比等于让旧指纹否决本轮刚写下的字节 ——
  // 「真写过的补丁永远认证不了自己」正是这条漏出来的。
  //
  // 只覆盖本轮写过 / 核对过的 id：其余 id 保持账本原值，判据的强度一分没松。
  const patchShas = { ...(identity?.patchShas || {}) };
  const currentShas = patchFingerprints();
  for (const id of union(evidence?.patchesWritten, evidence?.patchesSettled)) {
    const key = String(id);
    if (currentShas[key]) patchShas[key] = currentShas[key];
  }
  // 内容指纹同理：文件本轮被重写过，账本里记的是**重写之前**那一份字节，拿它比必然不相等
  // （`contentKnown && !contentMatched` → pending），而这几个字节恰恰是本轮亲手写的。
  // 丢掉这几个键即「这一版表还没记过它的字节」——`contentKnown=false` 只让内容层不发言，
  // 不会把任一档判成已生效；下一轮收尾时按新字节重新记上。
  const contentSha = { ...(identity?.contentSha || {}) };
  for (const fp of Array.isArray(evidence?.filesWritten) ? evidence.filesWritten : []) {
    delete contentSha[fileContentKey(fp)];
  }
  return {
    ...identity,
    patchShas,
    contentSha,
    // 逐文件记录按「补丁 + 文件」去重，后到的覆盖先到的：同一轮里同一条补丁同一文件
    // 只该有一个结论，留最后算出来的那一份。
    evidenceExcluded: dedupeExclusionRows(rows),
    patchesWritten: union(identity?.patchesWritten, evidence?.patchesWritten),
    patchesSettled: union(identity?.patchesSettled, evidence?.patchesSettled),
  };
}

/**
 * 排除/核对记录去重：键是「补丁号 + 文件键」，后者与内容指纹表共用同一个归一。
 *
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
function dedupeExclusionRows(rows) {
  const out = [];
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const patch = String(row.patchId ?? row.patch ?? "").trim();
    const file = typeof row.file === "string" ? row.file : "";
    if (!patch || !file) continue;
    const normalized = {
      patch,
      patchSha: String(row.patchSha || ""),
      file,
      contentSha: String(row.contentSha || ""),
      verified: row.verified === true,
    };
    const key = `${patch}\u0000${file}`;
    if (index.has(key)) out[index.get(key)] = normalized;
    else {
      index.set(key, out.length);
      out.push(normalized);
    }
  }
  return out;
}

/**
 * 这条补丁在这个文件上还有没有活。
 *
 * 判据是「**再跑一次替换会不会改文本**」，不是「pattern 还能不能匹配」。后者对自匹配型
 * 替换恒真：替换产物仍以原 pattern 开头（#42 的 `configure(presentation, owner = this.ctx.fiber) {`
 * 尾巴、#3 的正则追加），文件早已打到目标态，pattern 却照样命中。真机后果不是显示问题：
 * `contentFileOutcome` 的第一条规则（还有活 → pending）把它钉成「待清洗」，于是每一轮
 * apply 都不算 clean、版本账本永不落、每次启动全量 revert+reapply。
 *
 * dry-run 必须传 `markerTrusted:false`：这一步问的是「替换会不会改文本」，不是「marker
 * 允不允许替换」。传 true 时 `skipIfMarked` 会在 marker 在场时短路整条替换，一个
 * 「marker 在、替换正文却没落到文本里」的文件会被误判成没有活 —— 那是假绿，比假红更难发现。
 *
 * 状态侧（`patchStatus` → `contentFileOutcome` 的 `worked`）与 apply 侧（`applyPatches`
 * 的逐文件分支）都只调这一个函数。两边各算一份正是「同一轮两个结论」的来源，别拆。
 *
 * @param {string} text 目标文件现场文本
 * @param {object} patch 补丁条目
 * @param {string} [fp] 文件路径（决定 YAML 分支与「无缩进 identity」豁免）
 * @returns {boolean} 再跑一次替换会改文本为 true
 */
function patchHasRemainingWork(text, patch, fp = "") {
  return applyReplacementsToText(text, patch, fp, { markerTrusted: false }).changed;
}

/**
 * 这条补丁 pattern 没命中时该怎么算。
 *
 * 归一前这件事由四个布尔字段（optional / softSettle / skipIfMarked / markersAny）
 * 加两个写死 id 的函数（isLayoutSoftPatch 认 4/25/26/5/11/12）共同决定，
 * 于是「没打上算不算失败」要读 4 个字段 + 2 个函数才能回答。
 *
 * 现在只有一个字段 `onMiss`，三值：
 *   "fail"   （缺省）pattern 没命中 = 清洗没做，整次 apply 判失败
 *   "warn"   算成功，但记进 soft 列表；同时允许「无残留 pattern 即算完成」
 *   "ignore" 算成功（真·可选：宿主这一版不需要这条补丁）
 *
 * `warn` 与 `ignore` 的区别不是「严重程度」，而是**完成判定**：
 *   warn 组在 filePatchSettled 里享受「无残留 pattern 就算完成」这一支
 *   （官方副本布局不同 / 审批句已被新版改写时，pattern 对不上但补丁目的已达成）；
 *   ignore 组不享受，pattern 对不上仍如实判 skipped。
 *
 * @param {{onMiss?: string}} patch
 * @returns {"fail"|"warn"|"ignore"}
 */
export function onMissOf(patch) {
  // 缺省口径的唯一实现在权威表旁边；这里只保留一个具名入口给引擎与测试用。
  return onMissKind(patch);
}

function filePatchSettled(text, patch, fp = "") {
  if (patchApplied(text, patch)) return true;
  // 官方副本布局不同、或审批句已被 0.1.5 改写时，没有残留 pattern 就算完成。
  // 只有 onMiss:"warn" 享受这一支；"fail"/"ignore" 不享受（见 onMissOf 的注释）。
  if (onMissOf(patch) === "warn") return !patchHasRemainingWork(text, patch, fp);
  return false;
}

/**
 * 单个文件上的补丁三态。
 *
 * 为 characterization 快照导出：`test/patch-characterization.test.mjs` 要用它对
 * **每一条补丁**在固定假宿主文本上取快照。这个函数此前是模块内私有，于是
 * 「82 条补丁在固定输入下各自判成什么」没有任何基线 —— 改语义只能盲改。
 *
 * @param {string} text 目标文件文本
 * @param {object} patch 补丁条目
 * @param {string} [fp] 文件路径（决定 YAML 分支与「无缩进 identity」豁免）
 * @returns {"applied"|"pending"|"skipped"}
 */
export function filePatchOutcome(text, patch, fp = "") {
  if (filePatchSettled(text, patch, fp)) return "applied";
  if (patchHasRemainingWork(text, patch, fp)) return "pending";
  // 原文对不上、再点应用也变不了：可选/布局软补丁显示跳过，不再假装待应用。
  return "skipped";
}

function fileKeysOf(p) {
  return Array.isArray(p.file) ? p.file : [p.file];
}

export function hookDenyPaths(aiBase) {
  const files = targetFiles(aiBase);
  const out = [];
  for (const p of ALL_PATCHES) {
    if (!hooksDeny.HOOK_DENY_PATCH_IDS.includes(p.id)) continue;
    for (const key of fileKeysOf(p)) {
      for (const fp of pathsOf(files, key)) {
        if (fp && !out.includes(fp)) out.push(fp);
      }
    }
  }
  return out;
}

function patchReplacements(p) {
  if (Array.isArray(p.replacements)) return p.replacements;
  return (p.patterns ?? []).map((pat) => ({ pattern: pat, replace: p.replace }));
}

function isBareIdentityNeedle(pattern) {
  const needle = asLf(pattern);
  if (!needle) return false;
  if (/^[ \t]/.test(needle)) return false;
  return /^You are a coding agent powered by\b/.test(needle);
}


/**
 * 把一条补丁的替换规则套到文本上。
 *
 * `options.markerTrusted` 决定 `skipIfMarked` 这道护栏听谁的：
 *   缺省 true —— 直调方（快照 / 单测 / 页面加载前的客户端 bundle 同步）沿用痕量语义；
 *   判据入口必须显式传账本结论 —— 表指纹或写入清单不认时传 false，marker 不再短路，
 *   pattern 命中就必须真替换。
 *
 * 护栏本身还有第二半：marker 在**且**再跑一次替换不会改文本时才短路（见函数内的注释）。
 * 只有痕量而不看「还有没有活」，会让共享 marker 的补丁（#73 借 #70 的 marker）永远跳过
 * 自己的替换 —— 那是 73 长期 pending 的根因。
 *
 * 插入型替换（`replace` 里含 `pattern`）另有一道按结果判重的护栏：忽略 marker 时
 * 如果直接把 pattern 再替换一次，文件会多出一份同样的插入片段（补丁 42、46 是这种形态）。
 * 判据是「替换结果已经在文本里」，不是「marker 在不在」—— 后者正是这次要拆开的用途。
 *
 * @param {string} text 目标文本
 * @param {object} patch 补丁条目
 * @param {string} [fp] 文件路径（决定 YAML 分支）
 * @param {{markerTrusted?:boolean}} [options] 引擎入口传账本判据
 * @returns {{text:string, changed:boolean}}
 */
export function applyReplacementsToText(text, patch, fp = "", options = {}) {
  const markerTrusted = options.markerTrusted !== false;
  let source = text;
  let preChanged = false;
  if (patch?.id === 42) {
    const collapsed = collapseDuplicateLegacyApplyPath(source);
    if (collapsed !== source) {
      source = collapsed;
      preChanged = true;
    }
    const rewritten = rewriteStaleLegacyApplyCall(source);
    if (rewritten !== source) {
      source = rewritten;
      preChanged = true;
    }
  }
  // `skipIfMarked` 是幂等护栏，不是「活干完了」的证据：只有「再跑一次替换也不会改文本」时才短路。
  // marker 只证明「某个痕量在」—— #73 的 marker 是 #70 写进同一个文件的，旧短路让它跳过自己的
  // 删除，镜线永远留着，`patchStatus` 于是永远 pending、apply 永不 clean。
  // 内层 dry-run 必须 `markerTrusted:false`：传 true 会递归回这一条分支。
  if (patch.skipIfMarked && markerTrusted && patchApplied(source, patch)) {
    const residual = applyReplacementsToText(source, patch, fp, { markerTrusted: false });
    if (!residual.changed) return { text: source, changed: preChanged };
  }
  const crlf = typeof source === "string" && source.includes("\r\n");
  const yaml = isYamlPath(fp);
  let out = asLf(source);
  let changed = false;
  // 「进入函数时 marker 就在」与「本次替换过程中刚插入 marker」是两件事：后者不该让
  // 同一条补丁后面的插入片段被误判成重复。快照只在循环前取一次。
  const markerAtEntry = !markerTrusted && patchApplied(source, patch);
  for (const { pattern, replace } of patchReplacements(patch)) {
    if (!pattern || typeof replace !== "string") continue;
    // YAML 块标量行首有缩进；无缩进 identity+\n\n 会留下 6 空格，再和下一段拼成 12 空格。
    if (yaml && isBareIdentityNeedle(pattern)) continue;
    const written = yaml ? yamlJsCommentsToHash(asLf(replace)) : asLf(replace);
    // 正则 pattern：用于自匹配型替换（产物包含原 pattern，如 timeoutMs 追加 0）。
    if (pattern instanceof RegExp) {
      const re = cloneRegExp(pattern, true);
      re.lastIndex = 0;
      if (!re.test(out)) continue;
      re.lastIndex = 0;
      // 用字符串形态调用：保留 $1..$9 展开语义（回调形态会把 "$1" 当字面量写进文件）。
      const next = out.replace(re, written);
      if (next === out) continue;
      out = next;
      changed = true;
      continue;
    }
    const needle = asLf(pattern);
    if (!out.includes(needle)) continue;
    // 插入型替换的产物一定包含原 pattern；同一份产物已经在文本里时再替换一次只会
    // 多出一份。这一条只在产物确实包含 pattern 时生效，纯替换不受影响。
    if (written.includes(needle)) {
      if (out.includes(written)) continue;
      // 产物不在、marker 却在：文本里是**上一版**的插入片段。这时直接替换会在旧片段
      // 旁边再插一份，文件语法就坏了；留给待应用状态，让人先还原再重打。
      if (markerAtEntry && patchApplied(out, patch)) continue;
    }
    const next = out.split(needle).join(written);
    if (next === out) continue;
    out = next;
    changed = true;
  }
  if (crlf) out = out.replace(/\n/g, "\r\n");
  return { text: out, changed: changed || preChanged };
}

// 逐补丁汇总（pending 优先、onMiss 与 strictFiles 两个轴）已搬到 lib/patch/rollup.js。
// 状态侧与 apply 侧共用那一份 —— 两套口径各算一遍正是「同一轮两个结论」的来源。

/**
 * 这条补丁在当前宿主面适不适用。
 *
 * 现在 `adapterFor` 对非 desktop 抛错，但本函数是**纯判定**：
 * 问「这条补丁在 web 上适用吗」应得到 false，而不是异常。
 * 所以这里直接比对 surface 值，不经过 adapterFor。
 *
 * 默认参数仍用 detectSurface() —— 在桌面宿主上它会正常返回 "desktop"；
 * 在非桌面进程上它抛错，那时调用方本来也不该走到补丁逻辑（更早就会被拦）。
 */
export function patchAppliesHere(patch, surface = detectSurface()) {
  const want = patch?.surfaces;
  if (!Array.isArray(want) || want.length === 0) return true;
  return want.includes(surface);
}

/**
 * 这条补丁的失败算不算「能放过」。
 *
 * 归一前这里是三段 if：`p.optional` / `isLayoutSoftPatch(p)` / `p.strictFiles`，
 * 每个都在问同一个问题的不同一半。现在只剩 `onMiss` 一个字段 + strictFiles 一个覆盖。
 *
 * 注意 `summarizeApplyReport` 把它分到 `soft` 还是 `failed` 决定面板显示什么、
 * 也决定 `complete` 那个布尔 —— 所以这条函数是「静默失效」的唯一出口，
 * 改它必须同时看 characterization 快照的第 6 列。
 */
export function isPatchResultSoftOk(row, patch = null) {
  // 判定本体在 lib/patch/status.js 的 isSoftOk；这里只做两件核心才知道的事：
  // 没给定补丁时按 id 去补丁表里查，以及把 onMissOf 递给它 —— 权威模块是叶子，
  // 不许认识补丁表，也不许自己实现一遍 onMiss 的缺省值。
  const p = patch || ALL_PATCHES.find((x) => x.id === (row && row.patch_id) || x.id === (row && row.id));
  return isSoftOk(row, p, onMissOf);
}

export function summarizeApplyReport(report, patches = ALL_PATCHES) {
  const byId = new Map(patches.map((p) => [p.id, p]));
  const failed = [];
  const soft = [];
  for (const row of report) {
    const patch = byId.get(row.patch_id) || byId.get(row.id);
    if (isPatchResultSoftOk(row, patch)) soft.push(row);
    else failed.push(row);
  }
  return {
    failed,
    soft,
    applied: report.filter((r) => r.status === "applied").length,
    already: report.filter((r) => r.status === "already").length,
  };
}

async function loadText(p) {
  return fsp.readFile(p, "utf8");
}

async function saveText(p, text) {
  const next = Buffer.from(text, "utf8");
  try {
    const current = await fsp.readFile(p);
    if (current.equals(next)) return false;
  } catch (e) {
    if (!e || e.code !== "ENOENT") throw e;
  }
  // H19:原子写,断电/EBUSY 不留半文件。
  await atomicWriteFile(p, next);
  return true;
}

export const hookDenyIo = {
  hookDenyPaths,
  loadText,
  saveText,
};

let hooksDenySettings = null;
let hooksDenyConfigValue;

export function setHooksDenyConfigValue(value) {
  hooksDenyConfigValue = value;
}

export function refreshHooksDenySettings() {
  hooksDenySettings = Object.freeze(
    hooksDeny.loadHookDenySettings(findDshHome(), hooksDenyConfigValue),
  );
  return hooksDenySettings;
}

export function getHooksDenySettings() {
  if (!hooksDenySettings) return refreshHooksDenySettings();
  return hooksDenySettings;
}

export function setHooksDenySettings(patch) {
  const saved = hooksDeny.saveHookDenySettings(findDshHome(), patch);
  hooksDenySettings = Object.freeze({ hooksDenyBypass: saved.hooksDenyBypass });
  return saved;
}

export async function restoreHookDenyForBases(bases) {
  const failed = [];
  const changed = [];
  for (const aiBase of bases || []) {
    const r = await hooksDeny.restoreHookDenyOfficial(aiBase, hookDenyIo);
    changed.push(...r.changed);
    failed.push(...r.sentinelLeft, ...r.misses);
  }
  return { changed, failed };
}

async function repairPluginCordisYaml() {
  const fp = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cordis.patch.yml");
  if (!isFile(fp)) return;
  const text = await loadText(fp);
  const cleaned = sanitizeYamlPersonaScalars(text);
  if (cleaned !== text) await saveText(fp, cleaned);
}

export async function applyPatches(aiBase, patches = ALL_PATCHES, options = {}) {
 // ：版本门禁。不匹配就拒绝应用，而不是打一堆匹配不到的补丁然后静默失效。
  const versionGate = checkHostVersionGate(aiBase, options);
  if (!versionGate.allowed) {
    const error = new Error(versionGate.reason + (versionGate.hint ? ` ${versionGate.hint}` : ""));
    error.code = "DSH_PURGE_HOST_VERSION_MISMATCH";
    error.gate = versionGate;
    throw error;
  }
  restoreMissingOriginalsFromBak(aiBase);
  refreshStaleBaksForUpgrade(aiBase);
  const files = targetFiles(aiBase);
  const report = [];
  const preserveClientBundles = options.preserveClientBundles === true;
  // 核对 client bundle 时要读官方原文快照：保险柜跟着本轮 dshHome 走，临时 home 的用例
  // 不会去翻开发机的真账本。
  const evidenceHome = String(options.dshHome || "").trim() || findDshHome();
  // 账本判据在 applyPatchesAllHosts 那一层已经按宿主取过一次；这里允许注入是为了让
  // 合成宿主用例不必读写真实主目录。缺省读现场账本，与状态侧同一份解析。
  const identity = options.identity && typeof options.identity === "object"
    ? readStampIdentity(options.identity)
    : readPatchIdentity();
  // 同一次 apply 里同一个文件会被多条补丁问到：原文快照的「空操作」判定只算一次。
  const vacuousCache = new Map();
  // 文件级自证按「文件 + 现场字节」缓存：这条循环里同一个文件会被多条补丁问到，而每条补丁
  // 落盘之后文本就变了 —— 缓存键必须带字节，只按路径缓存会把上一轮文本的结论发给下一轮。
  const proofOf = (fp, text) => fileContentProofCached(fp, text, patches, evidenceHome);
  await repairPluginCordisYaml();
  for (const p of patches) {
    if (!patchAppliesHere(p)) {
      report.push({
        patch_id: p.id,
        name: p.name,
        status: "na",
        path: "",
        applied: 0,
        already: 0,
        missing: 0,
      });
      continue;
    }
    const trusted = patchTableTrusted(identity, p);
    const keys = fileKeysOf(p);
    const paths = [];
    const outcomes = [];
    const writtenFiles = [];
    // 自愈轮跳过、且核对过的文件：与 written_files 并列，绝不相加。
    const excludedFiles = [];
    let written = 0;
    let already = 0;
    let missing = 0;
    let lastError = null;
    let reason = "";
    // 逐文件累加的「核对过在目标态」：任何一个文件不成立，这一条补丁就不算核对过。
    let certifiedAll = true;
    for (const key of keys) {
      const fps = pathsOf(files, key);
      if (fps.length === 0) {
        missing += 1;
        continue;
      }
      for (const fp of fps) {
        paths.push(fp);
        let text;
        try {
          text = await loadText(fp);
        } catch {
          lastError = "read_error";
          continue;
        }
        ensureOfficialSnapshot(fp);
        // 这一版表在这份文件上还有没有活：dry-run 判据，与 patchStatus 同一个函数。
        // 分支里多处要用它，先算一次 —— 它要真跑一遍替换，别按分支重复调用。
        const remaining = patchHasRemainingWork(text, p, fp);
        // 「没有可写的字节」时先问一句：这份现场字节是不是**这一版表**套在官方原文上
        // 的那份产物？这一问不读账本，只用保险柜里的官方原文 —— 所以它在**跨代表升级的
        // 那一轮**就能答，而账本要等轮末才写。少了它，「文件早在目标态」的补丁只能靠账本
        // 认证，而账本又只在干净轮写、pending 又让这一轮不干净：跨代第一次 apply 永远
        // 收敛不了（远端实测要跑两次）。
        const verifyRecord = remaining === false
          ? verifyWithoutWrite(fp, text, p, evidenceHome, proofOf(fp, text))
          : null;
        const verifiedHere = verifyRecord?.verified === true;
        if (verifiedHere) excludedFiles.push(verifyRecord);
        // 认证三半：账本认（写入/核对记录）、内容自证（本轮的 verify 记录）、或这条补丁对
        // 这一版宿主本来就无事可做（官方原文里本来就有这段产物）。
        const certifiedHere = verifiedHere
          || patchCertifiedByContent(identity, p, fp, text, remaining)
          || patchVacuousOnOfficial(identity, p, fp, evidenceHome, vacuousCache);
        // marker 在、但三半证据都不认它：这一档的结论不能是「本来就打上了」。
        // 记待应用并把原因写进报告，读者才知道该重打还是该修表。
        const markerUnbacked = patchApplied(text, p) && !patchFileTrusted(identity, p, fp) && !certifiedHere;
        // 这一条补丁的「核对过」按文件累加：**这一版表不碰的文件**（没 marker、也没活）不挡认证，
        // 只有「还有活」或「指纹对不上」才挡 —— #50 就是两个文件已到位、第三个文件本就不适用。
        certifiedAll = certifiedAll && (certifiedHere || (!patchApplied(text, p) && !remaining));
        // 启动自愈才跳过。点应用/重启若也跳过，client.js 上的补丁会一直 pending，重启被取消。
        if (preserveClientBundles && isWatchedClientBundle(fp)) {
          // 这一轮没写它，但可以核对它是不是这一版表的产物 —— 上面的 verify 记录就是这份核对。
          // 记录一律留（含 `verified:false`）：读的人要能分清「没写它」与「核对没过」。
          if (!verifiedHere) {
            excludedFiles.push(verifyRecord || verifyWithoutWrite(fp, text, p, evidenceHome, proofOf(fp, text)));
          }
          // bundle 的认证走 evidenceExcluded（绑补丁指纹 + 内容 sha），不进「核对过在目标态」那份清单。
          certifiedAll = false;
          const trustedHere = trusted || verifiedHere;
          if (filePatchSettled(text, p, fp) && (!patchApplied(text, p) || trustedHere)) {
            already += 1;
            outcomes.push(FILE_OUTCOME.applied);
          } else if (patchApplied(text, p) && !trustedHere) {
            outcomes.push(FILE_OUTCOME.pending);
            reason = "marker-untrusted-no-anchor";
          } else {
            outcomes.push(remaining ? FILE_OUTCOME.pending : FILE_OUTCOME.skipped);
          }
          continue;
        }
        const appliedText = applyReplacementsToText(text, p, fp, { markerTrusted: trusted });
        let textOut = appliedText.text;
        let changed = appliedText.changed;
        if (isYamlPath(fp)) {
          const cleaned = sanitizeYamlPersonaScalars(textOut);
          if (cleaned !== textOut) {
            textOut = cleaned;
            changed = true;
          }
        }
        if (changed) {
          certifiedAll = false;
          try {
            const wrote = await saveText(fp, textOut);
            if (wrote) {
              written += 1;
              writtenFiles.push(fp);
              outcomes.push(FILE_OUTCOME.applied);
            } else {
              already += 1;
              outcomes.push(FILE_OUTCOME.applied);
            }
          } catch (e) {
            lastError = `write_error:${e}`;
          }
          continue;
        }
        if (filePatchSettled(text, p, fp) && !markerUnbacked) {
          already += 1;
          outcomes.push(FILE_OUTCOME.applied);
        } else if (markerUnbacked) {
          // 表指纹/写入清单不认 marker，pattern 也没命中：旧正文里没有可替换的锚点。
          // 既不能说「已生效」，也不能说「这一版不需要」—— 落待应用，等人重打或修表。
          outcomes.push(FILE_OUTCOME.pending);
          reason = remaining ? "marker-untrusted-with-work" : "marker-untrusted-no-anchor";
        } else {
          // 「原文还在」与「原文对不上」是两件事：前者再点一次应用会有动作，后者不会。
          // 判据合进同一份汇总，见 lib/patch/rollup.js 的次序说明。
          outcomes.push(remaining ? FILE_OUTCOME.pending : FILE_OUTCOME.skipped);
        }
      }
    }
    const verdict = rollupPatchStatus({
      outcomes,
      written,
      missing,
      keyCount: keys.length,
      lastError,
      onMiss: onMissOf(p),
      strictFiles: !!p.strictFiles,
    });
    // 软补丁遗留的工作仍按旧口径记软：onMiss 说「这一版不需要」，那条判断没变。
    // 不这么映射的话，一条 warn 补丁的残留 pattern 会把整轮 apply 判成没洗完。
    const status = verdict === "pending" && onMissOf(p) !== "fail" ? "pattern_not_found" : verdict;
    // 「核对过在目标态」：每个目标文件都在、都没读错、这一轮一个字节都没写，内容也已经是这一版表的目标态。
    // 它是 patchesWritten 之外的第二半认证原料 —— 远端 #2/#3/#50 只能靠这一条落进账本。
    const settledInTargetState = written === 0
      && missing === 0
      && outcomes.length > 0
      && certifiedAll;
    report.push({
      patch_id: p.id,
      name: p.name,
      status,
      path: paths[0] || files[keys[0]],
      applied: written,
      already,
      missing,
      // 本轮真写过的文件：写戳只按这份清单记账，没写过的文件不许进内容指纹表。
      written_files: writtenFiles,
      ...(excludedFiles.length > 0 ? { excluded_files: excludedFiles } : {}),
      ...(settledInTargetState ? { settled: true } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  return report;
}

/**
 * 「这一轮没写它，但现场字节就是这一版表的产物」的核对记录。
 *
 * 判据是「拿官方原文快照当底，把这一版补丁的替换套一遍，结果与现场逐字相同」。
 * 只看 marker 不够 —— 正文换代而 marker 不变的形态正是判据要挡的那种假绿；
 * 反过来，只认账本也不够 —— 账本要等轮末才写，跨代表升级的那一轮它还没有这一版的指纹。
 *
 * 这条记录**自带三样可重算的依据**（补丁指纹 / 文件键 / 内容 sha256），所以读侧不需要
 * 相信写侧的任何结论：任何一项对不上就回落。`verified:false` 的记录只是「没写它」这一条
 * 事实，读侧不会拿它认证。
 *
 * 早先它只服务 `preserveClientBundles` 那条旁路（client bundle 不能写），现在所有
 * 「没有可写字节」的文件都走它 —— 同一份核对，没理由只对一类文件成立。
 *
 * @param {string} fp 目标文件绝对路径
 * @param {string} text 现场文本
 * @param {object} patch 补丁条目
 * @param {string} dshHome 官方原文快照保险柜所在的主目录
 * @returns {{patchId:string, patchSha:string, file:string, verified:boolean, contentSha:string}}
 */
function verifyWithoutWrite(fp, text, patch, dshHome, proof = null) {
  const file = fileContentKey(fp);
  const base = { patchId: String(patch?.id), patchSha: patchFingerprint(patch), file };
  const unverified = { ...base, verified: false, contentSha: "" };
  if (!patchApplied(text, patch)) return unverified;
  if (patchHasRemainingWork(text, patch, fp)) return unverified;
  // 文件级自证先行：它证明的是「这份文件的字节就是这一版表打出来的」，比单条补丁的重放强，
  // 也是同一文件上多条补丁（后一条改写前一条的产物）唯一答得出来的形态。
  if (proof) return { ...base, verified: true, contentSha: proof.contentSha };
  let snapshot = readOfficialSnapshot(fp, dshHome);
  if (!snapshot) return unverified;
  // 保险柜那一份可能就是现场本身（首次见到这个文件时照现场种子化的）。那一份答不了
  // 「现场是不是原文打出来的」，退回旁车再问一次；旁车也没有就判「核对不了」。
  const textBuf = Buffer.from(String(text), "utf8");
  if (snapshot.buf.equals(textBuf)) {
    snapshot = readOfficialSnapshot(fp, dshHome, { sidecarOnly: true });
    if (!snapshot || snapshot.buf.equals(textBuf)) return unverified;
  }
  // 来源不可信的快照不许当底：没有 source、或 source 不在白名单里，直接判「核对不了」。
  // 这一条与 `patchVacuousOnOfficial` 的门是同一道 —— 拿一份被污染的快照重放，
  // 算出来的「一致」只是把我们自己的产物当成官方原文，那是假绿里最贵的一种。
  if (!OFFICIAL_SNAPSHOT_SOURCES.has(String(snapshot.source || ""))) return unverified;
  let expected = applyReplacementsToText(snapshot.buf.toString("utf8"), patch, fp, { markerTrusted: false }).text;
  if (isYamlPath(fp)) expected = sanitizeYamlPersonaScalars(expected);
  if (expected !== text) return unverified;
  return {
    ...base,
    verified: true,
    contentSha: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
  };
}

/**
 * 逐文件内容自证：`apply(官方原文, 这一版表) == 现场字节`。
 *
 * 为什么自证的单位必须是**文件**而不是单条补丁：同一文件上后一条补丁会改写前一条的产物
 * （id 84 在 id 83 插下的那段里又插两行；id 56 的第一条替换被自己的后三条改写）。按单条
 * 补丁重放官方原文，得到的必然是「只有这一条生效」的那份文本，与现场永远对不上 ——
 * 于是这些补丁在换表后的第一轮既过不了账本（账本还是旧指纹）、也过不了内容自证，
 * 而它们其实一条不缺地落在文件里。判据问错了问题，答案是红的，文件是好的。
 *
 * 换成文件级以后，问的就是那个真问题：**这份文件现在是不是这一版表的产物**。它对同一文件上
 * 任何条数的补丁都成立，且不依赖它们互相之间谁改写了谁。
 *
 * 按**整张表**重放而不是「本文件上的那几条」：一来顺序天然与引擎落盘一致，二来不必再维护
 * 一份「哪个补丁落在哪个文件」的映射（那份映射一旦与实际漂开，这里的结论就无从复核）。
 * 不落在本文件的补丁在这里至多是空操作；万一它真的改动了本文件的文本，结论只会是
 * 「对不上」（退回单条重放），不会把一份不是目标态的字节判成目标态。
 *
 * 两道门不许松：快照来源必须在白名单里（拿被污染的快照重放 = 把自己的产物当原文），
 * 且快照不能就是现场本身（照现场种子化的那一份答不了「现场是不是原文打出来的」）。
 *
 * @param {string} fp 目标文件绝对路径
 * @param {string} text 现场文本
 * @param {Array<object>} patches 这一版表（**与引擎落盘同一份清单、同一顺序**）
 * @param {string} dshHome 官方原文快照保险柜所在的主目录
 * @returns {{contentSha:string}|null} 成立给字节指纹，不成立 / 核对不了给 null
 */
function fileContentProof(fp, text, patches, dshHome) {
  // 这里**不**查宿主面：调用方（apply 循环 / patchStatus / 只读探针）已经按面筛过它给的那份表，
  // 而只读探针与判据用例跑在非宿主进程里，查面会直接把它们打成异常。
  // 表里万一混进一条不适用本宿主的补丁，它的替换在这里至多是空操作；真改动了文本，
  // 结论只会是「对不上」并退回单条重放 —— 不会把非目标态的字节判成目标态。
  const list = (Array.isArray(patches) ? patches : []).filter((patch) => patch && fileKeysOf(patch).length > 0);
  if (list.length === 0) return null;
  let snapshot = readOfficialSnapshot(fp, dshHome);
  if (!snapshot) return null;
  const textBuf = Buffer.from(String(text), "utf8");
  if (snapshot.buf.equals(textBuf)) {
    snapshot = readOfficialSnapshot(fp, dshHome, { sidecarOnly: true });
    if (!snapshot || snapshot.buf.equals(textBuf)) return null;
  }
  if (!OFFICIAL_SNAPSHOT_SOURCES.has(String(snapshot.source || ""))) return null;
  let expected = snapshot.buf.toString("utf8");
  for (const patch of list) {
    expected = applyReplacementsToText(expected, patch, fp, { markerTrusted: false }).text;
    if (isYamlPath(fp)) expected = sanitizeYamlPersonaScalars(expected);
  }
  if (expected !== text) return null;
  return { contentSha: createHash("sha256").update(textBuf).digest("hex") };
}

/**
 * 自证结果的进程内缓存。
 *
 * 为什么必须有它：自证要重放整张表，而只读探针是对每对（补丁 × 文件）调一次出口的 ——
 * 不缓存就是几千次整表重放。
 *
 * 键必须覆盖**结论的每一个输入**，少一个就会串味：
 *   `dshHome` 决定快照来自哪一份保险柜；
 *   `fp` + 现场文本 sha 决定「拿什么与什么比」；
 *   `tableSha` 决定「重放的是哪一版表」—— 少了它，两张长度相同、内容不同的表会共用结论，
 *   测试里注入的夹具表与真表就会互相覆盖；
 *   `snapshotEpoch` 决定「保险柜里的原文是哪一刻的」—— 快照会被 `ensureOfficialSnapshot`
 *   重写，只用路径当键会让重写之后的问答拿到重写之前的答案。
 *
 * 缓存满 256 条按插入序丢一半，长跑进程不会无界增长。
 */
const fileProofCache = new Map();
const FILE_PROOF_CACHE_MAX = 256;

/** 保险柜被写过的次数：写入口只有 `writeOfficialSnapshot` 一处，自证缓存用它当快照的年代表。 */
let snapshotEpoch = 0;

/**
 * 两张表的内容指纹（唯一定义在 `lib/patch/table-fingerprint.js`）。
 *
 * `fileContentProof` 的入参既可能是活跃补丁全表，也可能是测试注入的夹具表。夹具表每次调用
 * 都是新数组，直接按数组身份当键等于永不命中；按内容算指纹才是「同一张表」的正确等同。
 *
 * 指纹按数组**身份**记下来：同一份表在一次判定里会被问上千次（每对补丁×文件一次），
 * 每次重算 66 条 sha256 会让只读探针慢到不可用；而表在进程内是常量，身份相同内容必然相同。
 */
const tableShaMemo = new WeakMap();

function tableShaOf(patches) {
  const list = Array.isArray(patches) ? patches : [];
  const hit = tableShaMemo.get(list);
  if (hit !== undefined) return hit;
  const sha = tableFingerprint(list);
  tableShaMemo.set(list, sha);
  return sha;
}

/**
 * 带缓存的逐文件自证（判据本体仍是 `fileContentProof`，这里只负责别把同一问答重复算）。
 *
 * @param {string} fp 目标文件
 * @param {string} text 现场文本
 * @param {Array<object>} patches 这一版表
 * @param {string} dshHome 官方原文快照落点
 * @returns {{contentSha:string}|null}
 */
function fileContentProofCached(fp, text, patches, dshHome) {
  const list = Array.isArray(patches) ? patches : [];
  if (list.length === 0) return null;
  const key = [
    String(dshHome || ""),
    fileContentKey(fp),
    createHash("sha256").update(Buffer.from(String(text), "utf8")).digest("hex"),
    tableShaOf(list),
    String(snapshotEpoch),
  ].join("\u0000");
  if (fileProofCache.has(key)) return fileProofCache.get(key);
  const proof = fileContentProof(fp, text, list, dshHome);
  if (fileProofCache.size >= FILE_PROOF_CACHE_MAX) {
    const drop = Math.ceil(FILE_PROOF_CACHE_MAX / 2);
    let n = 0;
    for (const k of fileProofCache.keys()) {
      fileProofCache.delete(k);
      if (++n >= drop) break;
    }
  }
  fileProofCache.set(key, proof);
  return proof;
}

/**
 * 页面加载前同步写入前端 client.js。只在字节真的变化时写盘。
 * 启动 4 秒后的 settle 不得再写这些文件，否则 client-hmr 会把旧 rev 从缓存里拿掉（#63）。
 *
 * 返回值是**写入证据**而不是裸包名：这条路径绕开 apply 管线，它写过的东西同样要能被
 * `markPatchesApplied` 认证，否则账本只能看到「没写过」，状态侧又回到假红。
 *
 * @returns {{packages:string[], patchesWritten:string[], filesWritten:string[]}}
 */
export function patchWatchedClientBundlesSync(aiBase = findAiBase()) {
  if (!aiBase) return { packages: [], patchesWritten: [], filesWritten: [] };
  const files = targetFiles(aiBase);
  // 客户端 bundle 也在「表变了就必须真替换」的作用面里：这里与 applyPatches 同源读账本，
  // 不把 marker 当成免检通行证。
  const identity = readPatchIdentity();
  const packages = [];
  const patchesWritten = new Set();
  const filesWritten = [];
  for (const p of ALL_PATCHES) {
    if (!patchAppliesHere(p)) continue;
    for (const key of fileKeysOf(p)) {
      for (const fp of pathsOf(files, key)) {
        if (!isWatchedClientBundle(fp)) continue;
        // L29:每个 bundle 独立 try,一个被占/损坏不要让其余宿主也跟着炸。
        try {
          const text = fs.readFileSync(fp, "utf8");
          const appliedText = applyReplacementsToText(text, p, fp, {
            markerTrusted: patchTableTrusted(identity, p),
          });
          if (!appliedText.changed) continue;
          const next = Buffer.from(appliedText.text, "utf8");
          const current = fs.readFileSync(fp);
          if (current.equals(next)) continue;
          ensureOfficialSnapshot(fp);
          fs.writeFileSync(fp, next);
          const packageName = clientBundlePackageName(fp);
          if (packageName && !packages.includes(packageName)) packages.push(packageName);
          patchesWritten.add(String(p.id));
          if (!filesWritten.includes(fp)) filesWritten.push(fp);
        } catch {
          // 文件被 EBUSY/ENOENT,继续处理下一个 bundle
        }
      }
    }
  }
  return { packages, patchesWritten: [...patchesWritten], filesWritten };
}

/**
 * 版本账本里的指纹三项。
 *
 * 为什么读侧自己读这份文件：判据在 core 里，账本是 reapply.js 写的。让状态侧
 * 反向 import reapply 会立刻造出一个环（reapply 依赖 core），所以两份实现只共
 * 「路径 + 解析」这一步：解析走 lib/patch/table-fingerprint.js 的 readStampIdentity，
 * 本函数只负责定位与读盘。
 *
 * 读不到 / 坏 JSON / 旧戳缺字段，三者都返回空指纹。空指纹的语义是「账本里没有可查的
 * 指纹」：判据按痕量放行一次，启动路径见戳旧会把表指纹与内容指纹补写进账本（不重打）。
 * 把空指纹当成匹配等于这次改造没做，把空指纹当成未生效则会让升级后的第一次启动
 * 把 66 条全报成要重打 —— 两条都是假结论，所以这一档单独走「放行 + 补写」。
 *
 * @returns {{tableSha:string, patchShas:Record<string,string>, contentSha:Record<string,string>,
 *   patchesWritten:string[], migratedAt:string}}
 */
function readPatchIdentity() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(findDshHome(), "dsh-purge", "applied.json"), "utf8"));
    return readStampIdentity(raw);
  } catch {
    return readStampIdentity(null);
  }
}

/**
 * 这条补丁在账本里算不算「可信」。
 *
 * 两半证据，缺一不可：
 *   1. 账本里这条补丁的指纹与当前表一致（表没换代）；
 *   2. 这一版表**真写过**这条补丁（`patchesWritten` 里有它）。
 * 只比指纹不够：上一轮把旧字节的 sha256 记进账本、再把指纹刷新一遍，指纹也会一致 ——
 * 那正是「戳成了新 marker」的形态。写入清单才是「字节由这一版表产生」的那一半。
 *
 * 三档输入分开处理：
 *   整份账本没有任何逐补丁指纹（旧戳）→ 放行一次。旧戳只有痕量可读，启动路径会把指纹
 *     补写进账本并留下 `migratedAt`；从下一次判定起就走真判据。把旧戳一律判 pending
 *     会让升级后的第一次启动把 66 条全报成「要重打」，那是另一种假结论。
 *   有指纹但没有这一条 / 指纹不一致 / 这一版表没写过它 → 不认。marker 可能来自另一代
 *     表、也可能撞上官方原文，都不能单独当证据。
 */
function patchTableTrusted(identity, patch) {
  const map = identity?.patchShas || {};
  if (Object.keys(map).length === 0) {
    // 迁移写之后的戳至少有指纹；这里只覆盖「还没迁移过」的旧账本。
    return !identity?.migratedAt;
  }
  const stored = map[String(patch?.id)] || "";
  if (!stored) return false;
  if (stored !== patchFingerprint(patch)) return false;
  // 两半认证：这一版表**写过**它，或**核对过**它已经在目标态（`patchesSettled`）。
  // 只认前一半时，「文件早就在目标态、没有可写字节」的补丁（远端 #2/#3/#50）永远
  // 进不了认证 → 永远 pending → apply 永不 clean → 账本永远不写，正是这一批要修的死循环。
  const written = Array.isArray(identity?.patchesWritten) ? identity.patchesWritten : [];
  const settled = Array.isArray(identity?.patchesSettled) ? identity.patchesSettled : [];
  const id = String(patch?.id);
  return written.includes(id) || settled.includes(id);
}

/**
 * 内容认证：这一版表在这份文件上的活干完了。
 *
 * 三个条件缺一不可，缺哪一个都会把假绿放回来：
 *   1. 账本里这条补丁的指纹与当前表一致 —— 表没换代。只凭内容挡不住「载荷换代」：
 *      旧正文里没有锚点，dry-run 同样不改文本，那正是 T1 修掉的那种假绿。
 *   2. marker 在 —— 这条补丁确实落过这份文件，不是「官方原文恰好就这样」。
 *   3. 再跑一次替换不改文本 —— 内容层面的「干完了」。
 *
 * 它与 `patchesWritten` 的分工：写过 = 这一轮动过字节；核对过 = 字节已经在这一版表的
 * 目标态。远端 #2/#3/#50 属于后者（文件早在目标态、marker 在、没有可写的字节），
 * 旧口径只认前者，于是它们既进不了账本、也永远 pending。
 *
 * 两侧共用：状态侧拿它补 `tableTrusted`，apply 侧拿它决定「这算 already 还是待应用」。
 * 各写一份就会回到「同一轮两个结论」。
 *
 * @param {object} identity 版本账本（`readStampIdentity` 的形状）
 * @param {object} patch 补丁条目
 * @param {string} fp 目标文件绝对路径
 * @param {string} text 现场文本
 * @param {boolean} [worked] 已经算好的「还有活」，省一次 dry-run
 * @returns {boolean}
 */
function patchCertifiedByContent(identity, patch, fp, text, worked) {
  const stored = identity?.patchShas?.[String(patch?.id)] || "";
  if (!stored || stored !== patchFingerprint(patch)) return false;
  if (!patchApplied(text, patch)) return false;
  const remaining = typeof worked === "boolean" ? worked : patchHasRemainingWork(text, patch, fp);
  return remaining !== true;
}

/**
 * 单文件上的可信判据：写入清单之外，多认一种「核对过但没写」的记录。
 *
 * 自愈轮不写 client bundle，因此它永远进不了 `patchesWritten`。账本里的
 * `evidenceExcluded` 记的是「那一轮没写它，但拿官方原文快照套这一版补丁，结果与现场
 * 逐字相同」。认它的条件与写入清单同源，只是把「写过」换成「核对过这一版」：
 *   补丁指纹一致（表没换代）**且** 记录里的补丁指纹与当前一致 **且** 文件字节
 *   还是核对时那份（`contentSha` 在 `loadPatchTarget` 里比）。
 * 任何一项对不上就回落，不拿 marker 兜底。
 *
 * @param {object} identity 版本账本（`readStampIdentity` 的形状）
 * @param {object} patch 补丁条目
 * @param {string} fp 目标文件绝对路径
 * @returns {boolean}
 */
function patchFileTrusted(identity, patch, fp) {
  if (patchTableTrusted(identity, patch)) return true;
  const rows = Array.isArray(identity?.evidenceExcluded) ? identity.evidenceExcluded : [];
  if (rows.length === 0) return false;
  const file = fileContentKey(fp);
  const sha = patchFingerprint(patch);
  return rows.some((row) => row
    && row.verified === true
    && String(row.patch) === String(patch?.id)
    && row.patchSha === sha
    && row.file === file);
}

/**
 * 这条补丁在**官方原文**上是不是无事可做。
 *
 * 判据三个条件缺一不可：
 *   0. 账本里这条补丁的指纹与当前表一致 —— 表没换代。载荷换代时「原文跑这版表也不变」
 *      说明不了任何事（旧产物在原文里同样不会变），那一档只能等真写入证据；
 *   1. 这条补丁的 marker 出现在官方原文里 —— 这段产物本来就随宿主自带，不是我们写的；
 *   2. 把这一版表的替换套到官方原文上，一个字节都不变 —— 这条补丁对这一版宿主是空操作。
 *
 * 为什么必须拿原文算、不能拿现场文本算：现场文本里的「没活」可能是上一代表留下的旧产物
 * （载荷换代那种假绿）。只有「原文 + 这一版表 = 原文」才说明这条补丁与这一版宿主无关 ——
 * 它既不需要谁写过它，也不该因为账本里没有它的写入记录而永远挂 pending。
 *
 * 为什么要有 marker 这一条：只问「改不改变原文」会把「这条补丁压根不适用于这一版文本」
 * （pattern 对不上、也没有产物）也算成认证。有 marker 在原文里，才说明「产物本来就有」。
 *
 * 没有官方快照（或快照里带着我们的标记、不是原文）时一律 false —— 不可判就不认证。
 *
 * @param {object} identity 版本账本（`readStampIdentity` 的形状）
 * @param {object} patch 补丁条目
 * @param {string} fp 目标文件绝对路径
 * @param {string} [dshHome] 保险柜所在主目录
 * @param {Map<string, boolean>} [cache] 一次判定内的缓存（同一文件会被多条补丁问）
 * @returns {boolean}
 */
function patchVacuousOnOfficial(identity, patch, fp, dshHome, cache = new Map()) {
  const key = `${patch?.id}\u0000${fileContentKey(fp)}`;
  if (cache.has(key)) return cache.get(key);
  let verdict = false;
  const stored = identity?.patchShas?.[String(patch?.id)] || "";
  if (!stored || stored !== patchFingerprint(patch)) {
    // 表换代（或账本没有这一条的指纹）：不可判，交给写入证据那一半。
    cache.set(key, false);
    return false;
  }
  const snapshot = readOfficialSnapshot(fp, dshHome);
  /* 来源不可信的快照不许当证据：没有 source、或 source 不在白名单里，直接判「不可认证」。
     这一段只是收紧输入，下面那三条判据一个字没动。 */
  if (snapshot && OFFICIAL_SNAPSHOT_SOURCES.has(String(snapshot.source || ""))) {
    const official = snapshot.buf.toString("utf8");
    const markers = Array.isArray(patch?.markers) && patch.markers.length > 0
      ? patch.markers
      : patch?.marker ? [patch.marker] : [];
    const carries = markers.length > 0 && markers.some((marker) => asLf(official).includes(asLf(marker)));
    if (carries) {
      const applied = applyReplacementsToText(official, patch, fp, { markerTrusted: false });
      let changed = applied.changed;
      if (isYamlPath(fp)) {
        const cleaned = sanitizeYamlPersonaScalars(applied.text);
        if (cleaned !== applied.text) changed = true;
      }
      verdict = changed === false;
    }
  }
  cache.set(key, verdict);
  return verdict;
}

/**
 * 单文件上的内容判据：与 `patchStatus` 用同一套证据、同一个次序。
 *
 * 为什么需要这个出口：两个只读探针（`scripts/check-clean-host-sim.mjs`、
 * `scripts/probe-host-patches.mjs`）要复算逐文件结论，原先调的是 `filePatchOutcome` ——
 * 那条路 marker 先行。带共享 marker 的补丁（#73 借 #70 的 marker）在它那里判 applied、
 * 在 `patchStatus` 里判 pending，同一份文件两个结论，探针的「复算」因此不再说明问题。
 * 判据只能有一份：探针拿这条出口，不在脚本里复制判定逻辑。
 *
 * `identity` 给账本时连「表有没有换代」「字节是不是收尾时那份」一起判；不给就按空账本
 * （痕量放行一次）判 —— 探针是只读复算，不替账本说话。
 *
 * @param {string} text 目标文件文本
 * @param {object} patch 补丁条目
 * @param {string} [fp] 文件路径（决定 YAML 分支）
 * @param {object} [identity] 版本账本（`readStampIdentity` 的形状，或它的原始 JSON）
 * @param {{dshHome?:string}} [options] 官方原文快照的落点（缺省本机主目录）
 * @returns {"applied"|"pending"|"skipped"}
 */
export function contentOutcomeOf(text, patch, fp = "", identity = null, options = {}) {
  const stamp = readStampIdentity(identity);
  const key = fileContentKey(fp);
  const recorded = stamp.contentSha[key] || "";
  const contentKnown = recorded !== "";
  const contentMatched = contentKnown
    && recorded === createHash("sha256").update(Buffer.from(String(text), "utf8")).digest("hex");
  const worked = patchHasRemainingWork(text, patch, fp);
  const tableTrusted = patchFileTrusted(stamp, patch, fp)
    || patchCertifiedByContent(stamp, patch, fp, text, worked)
    || patchVacuousOnOfficial(stamp, patch, fp, options.dshHome);
  // 自证只在它可能改变结论时才算：账本认、字节又对得上时，答案已经是 applied，
  // 再重放一遍整表只是白烧 I/O。问不清的那两档（指纹不认、字节对不上）才去问现场。
  const needProof = tableTrusted !== true || (contentKnown && !contentMatched);
  const proof = needProof
    ? fileContentProofCached(fp, text, Array.isArray(options.patches) ? options.patches : ALL_PATCHES, options.dshHome)
    : null;
  return contentFileOutcome({
    worked,
    settled: patchApplied(text, patch),
    tableTrusted,
    contentProven: proof !== null,
    contentKnown,
    contentMatched,
  });
}

/**
 * 一个目标文件的现场字节指纹，与账本里收尾时记下的那份比对。
 *
 * 键与写入侧共用 `fileContentKey`：两侧各归一一次等于两次实现，早晚会漂。
 *
 * @param {string} fp 目标文件绝对路径
 * @param {{contentSha:Record<string,string>}} identity 账本里的内容指纹表
 * @returns {Promise<{text:string, contentKnown:boolean, contentMatched:boolean}>}
 */
async function loadPatchTarget(fp, identity) {
  const buf = await fsp.readFile(fp);
  const sha = createHash("sha256").update(buf).digest("hex");
  const key = fileContentKey(fp);
  const recorded = identity?.contentSha?.[key] || "";
  return {
    text: buf.toString("utf8"),
    contentKnown: recorded !== "",
    contentMatched: recorded !== "" && recorded === sha,
  };
}

/**
 * 逐补丁状态。
 *
 * 判据由四层组成，marker 只是最外层：
 *   1. 现场自证：把这一版表重放到官方原文上，与现场逐字相同（`fileContentProof`，按**文件**判）。
 *      它是唯一不读账本的一层，所以换补丁表后的第一轮就答得出来；顺序在账本三档之前 ——
 *      账本的逐条指纹与内容指纹都会随表换代过期，不该由它们否决一份当场的证明；
 *   2. 内容层：现场文件字节 vs 账本里**真写过**时记下的字节指纹（`contentSha`）；
 *   3. 表层：账本里这条补丁的指纹 vs 当前表的指纹（`patchShas`），以及这一版表
 *      有没有真写过它（`patchesWritten`）。只比指纹挡不住「重写戳认证旧字节」；
 *   4. 痕迹层：marker / pattern 残留。它只在上面几层认不出来时兜底 —— 旧戳没有
 *      指纹，或文件不在内容指纹表里（多宿主、密封宿主没记上）。
 *
 * 为什么不能只留痕迹层：改一条补丁的替换正文而不动 marker 时，文件里的 marker 仍在，
 * 痕量判据照样报已生效，而宿主文件停在旧内容上。指纹一比对就露。
 *
 * 为什么第 1 层的单位必须是文件：同一文件上后一条补丁会改写前一条的产物，逐条重放现场
 * 永远对不上（详见 `fileContentProof` 的说明）。
 *
 * @param {string} aiBase 宿主插件根
 * @param {Array<object>} [patches] 补丁表
 * @param {{reasons?:Record<string,string>, sources?:Record<string,string>, identity?:object}} [options]
 *   `reasons` 是出口参数：设置类信息只许写这里，不许改状态（那是这条判据的成立条件）。
 *   `sources` 也是出口参数：逐条给出判据来源（content = 有字节指纹，marker = 只有痕迹），
 *   状态层契约把它露成 `patch.sources`。
 *   `identity` 供测试注入账本四项；缺省读现场账本。
 *   `dshHome` 供测试注入官方原文快照的落点；缺省 `findDshHome()`。
 * @returns {Promise<Record<number|string,string>>} id → 状态字面量
 */
export async function patchStatus(aiBase, patches = ALL_PATCHES, options = {}) {
  const files = targetFiles(aiBase);
  const identity = options.identity && typeof options.identity === "object"
    ? readStampIdentity(options.identity)
    : readPatchIdentity();
  const snapshotHome = String(options.dshHome || "").trim() || findDshHome();
  // 同一次判定里同一个文件会被多条补丁问到：原文快照只读一次。
  const vacuousCache = new Map();
  // 文件级自证按「文件 + 现场字节」缓存，理由与 apply 侧同：判定期间文本不变，但同一文件
  // 会被多条补丁问到，不缓存就是同一问答重放很多遍。
  const proofOf = (fp, text) => fileContentProofCached(fp, text, patches, snapshotHome);
  const reasons = options.reasons && typeof options.reasons === "object" ? options.reasons : null;
  // 逐条判据的来源：有内容指纹（账本里记过这些文件）就是 content，否则只能回落 marker。
  // 状态层契约把这份来源原样暴露成 `patch.source` / `patch.sources`，让「这条为什么判这样」可读。
  const sources = options.sources && typeof options.sources === "object" ? options.sources : null;
  const status = {};
  for (const p of patches) {
    if (!patchAppliesHere(p)) {
      status[p.id] = "na";
      continue;
    }
    const keys = fileKeysOf(p);
    const outcomes = [];
    let missing = 0;
    let readError = false;
    let contentKnownAny = false;
    for (const key of keys) {
      const fps = pathsOf(files, key);
      if (fps.length === 0) {
        missing += 1;
        continue;
      }
      for (const fp of fps) {
        let loaded;
        try {
          loaded = await loadPatchTarget(fp, identity);
        } catch {
          readError = true;
          continue;
        }
        if (loaded.contentKnown) contentKnownAny = true;
        const worked = patchHasRemainingWork(loaded.text, p, fp);
        // 这一版表的指纹 / 空操作判定：账本认不出来时先算一次，用来决定要不要去问现场。
        const tableTrusted = patchFileTrusted(identity, p, fp)
          || patchVacuousOnOfficial(identity, p, fp, snapshotHome, vacuousCache);
        // 自证只在它可能改变结论时才算（指纹不认、或字节对不上）：账本认、字节也对得上时，
        // 答案已经是 applied，再重放一遍整表只是白烧 I/O。
        const needProof = tableTrusted !== true || (loaded.contentKnown && !loaded.contentMatched);
        outcomes.push(contentFileOutcome({
          worked,
          settled: patchApplied(loaded.text, p),
          // 这里只读账本：状态侧不许自己「凭内容」认证 —— 那会把「只写戳的一轮」也判成已生效
          // （见 test/stamp-written-evidence）。
          // 不看账本的两档都只问现场、不问谁写过：「原文里本来就有这段产物」
          // （patchVacuousOnOfficial），以及「这份文件就是这一版表打出来的」（文件级自证）。
          // 后者与前者同一档次：它也要白名单来源的官方原文，也要快照不等于现场。
          tableTrusted,
          contentProven: needProof && proofOf(fp, loaded.text) !== null,
          contentKnown: loaded.contentKnown,
          contentMatched: loaded.contentMatched,
        }));
      }
    }
    if (sources) sources[p.id] = contentKnownAny ? "content" : "marker";
    const verdict = rollupPatchStatus({
      outcomes,
      missing,
      keyCount: keys.length,
      lastError: readError ? "read_error" : "",
      onMiss: onMissOf(p),
      strictFiles: !!p.strictFiles,
    });
    if (verdict === "pending") status[p.id] = "pending";
    else if (verdict === "applied" || verdict === "already") status[p.id] = "applied";
    // `pattern_not_found` 在状态侧要分两档：strictFiles 的补丁显示成「没对上」（红），
    // 其余显示成「这一版不需要」（灰）。两档的差别是这条补丁要不要算失败，不是好看。
    else if (verdict === "pattern_not_found") status[p.id] = p.strictFiles ? "unmatched" : "skipped";
    else if (verdict === "skipped") status[p.id] = "skipped";
    else status[p.id] = verdict;
    // 全部目标文件都不存在：可选/软补丁记「这一版不需要」，必中补丁记「宿主缺件」。
    // 原判据是 `p.optional`（46 条）。`onMiss` 归一后表达同一件事，
    // 与旧集合的差集只有 id 21（旧：optional 未标 → missing_file；新：warn → na）。
    // 21 的 key 是 `base`（dsh-base/cordis.patch.yml），只在「aiBase 在但 dsh-base 缺」
    // 这个边角组合下才走到这里。
    if (missing === keys.length && onMissOf(p) !== "fail") status[p.id] = "na";
  }
  // 设置只进 reason：hooksDenyBypass 决定「要不要打」与提示，不决定「已生效没有」。
  if (reasons && aiBase) {
    Object.assign(reasons, await hooksDeny.hookDenyReasons(getHooksDenySettings(), aiBase, hookDenyIo));
  }
  return status;
}

/** patch 89 的稳定标识：按 name 查，不写死 id（id 重排时不会静默失效）。 */
const SYSTEM_FIELD_PATCH_NAME = "SYSTEM_FIELD_EXTRACT";

/**
 * `system_field_extracted` 的**唯一**判定实现。
 *
 * 面板的 status / apply / override 三个端点都返回这个字段，语义是
 * 「patch 89 在宿主上生效了吗」。原实现（index.js）自己用裸 `require()`
 * 去拼 agent-loop 的路径再读文件，在 ESM 下抛 `ReferenceError: require is not defined`
 * 被 catch 吞掉 → 字段恒为 false，而 patch 89 其实好好的。
 *
 * 为什么不按原样把 `require` 换成 `createRequire` / `await import`：
 *   1. `require("@deepseek-ai/dsh-agent-loop")` 从本插件位置解析不到宿主包
 *      （实测 MODULE_NOT_FOUND —— 宿主依赖不在插件的 node_modules 里）；
 *   2. 即便解析到，`require(...).__dirname` 在宿主包上也是 `undefined`
 *      （`dsh-agent-loop` 的 package.json 是 `"type": "module"`，CJS 包装器不给 `__dirname`）。
 *   所以「拼路径 + 读文件」这条思路本身是错的，不是 require 写法的问题。
 *
 * 正确做法：直接复用 `patchStatus()` 的结论。它已经处理了嵌套 npm 布局、
 * 桌面解包布局、宿主面门禁、`targetFiles()` 的键映射，以及 pattern/marker 判定 ——
 * 再自己实现一遍只会多一处会漂移的副本。
 *
 * @param {object|Array} source `patchStatus()` / `gatherState().patch_status` 的
 *   `{ [id]: status }` 映射，或 `applyPatches()` 的 report 数组
 * @param {Array} [patches] 补丁表，默认 ALL_PATCHES
 * @returns {boolean} patch 89 已生效为 true；未生效 / 无宿主 / 找不到补丁一律 false
 */
export function systemFieldExtracted(source, patches = ALL_PATCHES) {
  if (!source) return false;
  const patch = patches.find((p) => p && p.name === SYSTEM_FIELD_PATCH_NAME);
  if (!patch) return false;
  const status = Array.isArray(source)
    // applyPatches 的 report 是行数组，status 用 patch_id 关联。
    ? source.find((row) => row && row.patch_id === patch.id)?.status
    : source[patch.id];
  // "applied" = 本次改写成功；"already" = 文本已是目标态（对面板来说同样是生效）。
  // pending（原文还在）/ skipped（对不上）/ na（无宿主）/ missing_file 都是「没生效」。
  return status === "applied" || status === "already";
}

export async function hasBackup(aiBase) {
  if (aiBase) {
    for (const fp of flattenTargetPaths(targetFiles(aiBase))) {
      if (isUserProfilePatchFile(fp)) continue;
      if (readOfficialSnapshot(fp)) return true;
    }
  }
  try {
    const names = fs.readdirSync(hostBakVaultRoot());
    if (names.some((name) => /\.bak$/i.test(name))) return true;
  } catch { /* 保险柜尚未建立 */ }
  return false;
}

function isTextShim(fp) {
  // H18:只读前 512 字节。readFileSync 整文件把 PATH 上几 MB 的 exe 全载进来会 OOM 并拖慢扫描。
  let fd;
  try {
    fd = fs.openSync(fp, "r");
    const buf = Buffer.allocUnsafe(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    const slice = buf.subarray(0, n);
    if (slice.includes(0)) return false;
    const head = slice.subarray(0, Math.min(120, n)).toString("utf8");
    return head.startsWith("#!") || /@echo/i.test(head) || head.startsWith("REM ") || head.startsWith("# ");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function nodeShimInject() {
  return {
    kind: "node",
    text:
      "// dsh-purge shim begin\n" +
      "if (!process.env.DSH_HOME) {\n" +
      "  try {\n" +
      "    const _dshShimFs =\n" +
      "      typeof process.getBuiltinModule === \"function\"\n" +
      "        ? process.getBuiltinModule(\"node:fs\")\n" +
      "        : typeof require === \"function\"\n" +
      "          ? require(\"node:fs\")\n" +
      "          : null;\n" +
      "    if (_dshShimFs) {\n" +
      "      const _dshShimArgv = process.argv[1] || \"\";\n" +
      "      const _dshShimDir = _dshShimArgv.replace(/\\\\/g, \"/\").replace(/\\/[^/]*$/, \"\");\n" +
      "      for (const _dshShimRel of [\"\", \"/..\", \"/../..\"]) {\n" +
      "        const _dshShimCand = _dshShimDir + _dshShimRel + \"/.dsh\";\n" +
      "        try {\n" +
      "          if (_dshShimFs.statSync(_dshShimCand).isDirectory()) { process.env.DSH_HOME = _dshShimCand; break; }\n" +
      "        } catch {}\n" +
      "      }\n" +
      "    }\n" +
      "  } catch {}\n" +
      "}\n" +
      "// dsh-purge shim end\n",
  };
}

// 符号链接到 bin.js 的 dsh 按 node 注入，不能当 shell。
function shimKindOf(fp) {
  const base = path.basename(fp).toLowerCase();
  if (base === "dsh.cmd" || base.endsWith(".cmd")) return "cmd";
  if (base === "dsh.ps1" || base.endsWith(".ps1")) return "ps1";
  if (/\.(m?js|cjs|mts|cts)$/i.test(base)) return "node";
  let firstLine = "";
  try {
    firstLine = (fs.readFileSync(fp, "utf8").split(/\r?\n/, 1)[0] || "").trim();
  } catch {}
  if (firstLine.startsWith("#!")) {
    if (/\bnode(js)?\b/i.test(firstLine)) return "node";
    if (/\b(pwsh|powershell)\b/i.test(firstLine)) return "ps1";
  }
  return "sh";
}

function shimInjectFor(kind) {
  if (kind === "cmd") {
    return {
      kind: "cmd",
      text:
        "REM dsh-purge shim begin\n" +
        "IF NOT DEFINED DSH_HOME IF EXIST \"%~dp0..\\.dsh\\\" FOR %%I IN (\"%~dp0..\\.dsh\") DO SET \"DSH_HOME=%%~fI\"\n" +
        "IF NOT DEFINED DSH_HOME IF EXIST \"%~dp0..\\..\\.dsh\\\" FOR %%I IN (\"%~dp0..\\..\\.dsh\") DO SET \"DSH_HOME=%%~fI\"\n" +
        "REM dsh-purge shim end\n",
    };
  }
  if (kind === "ps1") {
    return {
      kind: "ps1",
      text:
        "# dsh-purge shim begin\n" +
        "if (-not $env:DSH_HOME) {\n" +
        "  $shimRoot = $PSScriptRoot; if (-not $shimRoot) { $shimRoot = Split-Path $MyInvocation.MyCommand.Definition -Parent }\n" +
        "  foreach ($rel in @((Join-Path $shimRoot '.dsh'), (Join-Path $shimRoot '..\\.dsh'), (Join-Path $shimRoot '..\\..\\.dsh'))) {\n" +
        "    $cand = [System.IO.Path]::GetFullPath($rel)\n" +
        "    if (Test-Path -LiteralPath $cand) { $env:DSH_HOME = $cand; break }\n" +
        "  }\n" +
        "}\n" +
        "# dsh-purge shim end\n",
    };
  }
  if (kind === "node") return nodeShimInject();
  return {
    kind: "sh",
    text:
      "# dsh-purge shim begin\n" +
      "if [ -z \"${DSH_HOME:-}\" ]; then\n" +
      "  _dsh_shim_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n" +
      "  for _dsh_rel in \"$_dsh_shim_dir/.dsh\" \"$_dsh_shim_dir/../.dsh\" \"$_dsh_shim_dir/../../.dsh\"; do\n" +
      "    if [ -d \"$_dsh_rel\" ]; then DSH_HOME=$(CDPATH= cd -- \"$_dsh_rel\" && pwd); export DSH_HOME; break; fi\n" +
      "  done\n" +
      "  unset _dsh_shim_dir _dsh_rel\n" +
      "fi\n" +
      "# dsh-purge shim end\n",
  };
}

function hasLegacyPermissionPin(text) {
  return text.includes("DSH_PERMISSION_MODE");
}

function shimInjectCurrent(text) {
  if (hasLegacyPermissionPin(text)) return false;
  return text.includes("dsh-purge shim begin") && text.includes("DSH_HOME");
}

export function stripShimInject(text) {
  const lines = text.split(/(?<=\n)/);
  const out = [];
  let inBlock = false;
  let blockStart = -1; // M33:记住 block 起点,未闭合时整段还原,不吞用户尾部内容
  let afterOldHeader = false;
  for (const ln of lines) {
    if (inBlock) {
      if (ln.includes("dsh-purge shim end")) {
        inBlock = false;
        blockStart = -1;
      }
      continue;
    }
    if (ln.includes("dsh-purge shim begin")) {
      inBlock = true;
      blockStart = out.length;
      out.push(ln); // 占位,未闭合时保留
      continue;
    }
    if (ln.includes("dsh-purge shim")) {
      afterOldHeader = true;
      continue;
    }
    if (afterOldHeader && /DSH_PERMISSION_MODE|DSH_HOME/.test(ln)) continue;
    afterOldHeader = false;
    out.push(ln);
  }
  // 遇到 begin 没遇到 end:不动尾巴,保留整段 begin 占位(已 push)。
  // 相当于拒绝剥离这个损坏的注入,等人工处理,而不是把 begin 之后的用户代码一起删掉。
  if (inBlock && blockStart >= 0) {
    // 占位已在 out[blockStart],后面被 continue 跳过的行其实没进 out。
    // 保守做法:整个原文返回,不剥离。
    return text;
  }
  return out.join("");
}

function insertShimInject(text, inject) {
  if (inject.kind === "cmd") {
    const m = text.match(/^(\s*@echo[^\n]*\n)/i);
    if (m) return m[1] + inject.text + text.slice(m[1].length);
    return "@ECHO off\n" + inject.text + text;
  }
  if (!text.startsWith("#!")) return inject.text + text;
  const firstNl = text.indexOf("\n");
  if (firstNl < 0) return text + "\n" + inject.text;
  return text.slice(0, firstNl + 1) + inject.text + text.slice(firstNl + 1);
}

export function shimIsPatched(fp) {
  if (!isFile(fp) || !isTextShim(fp)) return false;
  try {
    return fs.readFileSync(fp, "utf8").includes("dsh-purge shim");
  } catch {
    return false;
  }
}

export function shimFileStatus(fp) {
  if (!isFile(fp)) return "missing";
  if (!isTextShim(fp)) return "binary";
  return shimIsPatched(fp) ? "patched" : "original";
}

function scrubInBinBak(dir, name, cleaned) {
  const bak = path.join(dir, name);
  const original = name.slice(0, -".dshpurge.bak".length);
  const target = path.join(dir, original);
  const keepAsShimBackup = SHIM_NAMES.includes(original) && isFile(bak);

  if (!keepAsShimBackup) {
    try {
      fs.unlinkSync(bak);
      cleaned.push(`deleted:${name}`);
    } catch (e) {
      cleaned.push(`delete_failed:${name}:${e}`);
    }
    return;
  }

  // 备份放到仓外,并删掉密封 bin 里的同名 bak。
  // C8:外拷贝失败/字节不等时绝对不能删 in-bin bak,否则用户永远拿不回 shim 原文。
  // M32:外部已存在时按 size 对比,大小一致才信任;不一致说明外部 bak 是旧的,这次就当作 external_bak_stale,保留 in-bin bak。
  const external = shimBackupPath(target);
  let externalGood = false;
  try {
    if (fs.existsSync(external)) {
      let srcSize = -1, dstSize = -2;
      try { srcSize = fs.statSync(bak).size; } catch { /* ignore */ }
      try { dstSize = fs.statSync(external).size; } catch { /* ignore */ }
      if (srcSize === dstSize && srcSize >= 0) {
        externalGood = true;
        cleaned.push(`external_bak_exists:${original}`);
      } else {
        cleaned.push(`external_bak_stale:${original}`);
      }
    } else {
      ensureDirSync(path.dirname(external));
      // 原子拷贝,写一半不留烂 external。
      const tmp = `${external}.${process.pid}.${Date.now()}.copytmp`;
      fs.copyFileSync(bak, tmp);
      fs.renameSync(tmp, external);
      externalGood = true;
      cleaned.push(`relocated_bak:${original}`);
    }
  } catch (e) {
    cleaned.push(`relocate_failed:${original}:${e}`);
  }
  if (!externalGood) {
    cleaned.push(`kept_in_bin_bak:${original}`);
    return;
  }
  try {
    fs.unlinkSync(bak);
    cleaned.push(`removed_in_bin_bak:${original}`);
  } catch (e) {
    cleaned.push(`remove_failed:${original}:${e}`);
  }
}

function stripCmdInjectSync(cmdPath, cleaned) {
  if (!(isFile(cmdPath) && isTextShim(cmdPath) && shimIsPatched(cmdPath))) return;
  try {
    fs.writeFileSync(cmdPath, stripShimInject(fs.readFileSync(cmdPath, "utf8")), "utf8");
    cleaned.push("stripped_cmd_inject");
  } catch (e) {
    cleaned.push(`error_strip_cmd:${e}`);
  }
}

export function sanitizeDesktopCommandRuntimes() {
  const report = [];
  for (const dir of listDesktopCommandRuntimeDirs()) {
    const cleaned = [];
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      // 只动本插件产生的 bak。
      if (!/\.dshpurge\.bak$/i.test(name) && !/\.dshpurge\./i.test(name)) continue;
      try {
        if (name.toLowerCase().endsWith(".dshpurge.bak")) scrubInBinBak(dir, name, cleaned);
        else {
          fs.unlinkSync(path.join(dir, name));
          cleaned.push(`deleted_artifact:${name}`);
        }
      } catch (e) {
        cleaned.push(`error:${name}:${e}`);
      }
    }
    stripCmdInjectSync(path.join(dir, "dsh.cmd"), cleaned);
    if (cleaned.length) report.push({ dir, cleaned });
  }
  return report;
}

async function stripWinCmdShim(fp, text) {
  if (!(shimIsPatched(fp) || hasLegacyPermissionPin(text))) return "skipped_win_cmd";
  await saveText(fp, stripShimInject(text));
  return "stripped_win_cmd";
}

export async function patchShim(shimDir) {
  const result = {};
  if (!shimDir) return { error: "no_shim_dir" };
  // 密封 bin 不注入、不写 bak。
  if (isDesktopCommandRuntimeDir(shimDir)) {
    const scrubbed = sanitizeDesktopCommandRuntimes().filter((r) => path.normalize(r.dir) === path.normalize(shimDir));
    return { skipped_sealed_desktop: true, scrubbed };
  }
  for (const fname of SHIM_NAMES) {
    const fp = path.join(shimDir, fname);
    if (!isFile(fp)) {
      result[fname] = "missing";
      continue;
    }
    if (!isTextShim(fp)) {
      result[fname] = "skipped_binary";
      continue;
    }

    let text;
    try {
      text = await loadText(fp);
    } catch (e) {
      result[fname] = `error:${e}`;
      continue;
    }

    // .cmd 启动器会闪控制台，不注入，去掉旧钉入。
    if (fname === "dsh.cmd" && isWindows) {
      try {
        result[fname] = await stripWinCmdShim(fp, text);
      } catch (e) {
        result[fname] = `error:${e}`;
      }
      continue;
    }

    if (shimIsPatched(fp) && shimInjectCurrent(text)) {
      result[fname] = "already_patched";
      continue;
    }
    if (shimIsPatched(fp) || hasLegacyPermissionPin(text)) text = stripShimInject(text);

    const bak = shimBackupPath(fp);
    if (!fs.existsSync(bak)) {
      try {
        await fsp.mkdir(path.dirname(bak), { recursive: true });
        await fsp.copyFile(fp, bak);
      } catch {}
    }
    try {
      await saveText(fp, insertShimInject(text, shimInjectFor(shimKindOf(fp))));
      result[fname] = isDesktopCommandRuntimeDir(shimDir) ? "patched_desktop" : "patched";
    } catch (e) {
      result[fname] = `error:${e}`;
    }
  }
  return result;
}

export async function patchAllShims() {
  const results = {};
  for (const dir of listShimDirsForPatch()) {
    results[dir] = await patchShim(dir);
  }
  return results;
}

async function restoreFromBak(fp, bak, status) {
  // #88:fp 可能是符号链接(npm 的 bin 链接指向包内真实文件)。copyFile 会跟随链接,把备份内容
  // 写进目标文件;而备份一旦跨版本升级就是陈旧的,这一步就把新版本的文件顶掉了。
  // 实测:DSH 0.1.7-rc.2 → 0.2.0-rc.2 升级后,/usr/local/bin/dsh 的旧备份(11237 字节的旧
  // bin.js)覆盖了 lib/bin.js,而 chunk 已是新版本 → `dsh plugin` 报
  // ERR_MODULE_NOT_FOUND: plugin-DkYIj96-.js(旧版 chunk 名,磁盘上只有新版的 plugin-BGnVfe_D.js)。
  // 符号链接本身没有「内容」可还原,所以只丢弃陈旧备份,绝不写目标。
  // 注意:hostFs.promises 是白名单(只有 readFile/writeFile/mkdir/unlink/rm/copyFile),
  // 没有 lstat,所以符号链接判定必须走同步的 lstatSync。
  let link = false;
  try {
    link = fs.lstatSync(fp).isSymbolicLink();
  } catch {
    // 目标不存在:交给下面的 copyFile 按原有语义报错
  }
  if (link) {
    await fsp.unlink(bak);
    return `${status}_skipped_symlink`;
  }
  await fsp.copyFile(bak, fp);
  await fsp.unlink(bak);
  return status;
}

export async function revertShim(shimDir, { scrubDesktop = true } = {}) {
  const result = {};
  if (!shimDir) return result;
  for (const fname of SHIM_NAMES) {
    const fp = path.join(shimDir, fname);
    const bak = shimBackupPath(fp);
    const legacyBak = fp + ".dshpurge.bak";
    try {
      if (fs.existsSync(bak)) {
        result[fname] = await restoreFromBak(fp, bak, "reverted");
      } else if (fs.existsSync(legacyBak)) {
        result[fname] = await restoreFromBak(fp, legacyBak, "reverted_legacy_in_bin");
      } else if (shimIsPatched(fp)) {
        await saveText(fp, stripShimInject(await loadText(fp)));
        result[fname] = "stripped_inject";
      } else if (!isFile(fp)) {
        result[fname] = "missing";
      } else {
        result[fname] = "no_backup";
      }
    } catch (e) {
      result[fname] = `error:${e}`;
    }
  }
  if (scrubDesktop && isDesktopCommandRuntimeDir(shimDir)) {
    const scrubbed = sanitizeDesktopCommandRuntimes();
    if (scrubbed.length) result.in_bin_scrub = scrubbed;
  }
  return result;
}

export async function revertAllShims() {
  const results = {};
  for (const dir of listShimDirsForPatch()) {
    results[dir] = await revertShim(dir, { scrubDesktop: false });
  }
  // 密封目录再扫一遍，避免漏检启动器。
  const scrubbed = sanitizeDesktopCommandRuntimes();
  if (scrubbed.length) results._desktop_scrub = scrubbed;
  return results;
}

export function normalizeOverride(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").trim();
}

export function hashOverride(text) {
  return createHash("sha256").update(normalizeOverride(text), "utf8").digest("hex");
}

export function defaultOverrideText() {
  // 插件内置出厂默认（加密槽）。解包/应用后写入 $DSH_HOME/prompt-inject.md；运行注入以该文件为准。
  const sealed = openSlot();
  return normalizeOverride(sealed) ? sealed : "";
}

export function defaultOverrideHash() {
  return hashOverride(defaultOverrideText());
}

export function overrideStatePath(dshHome) {
  return path.join(dshHome, "dsh-purge", "override-state.json");
}

export function readOverrideStateSync(dshHome) {
  const fp = overrideStatePath(dshHome);
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export async function readOverrideState(dshHome) {
  return readOverrideStateSync(dshHome);
}

export async function writeOverrideState(dshHome, state) {
  const fp = overrideStatePath(dshHome);
  // H19:原子写。半写坏的 override-state 会让下次启动 JSON.parse 抛错。
  await atomicWriteFile(fp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function markOverrideCustomized(dshHome, customized, text, extra = {}) {
  const isExplicit = extra.explicitSave === true;
  await writeOverrideState(dshHome, {
    customized: Boolean(customized),
    explicitSave: isExplicit,
    hash: isExplicit ? "" : hashOverride(text ?? defaultOverrideText()),
    seedHash: defaultOverrideHash(),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * 磁盘上这份正文是不是「上一次我们自己落盘写进去的」。
 *
 * 必须先比这一步，再比内置默认：重新加密（embed-prompt）之后 defaultOverrideHash()
 * 一定会变，而磁盘上还是上一版默认。直接拿磁盘比新默认，会把「插件自己写的旧默认」
 * 误判成「用户手改」，installOverride 从此永久拒绝更新——这就是「改了 default-prompt-inject.md
 * 却不生效」的根因。state.hash / state.seedHash 记的就是我们上次写下去的那一份。
 */
function overrideTextIsOurs(state, text) {
  const stamp = hashOverride(text);
  if (typeof state?.hash === "string" && state.hash === stamp) return true;
  if (typeof state?.seedHash === "string" && state.seedHash === stamp) return true;
  return false;
}

/** 插件默认血统：ChatML 头 + 小码酱标记。旧槽/旧盘也带这两句，应用时应刷到当前槽，不必再点保存。 */
const PLUGIN_DEFAULT_MARKS = [
  "<|im_start|>system:",
  "<project_instructions>",
  "Little Code Sauce",
];

export function looksLikePluginDefault(text) {
  const n = normalizeOverride(text);
  if (!n) return false;
  if (n === normalizeOverride(defaultOverrideText())) return true;
  return PLUGIN_DEFAULT_MARKS.every((mark) => n.includes(mark));
}

/** 点保存落下的原文必须保住。和当前加密槽不同的非空稿也保住，即使还带小码酱标记。 */
export function isKeepableUserOverride(dshHome, text) {
  const incoming = normalizeOverride(text);
  if (!incoming) return false;
  const bundled = normalizeOverride(defaultOverrideText());
  if (incoming === bundled) return false;
  const state = readOverrideStateSync(dshHome);
  const stamp = hashOverride(text);
  if (typeof state?.seedHash === "string" && state.seedHash === stamp) return false;
  if (overrideTextIsOurs(state, text)) return false;
  if (state.explicitSave === true) return true;
  if (state.customized === true) return true;
  return true;
}

export function isUserCustomizedOverrideSync(dshHome) {
  return isKeepableUserOverride(dshHome, readPromptInjectFileSync(dshHome));
}

export async function isUserCustomizedOverride(dshHome) {
  return isUserCustomizedOverrideSync(dshHome);
}

export async function overrideStatus(_dshHome) {
  if (normalizeOverride(defaultOverrideText())) return "default";
  return "missing";
}

/** 设置框显示 $DSH_HOME/prompt-inject.md；尚未落下时预览加密默认。 */
export async function readOverrideForUi(dshHome) {
  const fp = findOverrideFile(dshHome);
  const defaultContent = defaultOverrideText();
  const disk = readPromptInjectFileSync(dshHome);
  let exists = false;
  try { exists = fs.existsSync(fp); } catch { exists = false; }
  const hasDisk = Boolean(normalizeOverride(disk));
  const customized = isUserCustomizedOverrideSync(dshHome);
  const content = hasDisk ? disk : defaultContent;
  return {
    path: fp,
    exists: exists && hasDisk,
    empty: !normalizeOverride(content),
    customized,
    usingDefault: hasDisk && !customized,
    content,
    defaultContent,
  };
}

function writeOverrideStateSync(dshHome, state) {
  const fp = overrideStatePath(dshHome);
  // H19:原子写。
  atomicWriteSync(fp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * 组装/对话读磁盘 prompt-inject.md。点保存落下的用户稿不覆盖。
 * 缺文件或仍是插件自己落盘的旧默认时，才把当前槽同步上去。
 */
export function syncPromptInjectOnDiskSync(dshHome) {
  const home = path.normalize(String(dshHome || findDshHome() || ""));
  if (!home) return { action: "skip", reason: "no_home" };
  const bundled = defaultOverrideText();
  const bundledNorm = normalizeOverride(bundled);
  if (!bundledNorm) return { action: "skip", reason: "empty_slot" };
  const fp = findOverrideFile(home);
  const diskRaw = readPromptInjectFileSync(home);
  const diskNorm = normalizeOverride(diskRaw);
  if (isKeepableUserOverride(home, diskRaw)) {
    return { action: "keep", reason: "user_custom" };
  }
  if (diskNorm === bundledNorm) {
    return { action: "keep", reason: "current" };
  }
  try {
    // H19:原子写 prompt-inject.md,半写坏的 inject 会让组装直接拿到残片。
    atomicWriteSync(fp, bundled, "utf8");
    writeOverrideStateSync(home, {
      customized: false,
      explicitSave: false,
      hash: hashOverride(bundled),
      seedHash: defaultOverrideHash(),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return { action: "error", reason: String(error && error.message ? error.message : error) };
  }
  return { action: "wrote", reason: diskNorm ? "refresh_default" : "seed_default" };
}

/**
 * 启动时把加密槽喂到磁盘。syncPromptInjectOnDiskSync 的包装,
 * 返回更细的 action 名字(seed_default / refresh_default / kept_user_custom / current / empty_slot / error),
 * 并带上 path,方便 index.js / status 面板直接消费。
 */
export function seedPromptInjectAtBoot(dshHome) {
  const home = path.normalize(String(dshHome || findDshHome() || ""));
  const fp = home ? findOverrideFile(home) : "";
  const result = syncPromptInjectOnDiskSync(home);
  const base = { path: fp, reason: result.reason || "" };
  switch (result.action) {
    case "wrote":
      // syncPromptInjectOnDiskSync 用 reason 区分 seed vs refresh,直接提到 action。
      return { ...base, action: result.reason === "refresh_default" ? "refresh_default" : "seed_default" };
    case "keep":
      if (result.reason === "current") return { ...base, action: "current" };
      return { ...base, action: "kept_user_custom" };
    case "skip":
      if (result.reason === "empty_slot") return { ...base, action: "empty_slot" };
      return { ...base, action: "error" };
    case "error":
      return { ...base, action: "error" };
    default:
      return { ...base, action: result.action || "error" };
  }
}

/**
 * 解包/应用成功后:把加密槽写入 $DSH_HOME/prompt-inject.md(用户自改时不覆盖)。
 * force 仅用于显式「恢复默认」。
 */
export async function installOverride(dshHome, force = false) {
  const fp = findOverrideFile(dshHome);
  await fsp.mkdir(dshHome, { recursive: true });
  const bundled = defaultOverrideText();
  if (!normalizeOverride(bundled)) return fs.existsSync(fp) ? "empty" : "missing";
  let disk = "";
  if (fs.existsSync(fp)) {
    try {
      disk = await loadText(fp);
    } catch {
      disk = "";
    }
  }
  // 用户正文（与内置不同、且不是我们上次写下去的那一份）一律保留，除非显式 force。
  // 必须先排掉「插件自己写的旧默认」：否则重新加密后会被误判成用户自改，
  // 还会被 markOverrideCustomized(true) 永久钉死，之后任何 Apply 都不再更新这个文件。
  if (!force && normalizeOverride(disk) && isKeepableUserOverride(dshHome, disk)) {
    await markOverrideCustomized(dshHome, true, disk);
    return "exists";
  }
  if (!force && await isUserCustomizedOverride(dshHome)) return "exists";
  // 磁盘已是同一份默认则只刷新标记，避免无意义重写。
  if (!force && normalizeOverride(disk) && normalizeOverride(disk) === normalizeOverride(bundled)) {
    await markOverrideCustomized(dshHome, false, bundled);
    return "exists";
  }
  await fsp.writeFile(fp, bundled, "utf8");
  await markOverrideCustomized(dshHome, false, bundled);
  return "wrote";
}

/**
 * 点应用：框里仍是插件默认血统或空 → 刷当前加密槽，不必再点保存。
 * 只有用户另写的稿才按框落盘。
 */
export async function commitOverrideOnApply(dshHome, incoming) {
  const home = path.normalize(String(dshHome || findDshHome() || ""));
  if (!home) return { action: "skip", reason: "no_home" };
  let effective = typeof incoming === "string" ? incoming : null;
  if (effective === null) {
    try { effective = readPromptInjectFileSync(home); } catch { effective = ""; }
  }
  if (typeof effective === "string" && normalizeOverride(effective) && isKeepableUserOverride(home, effective)) {
    const saved = await saveOverrideContent(home, effective);
    return { ...saved, action: "saved_user" };
  }
  const diskRaw = readPromptInjectFileSync(home);
  const diskNorm = normalizeOverride(diskRaw);
  const bundledNorm = normalizeOverride(defaultOverrideText());
  if (diskNorm && diskNorm !== bundledNorm) {
    await markOverrideCustomized(home, true, diskRaw, { explicitSave: true });
    rememberCommittedOverride(home, diskRaw);
    return { action: "kept_user_custom", path: findOverrideFile(home), content: diskRaw };
  }
  const seed = seedPromptInjectAtBoot(home);
  try {
    rememberCommittedOverride(home, readPromptInjectFileSync(home) || defaultOverrideText());
  } catch { /* hang 仍会在 refresh 时再钉 */ }
  return seed;
}

export async function saveOverrideContent(dshHome, content) {
  const bundled = defaultOverrideText();
  const incoming = typeof content === "string" ? content : "";
  const home = path.normalize(dshHome);
  const fp = findOverrideFile(home);
  await fsp.mkdir(home, { recursive: true });
  const handle = await nodeFs.promises.open(fp, "w");
  try {
    await handle.writeFile(incoming, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  // 没改框不必保存：启动/应用会把默认稿 seed 进 prompt-inject.md。
  // 只有框里和默认不同才算用户稿；点保存才覆盖文件。
  const customized = Boolean(normalizeOverride(incoming))
    && normalizeOverride(incoming) !== normalizeOverride(bundled);
  rememberCommittedOverride(home, incoming);
  if (!String(process.env.DSH_HOME || "").trim()) process.env.DSH_HOME = home;
  await markOverrideCustomized(home, customized, incoming, { explicitSave: true });
  return { path: fp, customized, content: incoming, defaultContent: bundled, explicitSave: true };
}

export function editOverride(dshHome) {
  const fp = findOverrideFile(dshHome);
  if (!fs.existsSync(fp)) {
    return { ok: false, needCreate: true, path: fp };
  }
  // M31:EDITOR 常见写法是 "code --wait" / "nvim +Lazy sync" / '"C:\\...\\Sublime Text\\subl.exe" --wait'。
  // 按空格 split 会断掉带空格路径;简单起见,引号段+无引号段的 tokenizer。
  const raw = (process.env.EDITOR || "").trim();
  let cmd;
  let args;
  if (raw) {
    const tokens = raw.match(/"([^"]*)"|'([^']*)'|(\S+)/g) || [];
    const parsed = tokens.map((t) => t.replace(/^['"]|['"]$/g, ""));
    cmd = parsed[0] || (isWindows ? "notepad" : "vi");
    args = [...parsed.slice(1), fp];
  } else {
    cmd = isWindows ? "notepad" : "vi";
    args = [fp];
  }
  const child = spawn(cmd, args, {
    stdio: "inherit",
    detached: false,
    windowsHide: true,
    shell: false,
  });
  return { ok: true, editor: cmd, args, path: fp, child };
}

/**
 * 列表上的“已就绪”：已写入、或当前版本不需要 / 组件未装（与 apply 的 soft-ok 对齐）。
 *
 * 判据本体在 lib/patch/status.js 的 `isReady`：本函数原先按 status 字符串现列一遍
 * 白名单，于是同一条 `pattern_not_found` 在列表上和在 apply 汇总里可以判得不一样。
 */
export function patchStatusReady(status, patch = null) {
  return isReady(status, patch, onMissKind);
}

export async function gatherState() {
  const dshHome = findDshHome();
  const aiBase = findAiBase();
  const shimDir = findShimDir();
  const desktop_runtimes = listDesktopCommandRuntimeDirs();
 // ：版本门禁结果随状态一起返回（面板要显示，CLI status 也要）。
  const hostVersionGate = checkHostVersionGate(aiBase);
  const files = aiBase ? targetFiles(aiBase) : {};
  // 设置类信息只进 `patch_reasons`：`patch_status` 是内容判据的结论，不许被开关改写。
  const patch_reasons = {};
  // 逐条判据来源：内容 / 痕迹。与 patch_status 同一轮算出来，两个出口各自可读。
  const patch_sources = {};
  const patch_status = aiBase
    ? await patchStatus(aiBase, ALL_PATCHES, { reasons: patch_reasons, sources: patch_sources })
    : {};
  // 原始条口径只有一个实现（lib/patch/counts.js）：`total` 只数当前宿主上适用的条数，
  // `na` 单独一列 —— 宿主未定位时不是「0 条不可用」，而是「全部不可用」。
  const rawTally = rawCounts(patch_status, ALL_PATCHES, onMissKind);
  const patches_applied = rawTally.applied;
  const patches_pending = rawTally.pending;
  const patches_skipped = rawTally.skipped;
  const patches_ready = rawTally.ready;
  const patches_na = rawTally.na;
  const patches_total = rawTally.total;
  const display_patches = aiBase ? groupPatchesForDisplay(ALL_PATCHES, patch_status) : [];
  const displayTally = tallyDisplayPatches(display_patches);
  let shim_cmd = "missing";
  let shim_ps1 = "missing";
  let shim_bin = "missing";
 // ：一次判定，三处复用。原来是三次独立探测（8473/8489/8492），
  // 每次都要走一遍 exe 名匹配 + resources 探测，是 gatherState 里最贵的重复。
  const desktopSurface = isDesktop();
  if (desktopSurface) {
    const desktopShim = findDesktopShimDir();
    if (desktopShim) {
      shim_cmd = shimFileStatus(path.join(desktopShim, "dsh.cmd"));
      shim_ps1 = shimFileStatus(path.join(desktopShim, "dsh.ps1"));
      shim_bin = shimFileStatus(path.join(desktopShim, "dsh"));
    }
  } else if (shimDir) {
    shim_cmd = shimFileStatus(path.join(shimDir, "dsh.cmd"));
    shim_ps1 = shimFileStatus(path.join(shimDir, "dsh.ps1"));
    shim_bin = shimFileStatus(path.join(shimDir, "dsh"));
  }
  return {
 // ：gatherState 是诊断入口，非桌面进程也要能拿到状态（好让人看清"为什么用不了"）。
    // 所以这里不直接调 detectSurface（它会抛错），而是给出可读的 surface 描述。
    surface: (() => {
      try {
        return detectSurface();
      } catch (error) {
        return `unsupported:${error.code || "unknown"}`;
      }
    })(),
    dsh_home: dshHome,
    ai_base: aiBase,
 // CONTRACT-4：把版本门禁结果暴露给 UI，让「能不能应用」在面板上一眼可见，
    // 而不是点了应用才发现补丁全都没匹配上。
    host_version: hostVersionGate.hostVersion,
    dsh_target: hostVersionGate.dshTarget,
    version_gate: {
      allowed: hostVersionGate.allowed,
      level: hostVersionGate.level,
      reason: hostVersionGate.reason,
      hint: hostVersionGate.hint,
    },
    plugin_version: String(pluginPkg().version || ""),
    desktop_exe: desktopSurface
      ? (desktop.findDesktopAppExecutable() || "")
      : "",
    desktop_install: desktopSurface
      ? (desktop.findDesktopAppExecutable() || desktop.listDesktopInstallRoots()[0] || "")
      : "",
    shim_dir: shimDir,
    desktop_runtimes,
    files,
    patch_status,
    patch_reasons,
    patch_sources,
    patches_applied,
    patches_pending,
    patches_skipped,
    patches_ready,
    patches_na,
    patches_total,
    display_patches,
    display_applied: displayTally.applied,
    display_pending: displayTally.pending,
    display_skipped: displayTally.skipped,
    display_failed: displayTally.failed,
    display_ready: displayTally.ready,
    display_total: displayTally.total,
    has_backup: await hasBackup(aiBase),
    shim_cmd,
    shim_ps1,
    shim_bin,
    override_path: findOverrideFile(dshHome),
    override_status: await overrideStatus(dshHome),
    asar_still_sealed: desktopAsarStillSealed(),
    hooks_deny_bypass: getHooksDenySettings().hooksDenyBypass,
  };
}
