#!/usr/bin/env node
/**
 * bin/dsh-purge.js — 命令行入口：把子命令折成 core 的一次调用。
 */


import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";
import * as reapply from "../lib/reapply.js";
import { diagError, diagLog, diagLogPath, newApplyRunId, withApplyRun } from "../lib/diag-log.js";
import { checkInstallState } from "../lib/install-state.js";
import { inspectHostInstall } from "../lib/host/install-health.js";
import { inspectLauncher } from "../lib/launcher.js";
import { collectApplyBefore, recordApplyRun, runAuditCli, runAuditQuery } from "../lib/audit/index.js";
import { summarizeRevertParity } from "../lib/patch/rollup.js";
import { countsLine } from "../lib/patch/counts.js";
import * as contract from "../lib/state/contract.js";

const args = process.argv.slice(2);

/** 插件包根（`bin/` 的上一层）：安装指纹与 `package.json` 都在这里。 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 结构化体检单。
 *
 * 存在的理由：`--status` 是给人看的表格，缺三样事后定位必需的东西 ——
 * 每个补丁目标文件是否存在、文件里有没有本插件标记、以及旁边有没有备份。
 * 出问题时「补丁说 applied 但宿主没变化」和「文件根本没找到」是完全不同的两件事，
 * 光看状态列区分不出来。这里把它们并排放在一份 JSON 里，方便远端直接存档。
 *
 * @param {object} state `core.gatherState()` 的返回值
 * @returns {object} 可 JSON.stringify 的完整现场
 */
function diagnosePayload(state) {
  // 计数与逐条状态读状态层契约：CLI 不再自己写 `patch_status[id] || "unknown"` 的补位。
  const patchView = contract.patchBlock(state, core.ALL_PATCHES);
  const patches = core.ALL_PATCHES.map((p) => ({
    id: p.id,
    name: p.name,
    layer: p.layer,
    onMiss: p.onMiss || "fail",
    strictFiles: Boolean(p.strictFiles),
    files: Array.isArray(p.file) ? p.file : [p.file],
    status: patchView.status[p.id] || "unknown",
  }));
  const files = {};
  for (const [key, fp] of Object.entries(state.files || {})) {
    const row = { path: fp, exists: false, markers: 0, bak: false, bytes: 0 };
    try {
      row.exists = fs.existsSync(fp);
      if (row.exists) {
        const text = fs.readFileSync(fp, "utf8");
        row.bytes = Buffer.byteLength(text, "utf8");
        // 标记数是判断「文件被本插件改过」的唯一可靠指纹（PATCH-2 要求每条补丁有 marker）。
        row.markers = (text.match(/dsh-purge/g) || []).length;
      }
      row.bak = fs.existsSync(`${fp}.dshpurge.bak`);
    } catch (e) {
      row.error = String(e && e.message ? e.message : e);
    }
    files[key] = row;
  }
  // 安装树体检：`app.asar` / `app` / `runtime` 三者的关系，以及官方更新器留下的痕迹。
  // 这一段的判据在 lib/host/install-health.js，CLI 只负责把结论原样交出去 ——
  // 「runtime 空目录」那种变砖现场，事后唯一能拿来定性的就是这份 JSON。
  const installHealth = inspectHostInstall(state.desktop_exe || "");
  return {
    generated_at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cwd: process.cwd(),
    surface: state.surface,
    dsh_home: state.dsh_home,
    ai_base: state.ai_base,
    plugin_version: state.plugin_version,
    host_version: state.host_version,
    dsh_target: state.dsh_target,
    version_gate: state.version_gate,
    asar_still_sealed: state.asar_still_sealed,
    shim_dir: state.shim_dir,
    shim: { cmd: state.shim_cmd, ps1: state.shim_ps1, bin: state.shim_bin },
    has_backup: state.has_backup,
    override: { path: state.override_path, status: state.override_status },
    // 安装完整性 + 官方更新器痕迹：`app.asar` / `app` / `runtime` 三者关系、待装包与通道。
    install_health: installHealth,
    updater: installHealth.updater,
    log_path: diagLogPath(state.dsh_home),
    env: {
      DSH_HOME: process.env.DSH_HOME || "",
      DSH_BASE: process.env.DSH_BASE || "",
      DSH_SURFACE: process.env.DSH_SURFACE || "",
      DSH_PURGE_LOG: process.env.DSH_PURGE_LOG || "",
    },
    // 计数给两种口径：`raw` 按补丁号（下面的 `patches[]` 就是这一份，66 条），
    // `display` 按展示行（同一清洗的升级链并成一行，62 行）。早先这里只给 display 的
    // 计数、配 raw 的明细，同一份 JSON 里两个分母且没有一处标注 —— 见 lib/patch/counts.js。
    counts: {
      base: "raw",
      raw: patchView.counts.raw,
      display: patchView.counts.display,
      summary: countsLine(patchView.counts),
    },
    // 安装态：这棵树是怎么装的、和记录是否一致。手工覆盖过 node_modules 时，
    // 这里的 drifted 就是「下次 pnpm install 会静默盖回旧版」的预警。
    install: checkInstallState(state.dsh_home, PLUGIN_ROOT),
    // 启动器指向哪：asar 已解封（app.asar.bak）时，官方硬编码的 dsh.cmd 会失效，
    // 这一项把那个耦合变成可查询的事实，而不是等 `dsh plugin add` 报 MODULE_NOT_FOUND。
    launcher: inspectLauncher(core.findDesktopShimDir() || state.shim_dir),
    files,
    patches,
  };
}

