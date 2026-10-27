/**
 * lib/audit/remedy.js — 把「日志说了什么」折成「下一步试什么」的可执行卡片。
 *
 * 为什么需要它：读法文档能教会一个人怎么看日志，却教不会一个只会读日志的 AI
 * 「现在该跑哪条命令」。症候 → 字段 → 命令 → 动作这四段如果只写在散文里，
 * 每次都要靠读者自己拼；写成数据表就能被查询面直接吐出来，也能被用例逐条判。
 *
 * 每张卡三件事，与外部审计实现（CHECK / ACTION / DECISION 三类 step）同形：
 *   check    —— 去哪个文件、看哪个字段（读的人据此复核，不必信这张卡）
 *   action   —— 下一步真能跑的命令（可执行的那一条）
 *   decision —— 命令结果怎么读成结论（有它才不会被「看起来正常」骗过去）
 *
 * 一张卡不许只有 advice：`action` 必须是能直接粘进终端的命令，`decision` 必须能判真假。
 * 缺任何一段，读者就只剩「再查查」这种没有信息量的话。
 *
 * 本模块只做纯数据与纯函数：不读文件、不碰宿主。判定由调用方把现场（一次 apply 的
 * 轮结论、诊断轨行、跨轨对账结果）传进来，这里只负责「哪种现场该给哪张卡」。
 */

/** 五个入口不写审计轨：查不到它们的审计行是设计边界，不是丢日志。清单只有一份，从对账模块取。 */
import { AUDIT_EXEMPT_ENTRIES } from "./runs.js";

/**
 * 卡片表。id 是稳定键（输出与用例都用它），改文案不改 id。
 *
 * `needsHost` 为真表示那条命令要真宿主才跑得动（本机没有可运行入口）；
 * 其余命令在仓库根就能跑，只是路径参数要按实际机器替换。
 */
