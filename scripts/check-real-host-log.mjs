/**
 * scripts/check-real-host-log.mjs — 只读：验收真机取回日志的六条判据。
 * 存在理由：本机跑不出完整的 apply（`surface` 门禁在裸 node 里就抛），所以 gate 之后那四条
 * 事件（apply.patch / apply.host / apply.end / install.record）只有真机日志能证明带身份。
 * 这个脚本把「真机取回的日志」当输入，逐条判六件事，任何一件不成立就退出 1。
 * 为什么在 scripts/ 而不是草稿区：测试会 spawn 它，草稿区被忽略；门禁必须随仓库走，
 * 干净 clone 才能复跑同一条判据。
 *
 * 用法：
 *   node scripts/check-real-host-log.mjs <取回的目录>
 * 目录里期望有：
 *   diag.jsonl            （可选 audit/ 子目录，放 audit 的 *.jsonl）
 * 退出码：0 全过 / 1 有判据不过 / 2 用法或环境错误。
 *
 * 六条判据：
 *   C1 apply 事件里每一条都带 entry
 *   C2 同一次 apply 的 runId 一致（一个 runId 不该横跨两个 entry）
 *   C3 entry 值在 9 个允许值之内
 *   C4 gate 之后那四条出现过至少一条（这是 2A 留下的缺口，真机才补得上）
 *   C5 若给了 audit/：audit 的 runId 能在 diag 里找到同值（两轨 join 成立）
 *   C6 没有任何字段值是字符串 "undefined"
 */
import fs from "node:fs";
import path from "node:path";

const EXIT = { OK: 0, HIT: 1, TOOL: 2 };

/** 与 `check-w1-identity.mjs` 同一张表：1A 拍板后的唯一允许值。 */
const ALLOWED_ENTRY = new Set([
  "command", "tool", "http", "cli",
  "startup-auto", "startup-inject",
  "reapply", "reapply-cli", "http-restart",
]);

/** gate 之后才发的那四条（本机实证不到的）。 */
const POST_GATE = ["apply.patch", "apply.host", "apply.end", "install.record"];

/** 视为「一次 apply 的主线事件」：apply.* 与 install.record（后者不以 apply. 开头，曾把我自己的正则骗过去）。 */
const APPLY_EVENT = /^(apply\.|install\.record$)/;

/** revert 家族 —— 同一套身份机制，但 W1 没有接线（`purge_revert` 工具与 CLI `--revert` 都不在 10 处内）。 */
const REVERT_EVENT = /^revert\./;

const dir = process.argv[2];
if (!dir) {
  console.error("用法：node scripts/check-real-host-log.mjs <取回的目录>");
  process.exit(EXIT.TOOL);
}

/**
 * 取回后的目录形状有两种，都要认：
 *   ① 直接把 `~/.dsh/dsh-purge/logs` 与 `audit` 拷到本目录下 → `<dir>/logs/diag.jsonl`、`<dir>/audit/*`
 *   ② 手工摊平 → `<dir>/diag.jsonl`、`<dir>/audit/*`
 * 先找摊平，再找 logs/ 子目录；两处都没有才报环境错误。
 */
function firstExisting(cands) {
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}
const diagPath = firstExisting([
  path.join(dir, "diag.jsonl"),
  path.join(dir, "logs", "diag.jsonl"),
]);
if (!diagPath) {
  console.error(`环境错误：在 ${dir} 与 ${dir}\\logs 下都找不到 diag.jsonl`);
  process.exit(EXIT.TOOL);
}