function printStatus(state) {
  const out = [];
  // 计数与逐条状态从状态层契约取，CLI 与端点读同一份聚合。
  const patchView = contract.patchBlock(state, core.ALL_PATCHES);
  out.push("dsh-purge 状态 / Status");
  out.push("  宿主 / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  if (state.desktop_install) out.push("  桌面安装       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  插件根 / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  插件根 / root  " + core.missingAiBaseMessage());
  }
  out.push(`  shim 目录      ${state.shim_dir || "未定位 / not found"}`);
  out.push(`  备份 / backup  ${state.has_backup ? "有 / yes" : "无 / no"}`);
  out.push(`  注入文件       ${state.override_path}`);
  out.push(`  注入状态       ${state.override_status}`);
  out.push("");
  // 宿主版本变过 = 官方升级把补丁树整棵换掉了。这一行放在状态最上面：它是可执行结论，
  // 不是统计 —— 用户看完就知道下一步是重新 apply，而不是去查谁改了文件。
  let drift = { recorded: "", current: "", changed: false, known: false };
  try {
    drift = reapply.appliedStampHostDrift();
  } catch {
    // 账本读不动不影响状态本身
  }
  if (drift.changed) {
    out.push(`  ⚠ 宿主已升级 ${drift.recorded} → ${drift.current}：补丁树已被官方更新覆盖，请重新 --apply`);
    out.push("");
  } else if (state.ai_base && !drift.known) {
    out.push("  · 账本里没有宿主版本（老戳），「宿主换过」这一档不可判");
    out.push("");
  }
  // 安装完整性：这一行回答的是「这棵树还能启动吗」。它与补丁状态是两件事 ——
  // runtime 被官方更新清空时，补丁可以一条不缺，而桌面端起不来。
  let installHealth = null;
  try {
    installHealth = inspectHostInstall(state.desktop_exe || "");
  } catch {
    installHealth = null;
  }
  if (installHealth && installHealth.reason !== "ok" && installHealth.reason !== "no-resources") {
    if (installHealth.ok === true) {
      // `ok === true` 而 reason 不是 ok：**健康，但有话要说**。解封态就是这一档 ——
      // 归档已挪开、宿主读补丁树、应用正常运行，只是「升级官方前要先恢复归档」。
      // 复用「安装不完整」那套 ⚠ 语气是错的：它会让读者去修一棵本来就好的树。
      out.push(`  ℹ ${installHealth.reason === "unsealed" ? "解封态" : "注意"}：${installHealth.detail}`);
      if (installHealth.remedy) out.push(`    ${installHealth.remedy}`);
    } else if (installHealth.reason === "archive-shadows-app") {
      // 归档压着解开的树：宿主读官方归档，补丁不生效。它**不是**「安装不完整」——
      // 照后者的处置去 unseal，启动的会是一棵只打了一半的树。所以这一档单独说。
      out.push("  ⚠ 补丁未生效：官方归档与解开的树同时存在，宿主读的是归档");
      out.push("    · 若上一轮应用没洗完，重跑一次应用（--apply）接着做；");
      out.push("    · 确认不再应用之后才 --unseal —— 没洗完就 unseal 会让宿主读到半成品树");
    } else {
      out.push(`  ⚠ 宿主安装不完整（${installHealth.reason}）：${installHealth.detail}`);
      if (installHealth.remedy) out.push(`    恢复：${installHealth.remedy}`);
    }
    out.push("");
  }
  if (!state.ai_base) {
    // 官方桌面端的宿主树在 app.asar 里，诊断路径不负责解包，所以这里定位不到是正常的。
    // 打 82 行 undefined 只会被读成「全都没打上」，不如直接说清原因与下一步。
    out.push("  补丁 未评估 —— 宿主树未定位（asar 密封时由 --apply 负责解开并接管）");
  } else {
    out.push(`  ${countsLine(patchView.counts)}`);
    for (const p of core.ALL_PATCHES) {
      // patch_status 只在实际定位到宿主时才有键；契约把缺省补成 "unknown" / "na"。
      const s = patchView.status[p.id] || "unknown";
      const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
      out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
    }
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  // 安装指纹对不上 = 这棵树被手工改过（或被重装成别的版本）。不阻断任何操作，但必须可见：
  // 下一次 pnpm install / dsh plugin add 会把痕迹盖回去。
  const install = checkInstallState(state.dsh_home, PLUGIN_ROOT);
  if (install.state && !install.ok) {
    const touched = [...install.drifted, ...install.missing].slice(0, 5).join(", ");
    out.push("");
    out.push(`  ⚠ 安装指纹与记录不一致（drifted ${install.drifted.length} / missing ${install.missing.length} / added ${install.added.length}）`);
    out.push(`    这棵树被手工改过，下次安装会盖回记录里的版本${touched ? `：${touched}` : ""}`);
  }
  return out.join("\n");
}

/**
 * 还原判据的命令行出口。
 *
 * 为什么单列：`revertContentParity` 原先只进诊断轨，CLI 打印的四个计数回答的是
 * 「动了几个文件」，回答不了「回到原版没有」。这里把 `ok / complete / 判红文件`
 * 打出来，退出码由调用方按「有没有判红」决定。
 *
 * @param {Array<object>} rows `revertAllHosts().parity`
 * @returns {{ok:boolean, complete:boolean, mismatched:Array<[string,string]>, unscanned:string[]}}
 */
function printRevertParity(rows) {
  const parity = summarizeRevertParity(rows);
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("  内容判据 / parity: 不可判（未定位宿主）");
    return parity;
  }
  console.log(
    `  内容判据 / parity: ok=${parity.ok} complete=${parity.complete}`
    + ` 判红=${parity.mismatched.length} 不可判=${parity.unscanned.length}`,
  );
  for (const [fp, reason] of parity.mismatched) console.log(`  ✗ ${fp}（${reason}）`);
  if (parity.unscanned.length > 0) {
    console.log(`  · 不可判 ${parity.unscanned.length} 个文件：没有官方快照，也没有本插件痕迹`);
  }
  return parity;
}