export const REMEDY_CARDS = Object.freeze([
  Object.freeze({
    id: "version-gate-reject",
    symptom: "版本门禁拒绝：一个字节都没写",
    fields: ["apply.gate.reject.hostVersion", "apply.gate.reject.dshTarget"],
    check: "node bin/dsh-purge.js --diagnose",
    action: "换匹配的宿主版本，或换与宿主版本对应的补丁表；不要放宽门禁",
    decision: "hostVersion 与 dshTarget 不相等 ⇒ 不是补丁写错，是这批补丁不该打在这版宿主上",
    needsHost: true,
    confidence: "high",
    approvalRequired: false,
  }),
  Object.freeze({
    id: "patch-hard-miss",
    symptom: "补丁硬 miss / 读写失败",
    fields: ["apply.patch.status", "{层}.patch-miss.detail.status"],
    check: "node bin/dsh-purge.js --diagnose",
    action: "拿补丁号与名字查它的目标文件与 marker；文件在而 marker 不在，说明宿主那版已经改过这段代码",
    decision: "pattern_not_found 且 on-miss 是 fail / strictFiles ⇒ 真失败；read_error / write_error 也是失败（没判出来）",
    needsHost: true,
    confidence: "high",
    approvalRequired: false,
  }),
  Object.freeze({
    id: "missing-file",
    symptom: "补丁缺件（missing_file）",
    fields: ["apply.patch.status", "apply.end.missingFile"],
    check: "node bin/dsh-purge.js audit tail --n 50 --event code.patch-",
    action: "确认这批候选路径确实不该存在（当前宿主不装那几个包）；不要当成失败去修",
    decision: "missing_file 不在 failed 里，也不算读写错误 ⇒ 正常形态，继续查同轮有没有 read_error / write_error",
    needsHost: false,
    confidence: "high",
    approvalRequired: false,
  }),
  Object.freeze({
    id: "run-truncated",
    symptom: "这一轮在审计轨里被截断",
    fields: ["runs.detail[].closed", "runs.detail[].sealed", "runs.detail[].reasons"],
    check: "node bin/dsh-purge.js audit check --dir <审计目录>",
    action: "重跑一次同样的入口，看是否复现；中断点之前最后一条事件就是现场",
    decision: "判据只有一条：这一轮有没有 detail.runEnd（结束标记）。sealed=false 且 judgeable=true ⇒ 真截断；"
      + "judgeable=false ⇒ 旧口径写的轮，判不了，别当截断",
    needsHost: false,
    confidence: "high",
    approvalRequired: false,
  }),
  Object.freeze({
    id: "log-corrupt",
    symptom: "日志断号 / 坏行 / 末行没换行",
    fields: ["gaps", "badLines", "lastLineTerminated"],
    check: "node bin/dsh-purge.js audit check --jsonl <某一天的审计文件>",
    action: "先看断号是不是跨文件轮转（每个文件各自从 0 起，跨文件不连续是正常的）",
    decision: "gaps 非空且在同一文件内 ⇒ 真断号；badLines 指出第几行解析不了（1-based），只损失那一行",
    needsHost: false,
    confidence: "high",
    approvalRequired: false,
  }),
  Object.freeze({
    id: "record-incomplete",
    symptom: "层结论的 completeness 有假项",
    fields: ["{层}.apply-result.detail.completeness", "{层}.apply-result.detail.unresolved"],
    check: "node bin/dsh-purge.js audit why <runId>",
    action: "看 files 假在这一层哪几个落点：before 没采到、或补丁没有可落账的落点",
    decision: "completeness 任一项为假 ⇒ 记录不完整（缺口）；三项全真而 result=partial ⇒ 层内部分成功，正常",
    needsHost: false,
    confidence: "high",
    approvalRequired: false,
  }),
  Object.freeze({
    id: "cross-mismatch",
    symptom: "两轨对不上（补丁号或状态不同）",
    fields: ["cross.problems", "cross.matched", "cross.unmatched"],
    check: "node bin/dsh-purge.js audit check --jsonl <审计文件> --diag <DSH_HOME>/dsh-purge/logs/diag.jsonl",
    action: "两侧按同一个 runId 各搜一次；一边 0 命中时先看入口是不是不写审计的那五个",
    decision: "问题只报「缺这个补丁号 / 状态不同」；补丁号次序不同不判红（两轨排序规则不同）",
    needsHost: false,
    confidence: "high",
    approvalRequired: false,
  }),
  Object.freeze({
    id: "audit-not-written",
    symptom: "诊断轨有这一轮，审计轨 0 行",
    fields: ["apply.start.entry", "cross.problems"],
    check: "node bin/dsh-purge.js audit why <runId>",
    action: "看 apply.start 的 entry：startup-auto / reapply / reapply-cli / http-restart 今天不写审计轨",
    decision: "entry 在那五个里 ⇒ 设计边界；不在 ⇒ 真的没落账，去查 apply.audit.fail",
    needsHost: false,
    confidence: "high",
    approvalRequired: false,
  }),
  Object.freeze({
    id: "restart-not-effective",
    symptom: "改了文件，但看不出生效",
    fields: ["apply.end.pendingRestart", "startup.ready.patchesMatch", "startup.ready.appliedStamp"],
    check: "Select-String -Path <DSH_HOME>\\dsh-purge\\logs\\diag.jsonl -SimpleMatch 'startup.ready'",
    action: "完整退出宿主再启动一次；只重载插件不算（运行中的进程不会重读模块与提示词）",
    decision: "pendingRestart=true 且其后没有 startup.ready ⇒ 没重启过；有 startup.ready 但 patchesMatch=false ⇒ 启动了、补丁没对齐",
    needsHost: false,
    confidence: "high",
    approvalRequired: false,
  }),
  Object.freeze({
    id: "asar-still-sealed",
    symptom: "补丁写在解包目录，宿主仍读密封归档",
    fields: ["apply.end.asarSealed", "cli.apply.done.asar_sealed"],
    check: "node bin/dsh-purge.js --unseal",
    action: "先把 app.asar 挪开（或解开）再启动；否则新起的进程读到的还是归档里的旧字节",
    decision: "asarSealed=true 且 pendingRestart=true ⇒ 连重启也不够，得先换归档",
    needsHost: true,
    confidence: "medium",
    approvalRequired: true,
  }),
  Object.freeze({
    id: "revert-not-audited",
    symptom: "revert 的 runId 在审计轨查不到",
    fields: ["revert.start.runId", "revert.end.runId"],
    check: "node bin/dsh-purge.js audit why <revert 的 runId>",
    action: "改读诊断轨的 revert.start / revert.file / revert.end（它们带 entry 与 runId）",
    decision: "审计轨只记 apply，不记 revert ⇒ 审计侧为空是设计边界，不是丢日志",
    needsHost: false,
    confidence: "high",
    approvalRequired: false,
  }),
  Object.freeze({
    id: "status-skipped-not-miss",
    symptom: "补丁是 skipped 却不是 pattern_not_found",
    fields: ["{层}.patch-skipped.detail.status", "evidence.hits"],
    check: "node bin/dsh-purge.js audit tail --n 50 --layer code --event code.patch-",
    action: "看这条行的 detail.status：already 是文件里已经有 marker，skipped 是这一轮不需要动",
    decision: "skipped 不等于失败；apply.end 不统计 skipped，所以总数与 applied+already 的差要去 apply.patch 里数",
    needsHost: false,
    confidence: "high",
    approvalRequired: false,
  }),
]);