function readJsonl(fp) {
  const out = [];
  let bad = 0;
  for (const line of fs.readFileSync(fp, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try { out.push(JSON.parse(line)); } catch { bad += 1; }
  }
  return { rows: out, bad };
}

const diag = readJsonl(diagPath);
const applyRows = diag.rows.filter((r) => typeof r.event === "string" && APPLY_EVENT.test(r.event));
const problems = [];
const notes = [];

console.log(`diag: ${diag.rows.length} 行（坏行 ${diag.bad}）｜apply.* 事件 ${applyRows.length} 条`);
if (applyRows.length === 0) {
  problems.push("C1 失败的前置：这份 diag 里一条 apply.* 事件都没有 —— 要么这次部署没真的 apply 过，要么取错了文件");
}

// C1：每条 apply 事件都带 entry
const noEntry = applyRows.filter((r) => r.entry === undefined || r.entry === "");
if (noEntry.length) {
  problems.push(`C1 失败：${noEntry.length}/${applyRows.length} 条 apply 事件缺 entry —— ${[...new Set(noEntry.map((r) => r.event))].join(", ")}`);
} else if (applyRows.length) {
  notes.push(`C1 通过：${applyRows.length} 条 apply 事件全部带 entry`);
}

// C2：一个 runId 只对应一个 entry
const entryByRun = new Map();
for (const r of applyRows) {
  if (r.runId === undefined) continue;
  if (!entryByRun.has(r.runId)) entryByRun.set(r.runId, new Set());
  entryByRun.get(r.runId).add(r.entry);
}
const mixed = [...entryByRun.entries()].filter(([, set]) => set.size > 1);
if (mixed.length) {
  problems.push(`C2 失败：${mixed.length} 个 runId 横跨多个 entry（${mixed.slice(0, 2).map(([k, v]) => `${k}→${[...v].join("/")}`).join("；")}）`);
} else if (entryByRun.size) {
  notes.push(`C2 通过：${entryByRun.size} 个 runId 各自只对应一个 entry`);
}

// C3：entry 值合法（没有 entry 可判时不许报「通过」—— 那是空绿）
const badEntry = [...new Set(applyRows.map((r) => r.entry).filter((v) => v !== undefined && !ALLOWED_ENTRY.has(v)))];
if (badEntry.length) problems.push(`C3 失败：出现不在允许集的 entry：${badEntry.join(", ")}`);
else if (applyRows.some((r) => r.entry !== undefined)) notes.push("C3 通过：entry 值全在 9 个允许值内");
else notes.push("C3 跳过：一条 entry 都没有，无可判对象（不是通过）");

// C4：gate 之后那四条出现过（2A 缺口的补证）
const seenPost = POST_GATE.filter((e) => applyRows.some((r) => r.event === e));
const missingPost = POST_GATE.filter((e) => !seenPost.includes(e));
if (seenPost.length === 0) {
  problems.push(`C4 失败：gate 之后那四条一条都没出现（${POST_GATE.join(", ")}）—— 这次部署大概没走到真实写盘`);
} else if (missingPost.length === 0) {
  notes.push(`C4 通过：gate 之后那四条全部出现（${seenPost.join(", ")}）`);
} else {
  notes.push(`C4 部分通过：gate 之后见到 ${seenPost.join(", ")}；仍未见 ${missingPost.join(", ")}`);
}

// C5：audit 与 diag 的 runId join（可选）
const auditDir = firstExisting([
  path.join(dir, "audit"),
  path.join(dir, "logs", "audit"),
]) || path.join(dir, "audit");
if (fs.existsSync(auditDir)) {
  const files = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
  const auditRunIds = new Set();
  for (const f of files) {
    for (const r of readJsonl(path.join(auditDir, f)).rows) {
      if (typeof r.runId === "string") auditRunIds.add(r.runId);
    }
  }
  const diagRunIds = new Set(applyRows.map((r) => r.runId).filter(Boolean));
  const joined = [...auditRunIds].filter((id) => diagRunIds.has(id));
  if (auditRunIds.size === 0) notes.push("C5 跳过：audit 文件里没有 runId（可能是 v1 旧行）");
  else if (joined.length === 0) problems.push(`C5 失败：audit 有 ${auditRunIds.size} 个 runId，diag 里一个都对不上 —— 两轨没 join 上`);
  else notes.push(`C5 通过：audit×diag 按 runId 对上 ${joined.length} 个（${auditRunIds.size} 个 audit runId 中）`);
} else {
  notes.push("C5 跳过：没给 audit/ 子目录");
}

// C6：没有字符串 "undefined"
const undef = diag.rows.filter((r) => Object.values(r).some((v) => v === "undefined" || v === "null"));
if (undef.length) problems.push(`C6 失败：${undef.length} 行有字段值是字符串 "undefined"/"null"（多半是拼接时把缺失值 stringify 了）`);
else notes.push('C6 通过：无字段值被写成字符串 "undefined"/"null"');

// C7（信息项，不计失败）：revert 家族用的是同一套身份机制，但 W1 的 10 处里没有它。
// 它出现与否不改变本包结论，只用来把「下一个要补的入口」摆到台面上。
const revertRows = diag.rows.filter((r) => typeof r.event === "string" && REVERT_EVENT.test(r.event));
if (revertRows.length) {
  const noEntryRevert = revertRows.filter((r) => r.entry === undefined || r.entry === "");
  if (noEntryRevert.length > 0) {
    notes.push(`C7 信息：${noEntryRevert.length}/${revertRows.length} 条 revert 事件没有 entry —— 这是 W1 没接线的已知缺口（\`purge_revert\` 工具与 CLI \`--revert\`），下一包补`);
  } else {
    notes.push(`C7 信息：${revertRows.length} 条 revert 事件都带 entry（说明有人补过 revert 入口）`);
  }
} else {
  notes.push("C7 跳过：这份日志里没有 revert 事件");
}

console.log("");
for (const n of notes) console.log(`  ${n}`);
if (problems.length === 0) {
  console.log("\n  PASS 六条判据全过");
  process.exit(EXIT.OK);
}
console.log("");
for (const p of problems) console.log(`  ${p}`);
process.exit(EXIT.HIT);