/**
 * CLI `--apply` 的审计落账：与另外三个入口共用 lib/audit 的同一段落账实现。
 *
 * 写不进去不改变命令结论 —— 审计记录的是 apply，不是 apply 的前提。
 * `entry` 写死成 `cli`：这一轮是谁触发的必须留在审计行上，而不是只留在会滚掉的诊断轨里。
 *
 * @returns {{rows:Array<object>, counts:object, record:object}|null}
 */
function recordCliApplyAudit({ state, report, targets, before, runId }) {
  try {
    return recordApplyRun({
      dshHome: state.dsh_home,
      report,
      patches: core.ALL_PATCHES,
      targets,
      before,
      runId,
      entry: "cli",
    });
  } catch (e) {
    console.warn("[dsh-purge] audit:", String(e && e.message ? e.message : e));
    return null;
  }
}

async function main() {
  // `audit` 是只读子命令：判的是磁盘上的日志文件，与宿主、补丁状态都无关。
  // 所以在 gatherState 之前分流 —— 「日志残缺」正是最需要判的时候，那一刻宿主
  // 可能未定位、插件可能没装全，判据不能以那些前提为准。
  if (args[0] === "audit") {
    const rest = args.slice(1);
    const sub = rest[0];
    // 退出码交给 process.exitCode 而不是 process.exit：这条命令的产出就是 stdout，
    // 立即退出有截断管道缓冲的风险，而「判据输出不完整」正是它要防的那种残缺。
    process.exitCode = sub === "tail" || sub === "why" || sub === "remedy"
      ? runAuditQuery(rest, undefined, { dshHome: core.findDshHome() })
      : runAuditCli(rest);
    return;
  }

  const mode = args.find((a) => ["--apply", "--revert", "--unseal", "--uninstall", "--status", "--diagnose", "--edit", "--help"].includes(a));

  if (mode === "--help" || args.includes("-h")) {
    console.log(`dsh-purge 用法:
  dsh-purge --status     显示状态
  dsh-purge --diagnose   输出结构化体检单（JSON，含每个目标文件是否存在/有无标记/有无备份）
  dsh-purge --apply      应用全部清洗（密封官方包会自动解开 app.asar 并接管）
  dsh-purge --unseal     只把 app.asar 挪开，让下次启动的桌面端读补丁树（不拉起 GUI）
  dsh-purge --revert     回滚还原
  dsh-purge --uninstall  卸载插件（已应用则先还原）
  dsh-purge --edit       编辑注入文件 prompt-inject.md
  dsh-purge audit check  判审计日志完整性（断号 / 坏行 / 末行截断）
  dsh-purge audit tail   最近 N 条审计行（--n / --runId / --layer / --event / --status / --json）
  dsh-purge audit why <runId>  一轮审计行 + 诊断轨 apply.start/apply.end 对账
  dsh-purge audit remedy [id]  症候 → 字段 → 命令 → 动作 的可执行卡片
  dsh-purge --help       帮助

诊断日志: <DSH_HOME>/dsh-purge/logs/diag.jsonl（DSH_PURGE_LOG_FILE 可改路径，DSH_PURGE_LOG=0 关闭）`);
    return;
  }

  const state = await core.gatherState();
  // 每次调用先落一条入口记录：远程无人值守时，能不能对上「跑的是哪一版、哪个 mode」全靠它。
  diagLog("cli.invoke", {
    mode: mode || "(none)",
    args: args.join(" "),
    node: process.version,
    surface: state.surface,
    dsh_home: state.dsh_home,
    ai_base: state.ai_base || "(none)",
    plugin_version: state.plugin_version,
  }, state.dsh_home);

  if (mode === "--diagnose") {
    const payload = diagnosePayload(state);
    const out = JSON.stringify(payload, null, 2);
    diagLog("cli.diagnose", {
      counts: payload.counts.summary,
      counts_base: payload.counts.base,
      pending_raw: payload.counts.raw.pending,
      pending_display: payload.counts.display.pending,
      asar_sealed: payload.asar_still_sealed,
      gate: Boolean(payload.version_gate && payload.version_gate.allowed),
    }, state.dsh_home);
    // 故障受理时把 stdout 重定向到文件即可存档，不需要额外开关。
    console.log(out);
    return;
  }

  console.log(printStatus(state));
  console.log("");

  if (mode === "--apply") {
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      diagLog("cli.apply.abort", { reason: "empty_inject" }, state.dsh_home);
      console.log("[ERROR] 提示词和规则集都是空的，必须先添加提示词");
      process.exit(1);
    }
    // 密封官方包必须先走 ensureHostClean：它负责解开 app.asar、接管 resources/app、
    // 打补丁、写 shim，并在「有待清洗项 / 有硬失败 / shim 没落地」时判定失败。
    // 只调 applyPatchesAllHosts 会在密封包上一条补丁也定位不到（宿主树还在归档里），
    // 而面板「应用」走的正是 ensureHostClean —— 两条路径必须同源。
    const sealed = core.desktopAsarStillSealed();
    diagLog("cli.apply.begin", { sealed, inject_source: inject.source }, state.dsh_home);

    let hosts = [];
    let applyReport = [];
    let applyEvidence = core.emptyApplyEvidence();
    let auditTargets = {};
    let auditBefore = {};
    // 安全阀还原失败：面板那条路把它当「这一轮没洗完」的一档，账本判据要与它同源。
    // 密封分支的 ensureHostClean 不返回这个字段（它在内层的 applyPatchesAllHosts 里），
    // 那一档按「没有报告」处理 —— ensureHostClean 自己的 ok 已经挡掉了 pending / 硬失败 / flash。
    let hookDenyRestoreFailed = false;
    // 一次 --apply 一个身份：诊断轨与审计轨按同一个 runId join，两条分支都沿用它。
    const applyRunId = newApplyRunId();

    /**
     * 把这一轮**发生了什么**写进版本账本。事实与身份两件事分开，实现与宿主侧三个入口共用
     * （`reapply.recordApplyRound`）：事实每轮都写，身份（`run_id` / `audit`）只给干净轮。
     *
     * 为什么密封分支的失败路径必须调它：原先这段只在**成功收尾**那一小段里，而密封分支
     * 失败时在它之前就 `process.exit(1)` 了 —— 换宿主版本后第一轮真写过的字节一条也没进
     * 账本，下一轮账本仍指旧世代，那几条补丁于是永远认证不了自己。失败轮的事实最值钱。
     *
     * @param {{report:Array<object>, evidence:object, bases:Array<object>,
     *   hookDenyRestoreFailed:boolean, roundFailed:boolean}} input
     */
    const recordRoundFacts = ({ report, evidence: ev, bases, hookDenyRestoreFailed: hookFailed, roundFailed }) => {
      const hostWritten = core.allPatchHostsWritten(bases)
        || core.hostCleanMarkersPresent(bases[0]?.aiBase || state.ai_base);
      const round = reapply.recordApplyRound({
        entry: "cli",
        runId: applyRunId,
        report,
        evidence: ev,
        hostWritten,
        hookDenyRestoreFailed: hookFailed,
        roundFailed,
      });
      if (round.error) console.warn("[dsh-purge] applied.json:", round.error);
      return { ...round, hostWritten };
    };

    if (sealed) {
      // 密封包走 ensureHostClean，它内部才转到引擎；身份在 CLI 这一层声明一次就够了，
      // sealed 是事实不是身份，单独一个布尔 —— 同一个 entry 不该为了它劈成两个取值。
      const cleaned = await withApplyRun(
        { entry: "cli", runId: applyRunId, sealed: true },
        () => core.ensureHostClean({
          // before 摘要只有在引擎动手之前采得到：ensureHostClean 解开归档、解析出宿主后
          // 立即回调，这里采到的就是「改之前」。
          onBeforeApply: ({ bases, aiBase }) => {
            auditTargets = core.targetFiles(aiBase || bases[0]) || {};
            auditBefore = collectApplyBefore(core.ALL_PATCHES, auditTargets);
          },
        }),
      );
      diagLog("cli.apply.ensure", {
        ok: cleaned.ok,
        error: cleaned.error || "",
        pending: (cleaned.pending || []).join(","),
        failed: cleaned.failed ?? "",
        hosts: (cleaned.hosts || []).join(","),
      }, state.dsh_home);
      // 失败也要落账：这一轮可能已经改了一半，「改了哪些文件」正是那时候最需要的证据。
      applyReport = Array.isArray(cleaned.report) ? cleaned.report : [];
      applyEvidence = cleaned.evidence || core.collectApplyEvidence((cleaned.hosts || []).map((aiBase) => ({ aiBase })));
      hookDenyRestoreFailed = (cleaned.hookDenyRestoreFailed || []).length > 0;
      if (!cleaned.ok) {
        // 失败轮**先把事实写进账本再退出**：这一轮可能已经改了一半，「改了哪些文件」正是
        // 那时候最需要的证据；而缺了它，下一轮账本仍指旧世代，真写过的补丁永远认证不了自己。
        // 密封分支的 host 是在 ensureHostClean 内层解析出来的，那边已经把 bases 交回来了。
        recordRoundFacts({
          report: applyReport,
          evidence: applyEvidence,
          bases: (cleaned.hosts || []).map((aiBase) => ({ aiBase })),
          hookDenyRestoreFailed,
          roundFailed: true,
        });
        recordCliApplyAudit({ state, report: applyReport, targets: auditTargets, before: auditBefore, runId: applyRunId });
        console.log("[ERROR] " + (cleaned.error || "清洗未完成"));
        if ((cleaned.pending || []).length) console.log("  仍待清洗: " + cleaned.pending.join(","));
        if (cleaned.leftExtract) {
          // 说清这一轮留下了什么：宿主此刻跑的是官方归档，补丁一处也没生效；解开的树
          // 留在 resources/app 供下次接着做。不说明白，读的人会以为「安装坏了」。
          console.log("  宿主当前仍从官方归档启动（补丁未生效）；解开的树留在 resources/app，");
          console.log("  下次 --apply 会接着清洗它。别在这一轮之后去 --unseal。");
        }
        console.log("  详见日志 " + diagLogPath(state.dsh_home));
        process.exit(1);
      }
      hosts = (cleaned.hosts || []).map((aiBase) => ({ aiBase }));
    } else {
      // 非密封路径的宿主根在 apply 之前就已知：先采 before，再动手。
      try {
        auditTargets = core.targetFiles(state.ai_base) || {};
        auditBefore = collectApplyBefore(core.ALL_PATCHES, auditTargets);
      } catch (e) {
        auditTargets = {};
        auditBefore = {};
        console.warn("[dsh-purge] audit before:", String(e && e.message ? e.message : e));
      }
      const result = await withApplyRun(
        { entry: "cli", runId: applyRunId, sealed: false },
        () => core.applyPatchesAllHosts(core.ALL_PATCHES, {
          preserveClientBundles: false,
          forApply: true,
        }),
      );
      hosts = result.hosts;
      applyReport = Array.isArray(result.report) ? result.report : [];
      applyEvidence = result.evidence || core.collectApplyEvidence(result.hosts);
      hookDenyRestoreFailed = (result.hookDenyRestoreFailed || []).length > 0;
    }
    if (!hosts.length) {
      // 引擎（与面板同一个解析器）都找不到宿主，才是真的没有目标。
      const msg = core.missingAiBaseMessage();
      diagLog("cli.apply.abort", { reason: "no_ai_base", detail: msg }, state.dsh_home);
      console.log("[ERROR] " + msg);
      console.log("  fix: 把 DSH_BASE 指到含 dsh-agent-instructions/lib 的 @deepseek-ai 目录");
      process.exit(1);
    }
    // CLI 这条路此前只写诊断轨；落账与另外三个入口共用同一段实现。
    const audited = recordCliApplyAudit({ state, report: applyReport, targets: auditTargets, before: auditBefore, runId: applyRunId });

    // 版本账本：四个 apply 入口（面板 / 命令 / 工具 / CLI）在收尾时把这一轮**发生了什么**
    // 写进 `applied.json`。两件事分开记，实现在 `recordRoundFacts` 一处：
    //   · 事实（写过 / 核对过哪些字节、宿主是谁、这一轮几个 applied / pending）—— 每轮都写。
    //     不写的话，只要有一条 pending，这一轮就永远认证不了自己：pending 让轮次不干净，
    //     不干净就不写账本，账本不写下一轮还判 pending。那是跨代「要跑两次 apply」的死循环。
    //   · 身份（`run_id` / `audit`）：最后一次**成功收尾**的是哪一轮 —— 只记干净轮。
    const round = recordRoundFacts({
      report: applyReport,
      evidence: applyEvidence,
      bases: hosts,
      hookDenyRestoreFailed,
      roundFailed: false,
    });
    if (round.clean && audited && audited.record) {
      try {
        reapply.noteAppliedAudit({
          runId: applyRunId,
          events: audited.record.events,
          layers: audited.record.layers,
          unresolved: audited.record.unresolved,
        });
      } catch (e) {
        console.warn("[dsh-purge] applied.json:", String(e && e.message ? e.message : e));
      }
    }
    if (!round.clean) {
      // 事实写了、身份没写，也要说清是哪一档没过 —— 读的人才知道「最后一次成功 apply」没动。
      console.log(
        `  · 本轮未按干净轮收尾（failed=${round.round.failed} hostWritten=${round.hostWritten}`
        + ` hookDenyRestoreFailed=${hookDenyRestoreFailed}）：账本记了本轮事实，`
        + "但「最后一次成功 apply」仍指向上一次",
      );
    }

    // 逐条状态以磁盘现状为准：ensureHostClean 路径拿不到 applyPatches 的逐条 report，
    // 而重新 gatherState 对两条路径都成立，也让输出与下次 --status 完全一致。
    const after = await core.gatherState();
    const afterView = contract.patchBlock(after, core.ALL_PATCHES);
    for (const h of hosts) console.log(`  宿主 / host → ${h.aiBase}`);
    for (const p of core.ALL_PATCHES) {
      const s = afterView.status[p.id] || "unknown";
      const mark = s === "applied" ? "✓ 已清洗" : s === "pending" ? "✗ 待清洗" : s === "skipped" ? "· 跳过" : `· ${s}`;
      console.log(`  ${mark.padEnd(12)} [#${String(p.id).padEnd(2)}] ${p.name}`);
    }
    // 待清洗清单也读契约：CLI 不再自己按 patch_status 过滤一遍。
    const patchById = new Map(core.ALL_PATCHES.map((p) => [String(p.id), p]));
    const unresolved = afterView.pendingIds.map((id) => patchById.get(id)).filter(Boolean);
    const flashHost = hosts[0]?.aiBase || after.ai_base;
    const flash = flashHost ? core.silenceCmdFlash(flashHost) : { entry: false, phase1: false, ok: false };
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    diagLog("cli.apply.done", {
      hosts: hosts.length,
      applied: after.patches_applied,
      pending: after.patches_pending,
      skipped: after.patches_skipped,
      total: after.patches_total,
      inject_source: inject.source,
      flash_ok: flash.ok,
      asar_sealed: after.asar_still_sealed,
      // 审计轨这一轮落了几行：0 说明报告为空（没跑到逐补丁判定），不是「审计没写」。
      audit_events: audited ? audited.record.events : 0,
      log: diagLogPath(state.dsh_home),
    }, state.dsh_home);
    if (unresolved.length) {
      console.log("");
      console.log(`  ⚠ ${unresolved.length} 条仍待清洗（详见日志 ${diagLogPath(state.dsh_home)}）`);
      for (const p of unresolved.slice(0, 10)) console.log(`    #${p.id} ${p.name}`);
    }
    if (hosts.length > 1) {
      console.log(`  多宿主 / multi-host: ${hosts.length} 份 @deepseek-ai 已清洗`);
    }
    console.log(inject.source === "rule"
      ? "  - 使用当前规则集，不改写提示词文件"
      : "  - 使用已有提示词文件");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} 注入 / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} 已注入 / already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} 不存在 / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  - shim 目录未定位（密封包由 ensureHostClean 内部处理）");
    }
    if (after.asar_still_sealed) {
      console.log("");
      console.log("  ⚠ app.asar 仍密封：补丁写在 resources/app，宿主当前进程读不到。");
      console.log("    执行 dsh-purge --unseal 把归档挪开，之后启动的桌面端才会读补丁树。");
    }
    console.log("");
    console.log("全部完成 / All done。重启 dsh 生效 / Restart dsh to take effect.");
  } else if (mode === "--unseal") {
    // 只做「把 app.asar 挪开」这一步，不拉起 GUI：远程/无人值守环境下何时启动由使用者决定。
    //
    // 已知副作用（2026-10-23 实测）：官方启动器 `resources/runtime/cli/bin/dsh.cmd` 里写死了
    // `app.asar\dsh\...\dsh-desktop-host\lib\cli.js`。归档被挪走之后，`dsh` 命令会
    // MODULE_NOT_FOUND 全线失效（装/卸插件、doctor 都做不了），而桌面端 GUI 仍正常
    // （Electron 会回落到 resources/app）。要临时恢复 CLI：把 app.asar.bak 改回 app.asar，
    // 做完插件操作再解封。`--diagnose` 的 launcher 字段会显示当前指向。
    const handoff = core.sealedAsarHandoff();
    if (!handoff) {
      console.log("  当前不是密封官方包，无需解封。");
    } else {
      // 前置检查与 unseal 标记都在 `core.scheduleSealedDesktopRestart` 里：那条路径与面板
      // 点「应用」后的自动交换共用，检查只该有一处（两条路各判一次早晚判不一样）。
      const moved = core.scheduleSealedDesktopRestart(handoff);
      diagLog("cli.unseal", {
        asar: handoff.asar,
        renamed: moved.renamed,
        pending: moved.pending || false,
        busy: moved.busy || false,
        update_pending: moved.updatePending?.installer || "",
      }, state.dsh_home);
      if (moved.renamed) {
        console.log(`  ✓ 已挪走 ${handoff.asar}`);
        console.log("    下次启动桌面端会读 resources/app（已含补丁）。");
      } else if (moved.busy) {
        console.log("  ⚠ 归档被占用（宿主还在跑）。完全退出桌面端后再执行一次。");
      } else {
        console.log("  · 已安排：宿主空闲时挪走归档。");
      }
      if (moved.updatePending) {
        console.log(`  ⚠ 盘上有待装官方更新包（${moved.updatePending.channel || "未知通道"}）：`);
        console.log(`    ${moved.updatePending.installer}`);
        console.log("    解封态下让它装上去，官方更新会重写 resources 并清空 runtime；");
        console.log(`    装完起不来就执行：${moved.updatePending.recovery}`);
      }
    }
  } else if (mode === "--revert") {
    let revertParity = [];
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors, parity } = await core.revertAllHostsFor("cli");
      revertParity = parity || [];
      for (const p of reverted) console.log(`  ✓ 已还原 / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ 还原失败 ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - 没有补丁备份可还原 / no patch backup");
      diagLog("cli.revert.done", {
        files: reverted.length,
        errors: errors.length,
        detail: errors.slice(0, 5).map(([p, e]) => `${p}: ${e}`).join(" | "),
      }, state.dsh_home);
    }
    const verdict = printRevertParity(revertParity);
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
    console.log("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
    // 有判红文件 = 宿主没有回到原版。退出码是这条判据唯一的机器可读出口。
    if (verdict.mismatched.length > 0) process.exitCode = 1;
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  已检测到补丁，已还原回原版。");
    else console.log("  未检测到已应用补丁，仍会清除插件文件。");
    if (result.override?.removed) console.log(`  已删除 ${result.override.path}`);
    if (result.stripped?.length) console.log(`  已从 profile 移除: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    const parityVerdict = printRevertParity(result.patches?.parity || []);
    if (!result.ok) {
      console.log("  卸载中止：还原失败，插件文件未删除。");
      process.exit(1);
    }
    // 卸载是否成功与「宿主回到原版没有」是两件事：插件删干净了，但某个目标文件
    // 仍与官方快照对不上时，退出码必须把这件事带出去。
    if (parityVerdict.mismatched.length > 0) process.exitCode = 1;
    console.log("");
    console.log("卸载完成。请重启 dsh。");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ 已创建默认注入文件：${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → 已打开 ${r.editor} 编辑注入文件：${r.path}`);
    }
    console.log("  编辑完成后重启 dsh 生效。");
  } else {
    console.log("默认不清洗，使用 --apply 应用清洗。");
  }
}

main().catch((e) => {
  // 未捕获异常也要留痕：远程跑的时候 stderr 常被吞掉，日志是唯一证据。
  diagError("cli.fail", e, { args: args.join(" ") });
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