const CARD_BY_ID = new Map(REMEDY_CARDS.map((card) => [card.id, card]));

/** 按 id 取卡；没有就返回 null（不猜近似的 id）。 */
export function remedyCard(id) {
  return CARD_BY_ID.get(String(id ?? "")) ?? null;
}

/** 一次 apply 的现场：调用方把已经算出来的东西传进来，这里不重复读盘。 */
function hasEvent(rows, name) {
  return (Array.isArray(rows) ? rows : []).some((row) => row && row.event === name);
}

function anyStatusMatches(rows, pattern) {
  return (Array.isArray(rows) ? rows : []).some((row) => {
    const status = row && row.detail ? String(row.detail.status ?? "") : "";
    return pattern.test(status);
  });
}

/**
 * 从现场挑出该给的卡片。
 *
 * 输入字段全部可选：查询面拿得到多少就给多少，缺的那部分不产生卡（不猜）。
 *
 * @param {object} context
 * @param {object} [context.run] summarizeRuns 的一条轮结论
 * @param {Array<object>} [context.auditRows] 这一轮的审计行
 * @param {Array<object>} [context.diagRows] 这一轮的诊断轨行
 * @param {Array<object>} [context.allDiagRows] 整份诊断轨（判 startup.ready 要用）
 * @param {object} [context.cross] crossCheckRuns 的结果
 * @param {object} [context.check] audit check 的汇总（gaps / badLines / lastLineTerminated）
 * @returns {Array<object>} 命中的卡片，每张附一句 because（为什么给它）
 */
export function matchRemedies(context = {}) {
  const run = context.run && typeof context.run === "object" ? context.run : null;
  const auditRows = Array.isArray(context.auditRows) ? context.auditRows : [];
  const diagRows = Array.isArray(context.diagRows) ? context.diagRows : [];
  const allDiagRows = Array.isArray(context.allDiagRows) ? context.allDiagRows : diagRows;
  const cross = context.cross && typeof context.cross === "object" ? context.cross : null;
  const check = context.check && typeof context.check === "object" ? context.check : null;
  const hits = [];
  const add = (id, because) => {
    const card = CARD_BY_ID.get(id);
    if (card) hits.push({ ...card, because });
  };

  if (hasEvent(diagRows, "apply.gate.reject")) {
    add("version-gate-reject", "诊断轨里这一轮有 apply.gate.reject");
  }
  if (hasEvent(diagRows, "apply.audit.fail")) {
    add("cross-mismatch", "诊断轨里有 apply.audit.fail：这一轮的审计没写成，两轨必然对不上");
  }

  const hardMiss = auditRows.filter((row) => {
    const status = row && row.detail ? String(row.detail.status ?? "") : "";
    return /^read_error$/.test(status) || /^write_error:/.test(status) || row?.result === "fail";
  });
  if (hardMiss.length > 0) {
    const ids = hardMiss.slice(0, 5).map((row) => row?.detail?.patchId ?? "?").join(", ");
    add("patch-hard-miss", `${hardMiss.length} 行判定为 fail（补丁号 ${ids}${hardMiss.length > 5 ? " …" : ""}）`);
  }
  if (anyStatusMatches(diagRows, /^missing_file$/)) {
    add("missing-file", "诊断轨里有 missing_file：这批补丁在当前宿主本来就不适用");
  }
  if (anyStatusMatches(auditRows, /^already$|^skipped$|^na$|^off$/)) {
    add("status-skipped-not-miss", "有行的 detail.status 是 already / skipped / na / off 之一，不是失败");
  }

  // 只在「判得了且没盖章」时报截断：旧口径的轮没有结束标记，那不是截断，是判据没依据。
  if (run && run.closed === false && run.judgeable !== false) {
    const seal = run.sealed === true ? "盖了章却没通过其它判据" : "没有 detail.runEnd 结束标记";
    add("run-truncated", `轮边界判据说这一轮没收尾：${seal}（末行是什么不参与判断）`);
  }
  const incomplete = auditRows.filter((row) => {
    const completeness = row && row.detail ? row.detail.completeness : null;
    if (!completeness || typeof completeness !== "object") return false;
    return completeness.patches === false || completeness.files === false || completeness.layers === false;
  });
  if (incomplete.length > 0) {
    add("record-incomplete", `${incomplete.length} 条层结论的 completeness 有假项`);
  }
  if (check) {
    const gaps = Array.isArray(check.gaps) ? check.gaps.length : Number(check.gaps ?? 0);
    const badLines = Array.isArray(check.badLines) ? check.badLines.length : Number(check.badLines ?? 0);
    if (gaps > 0 || badLines > 0 || check.lastLineTerminated === false) {
      add("log-corrupt", `gaps=${gaps} badLines=${badLines} terminated=${check.lastLineTerminated}`);
    }
  }
  if (cross && Array.isArray(cross.problems) && cross.problems.length > 0) {
    add("cross-mismatch", `跨轨对账报了 ${cross.problems.length} 条：${cross.problems[0]}`);
  }
  if (auditRows.length === 0 && diagRows.length > 0 && !hasEvent(diagRows, "apply.gate.reject")) {
    // 门禁拒绝那一路一个字节都没写，本来就没有可落账的判定 —— 那时报「审计没写」
    // 会把设计边界说成缺陷，反而盖住真正该看的版本对照。
    const start = diagRows.find((row) => row && row.event === "apply.start");
    const entry = start ? String(start.entry ?? "") : "";
    add(
      "audit-not-written",
      AUDIT_EXEMPT_ENTRIES.includes(entry)
        ? `entry=${entry} 属于不写审计轨的那五个入口`
        : `诊断轨 ${diagRows.length} 行 / 审计轨 0 行（entry=${entry || "缺失"}）`,
    );
  }
  if (hasEvent(diagRows, "revert.start") || hasEvent(diagRows, "revert.end")) {
    add("revert-not-audited", "诊断轨里这一轮是 revert，而审计轨只记 apply");
  }

  const end = diagRows.find((row) => row && row.event === "apply.end");
  if (end) {
    const pending = String(end.pendingRestart ?? "") === "true";
    const sealed = String(end.asarSealed ?? "") === "true";
    if (pending) {
      const endTs = Date.parse(String(end.ts ?? ""));
      const ready = allDiagRows.filter((row) => row && row.event === "startup.ready")
        .find((row) => Number.isFinite(endTs) ? Date.parse(String(row.ts ?? "")) >= endTs : true);
      const match = ready ? String(ready.patchesMatch ?? "") : "";
      add(
        "restart-not-effective",
        ready === undefined
          ? "pendingRestart=true，其后没有任何 startup.ready"
          : `pendingRestart=true，其后那次启动 patchesMatch=${match || "（空）"}${match === "true" ? "（已生效，不必再动手）" : ""}`,
      );
      if (sealed) add("asar-still-sealed", "pendingRestart=true 且 asarSealed=true");
    }
  }

  return hits;
}

/**
 * 把卡片渲染成给终端看的几行。
 *
 * 一条信息一行、缩进两级：`audit why` 的输出本来就长，卡片段不许再撑成一屏。
 *
 * @param {Array<object>} cards matchRemedies 的结果
 * @returns {string[]}
 */
export function renderRemedies(cards) {
  const list = Array.isArray(cards) ? cards : [];
  if (list.length === 0) {
    return ["下一步：没有命中任何已知症候 —— 按第 0 步判完整性，再把这一轮的行按时间读一遍"];
  }
  const lines = [`下一步：命中 ${list.length} 条症候`];
  list.forEach((card, index) => {
    lines.push(`  ${index + 1}. ${card.symptom}${card.because ? `（${card.because}）` : ""}`);
    lines.push(`     证据字段：${card.fields.join(" / ")}`);
    lines.push(`     跑：${card.check}`);
    lines.push(`     动作：${card.action}`);
    lines.push(`     判定：${card.decision}`);
  });
  return lines;
}
