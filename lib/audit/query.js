/**
 * lib/audit/query.js — 查询子命令：按轮捞审计行并与诊断轨对账。
 *
 * `tail` / `why` 两个库函数此前只有 HTTP 路由消费，而「日志残缺」恰恰是最需要它们
 * 的时候 —— 那一刻宿主可能根本起不来。查询只读文件：不装宿主、不看补丁状态。
 *
 * 退出码三档，与 `audit check` 同域：0 有结果 / 1 查无此（筛完一条不剩也算这一档）
 * / 2 用法或环境错误。`2` 不是通过 —— 它只证明没查成。
 */
import fs from "node:fs";

import { diagLogPath } from "../diag-log.js";
import { LOG_ROLLING } from "../log-rolling.js";
import { findDshHome } from "../host/paths.js";
// 补丁表是本模块的分母来源：`why` 与 `check` 必须用同一张表，不然同一轮会给出两种结论。
import { ALL_PATCHES } from "../patch/table.js";
import { listRunCards } from "./handout.js";
import { crossCheckRuns, summarizeRuns } from "./runs.js";
import { matchRemedies, renderRemedies, remedyCard, REMEDY_CARDS } from "./remedy.js";
import { resolveAuditDir, tail } from "./store.js";

const EXIT_OK = 0;
const EXIT_HIT = 1;
const EXIT_TOOLING = 2;

const DEFAULT_IO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** 诊断轨里值得摊到「一次 apply」摘要上的字段；别把整行倒出来。 */
const DIAG_SUMMARY_FIELDS = [
  "entry", "patches", "selected", "hosts", "total", "applied", "already", "failed",
  "notFound", "missingFile", "soft", "files", "errors", "pendingRestart", "asarSealed", "ms",
];

const WHY_USAGE = [
  "用法：dsh-purge audit why <runId> [--json]",
  "  列出该 runId 的全部审计行，再并排给出诊断轨的 apply.start / apply.end，并判两轨是否一致。",
  "  末尾给出失败卡：这一轮落过卡就是卡的路径（cards/<戳>-<runId>.md），没落过就写「本轮无卡」。",
  "  对账只比补丁号与状态：两轨的补丁号次序按不同规则排序，次序差异不判为分歧。",
  "  审计轨只记 apply，不记 revert —— 查 revert 的 runId 时审计侧为空属设计边界。",
  "  退出码：0 有结果 / 1 查无此 runId / 2 用法或环境错误。",
];

const TAIL_USAGE = [
  "用法：dsh-purge audit tail [--n 20] [--runId <值>] [--layer prompt|code|tool] [--event <前缀>] [--status <值,值>] [--json]",
  "  最近 N 条审计行（新的在前）；--runId / --layer / --event 与 GET /dsh-purge/audit?tail= 同义，--status 只有 CLI 有。",
  "  --status 按 detail.status 筛（逗号分隔，例：applied,skipped,pattern_not_found,read_error,missing_file）；值逐字匹配，",
  "  write_error 另按 write_error: 前缀命中 —— 这一档的真实取值后面还带底层错误文本。",
  "  detail.status 只存在于文件层行（*.patch-applied / *.patch-miss / *.patch-skipped）。层结论行（*.apply-result）",
  "  的 detail 里是 applied / failed / skipped 计数、没有 status 字段，所以带 --status 时结论行一律不出现 ——",
  "  那是过滤生效，不是丢行；要看待结论就别带。--n 数的是筛后的条数：过滤先于截断。",
  "  这批行落在「同日代数顶到上限」的那一天时，末尾会多打一行 prune.capped 提示。",
  "  退出码：0 有结果 / 1 一条都没有（筛完为空也算，值拼错也走这一档）/ 2 用法或环境错误。",
];

const REMEDY_USAGE = [
  "用法：dsh-purge audit remedy [<症候 id>] [--json]",
  "  列出「症候 → 字段 → 命令 → 动作」卡片；给 id 就只打那一张。",
  "  这些卡片也是 audit why <runId> 末尾「下一步」段的数据源。",
  "  退出码：0 有这张卡 / 1 没这个 id / 2 用法或环境错误。",
];

/** 用法或环境错误一律按退出码 2 报出；其余异常照常抛出。 */
class AuditQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuditQueryError";
  }
}

/**
 * 诊断轨的全部现存文件：`.N` 是最旧一代，主文件是这一代。
 *
 * 为什么要读旧代：诊断轨按 `LOG_ROLLING.generations` 留多代（当前 8 代），`why` 原先只读
 * 主文件，于是「刚被滚掉的那一轮」会被报成「查无此轮」—— 那不是查无，是查得不够。
 * 顺序按「最旧 → 最新」，与时间顺序一致。
 */
function diagFiles(file) {
  // 代数只有一个来源：写侧的 `LOG_ROLLING.generations`。早先这里写死 `[.1, file]`，写侧
  // 改成多代之后读侧只认两代 —— 磁盘上留着 8 代而 `audit why` 永远说「查无此轮」，
  // 那是最坏的一种不一致：证据在，读不到。重抄字面量由
  // `scripts/check-reader-follows.mjs` 判红。
  const out = [];
  for (let gen = LOG_ROLLING.generations; gen >= 1; gen -= 1) {
    const candidate = `${file}.${gen}`;
    if (fs.existsSync(candidate)) out.push(candidate);
  }
  out.push(file);
  return out;
}

/**
 * 诊断轨读取：坏行只丢它自己。
 *
 * 文件不存在返回空数组而不是报错：诊断轨被轮转覆盖是常见形态 ——
 * 审计轨还在、诊断轨没了，那是边界，不是这次查询失败。
 */
function readDiagRows(file) {
  const rows = [];
  for (const target of diagFiles(file)) {
    let raw;
    try {
      raw = fs.readFileSync(target, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // 坏行只损失它自己。
      }
    }
  }
  return rows;
}

/**
 * 这一份诊断轨读到了几份文件、其中有没有滚过的旧代。
 *
 * **口径**：这里报的是**文件份数**，含主文件 —— 与写侧的「代数」差 1。
 * 写侧的代数指「主文件之外还留几份」（规格 `generations` 就是那个份数），
 * 读侧手里只有文件列表，报份数才不会让人以为「读到 1」是「只有一代、没有旧代」。
 * 早先那句「读到的代数 N」把两份口径混成了一个词，读的人据此判断「日志没滚过」。
 */
function diagSourceInfo(file) {
  const files = diagFiles(file).filter((target) => fs.existsSync(target));
  return { files: files.length, rolled: files.length > 1 };
}

/**
 * `--status` 的取值：逗号分隔，去空白、去重；空段算写法错误。
 *
 * 不校验值是不是已知状态：认不出的值照常当过滤条件，命中 0 条后退 1 —— 值拼错时
 * 要的正是这盏红灯，而不是「这条命令本来就没结果」与「你写错了」两件事长得一样。
 * 空段不同：`a,,b` 是句法写坏，退回 2，不让它冒充「筛完为空」。
 */
function parseStatusList(raw) {
  const wanted = [];
  for (const part of String(raw).split(",")) {
    const value = part.trim();
    if (value === "") {
      throw new AuditQueryError(`--status 有空取值（收到 ${JSON.stringify(raw)}）：逗号分隔，例 applied,skipped`);
    }
    if (!wanted.includes(value)) wanted.push(value);
  }
  return wanted;
}

function parseTailOptions(argv) {
  const options = {
    n: 20, runId: undefined, layer: undefined, event: undefined, status: undefined, json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (!["--n", "--runId", "--layer", "--event", "--status"].includes(arg)) {
      throw new AuditQueryError(`未知参数 ${arg}（--help 看用法）`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new AuditQueryError(`${arg} 缺一个值（--help 看用法）`);
    }
    if (arg === "--n") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw new AuditQueryError(`--n 必须是非负整数，收到 ${value}`);
      options.n = n;
    } else if (arg === "--status") {
      options.status = parseStatusList(value);
    } else {
      options[arg.slice(2)] = value;
    }
    i += 1;
  }
  return options;
}

function auditRowLine(row) {
  const patchId = row.detail && row.detail.patchId !== undefined ? row.detail.patchId : "";
  const status = row.detail && row.detail.status ? row.detail.status : "";
  const parts = [
    `seq=${row.seq}`,
    `event=${row.event}`,
    `result=${row.result}`,
    `layer=${row.layer}`,
    `target=${row.target}`,
  ];
  if (patchId !== "" && patchId !== null) parts.push(`patch=${patchId}`);
  if (status !== "") parts.push(`status=${status}`);
  return parts.join("  ");
}

function diagRowLine(row) {
  const parts = [`event=${row.event}`];
  for (const field of DIAG_SUMMARY_FIELDS) {
    if (row[field] !== undefined && row[field] !== "") parts.push(`${field}=${row[field]}`);
  }
  return parts.join("  ");
}

/** 审计行按时间正序：tail 给的是新的在前，读一轮应按发生顺序看。 */
function ascending(rows) {
  return rows.slice().sort((a, b) => {
    const left = Date.parse(a.ts);
    const right = Date.parse(b.ts);
    if (left !== right) return left - right;
    return (a.seq ?? 0) - (b.seq ?? 0);
  });
}

/**
 * 这一批审计行里最大的写入积压（ts − observedTs）。
 *
 * 为什么要有它：`observedTs` 一直写着，却没有任何地方读 —— 于是「这份账滞后多久」
 * 只能靠人拿两列时间相减。滞后大说明审计管道本身在排队，不是 apply 慢；
 * 读的人分不清这两件事就会去修错的东西。
 */
function describeLag(rows) {
  let max = null;
  let count = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const written = Date.parse(String(row.ts ?? ""));
    const observed = Date.parse(String(row.observedTs ?? ""));
    if (!Number.isFinite(written) || !Number.isFinite(observed)) continue;
    count += 1;
    const lag = written - observed;
    if (lag >= 0 && (max === null || lag > max)) max = lag;
  }
  if (max === null) return "（这一批行都没有 observedTs，判不出滞后）";
  return `这一批最多滞后 ${max} ms（${count} 行带 observedTs；ts − observedTs）`;
}

/**
 * 一行的 detail.status 是否落在 --status 给的那几个值上。
 *
 * 只认 detail.status：文件层行一定带它（真没有时是空串，不算命中），层结论行的 detail
 * 里是 applied / failed / skipped 计数、没有这个字段 —— 于是「带 --status 就看不到
 * 结论行」是这条判据的直接结果，不是另一处特判。
 */
function statusMatches(row, wanted) {
  const status = row && row.detail && typeof row.detail.status === "string" ? row.detail.status : "";
  if (status === "") return false;
  return wanted.some((value) => status === value || status.startsWith(`${value}:`));
}

/** 首轮扫描窗口的起点：与 HTTP 侧 tail 的缺省条数同一量级，常见日志一轮就取满。 */
const TAIL_SCAN_FLOOR = 50;

/**
 * 先筛后截的 tail：`--n` 数的是筛后的条数，与 `--layer` / `--event` 同一语义。
 *
 * 不能「先取 N 再筛」—— 真机上 66 条里只有 1 条 skipped，先截 20 条正好会把它截掉，
 * 读起来又成了「这一轮没有 skipped」。store 层的 tail 没有状态子句，而那一侧这次不动，
 * 所以只能多取一轮、不够就翻倍，直到取满或取空；不设静默上限，免得「窗口外还有命中」
 * 又被读成空。
 */
function tailByStatus(dshHome, window, wanted) {
  let scan = Math.max(window.n, TAIL_SCAN_FLOOR);
  for (;;) {
    const rows = tail(dshHome, { ...window, n: scan });
    const kept = rows.filter((row) => statusMatches(row, wanted));
    if (kept.length >= window.n || rows.length < scan) return kept.slice(0, window.n);
    scan *= 2;
  }
}

/** 一行审计行的本地日期段（与审计文件名的日期口径一致）。 */
function dayOfRow(row) {
  const at = Date.parse(String((row && row.ts) || ""));
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 「这一天的审计日志顶到同日代数上限了」的提示。
 *
 * `prune.capped` 是写侧在代数顶到上限时留的那一条诊断事件（一天一条），原先没有任何
 * 读侧 —— 于是「日志里有些行按日期被塞进最后一代」这件事只能靠人去数字典里的文件。
 * 提示只在**当前这批行落在被顶到的那一天**时打：别的日子的上限与本轮无关。
 *
 * @param {Array<object>} diagRows 诊断轨的全部行
 * @param {Array<object>} rows 本次 tail 返回的审计行
 * @returns {string[]} 提示行（通常零或一条）
 */
function cappedDayHints(diagRows, rows) {
  const capped = new Map();
  for (const row of Array.isArray(diagRows) ? diagRows : []) {
    if (!row || row.event !== "prune.capped") continue;
    const day = String(row.day || "").trim();
    if (day !== "") capped.set(day, String(row.file || ""));
  }
  if (capped.size === 0) return [];
  const days = new Set((Array.isArray(rows) ? rows : []).map(dayOfRow).filter((day) => day !== ""));
  const hits = [];
  for (const day of days) {
    const file = capped.get(day);
    if (file === undefined) continue;
    hits.push(
      `提示：${day} 的审计日志顶到同日代数上限（prune.capped，写进 ${file}）——`
      + " 这一天的行按日期被塞进最后一代，不是日志丢了",
    );
  }
  return hits;
}

function runTail(argv, io, dshHome) {
  const options = parseTailOptions(argv);
  if (options.help) {
    for (const line of TAIL_USAGE) io.out(line);
    return EXIT_OK;
  }
  const window = {
    n: options.n,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.layer === undefined ? {} : { layer: options.layer }),
    ...(options.event === undefined ? {} : { event: options.event }),
  };
  const rows = options.status === undefined
    ? tail(dshHome, window)
    : tailByStatus(dshHome, window, options.status);
  if (options.json) {
    io.out(JSON.stringify(rows, null, 2));
  } else {
    io.out(`audit: ${rows.length} 条（新的在前）  dir=${dshHome}\\dsh-purge\\audit`);
    io.out(`lagMs: ${describeLag(rows)}`);
    for (const row of rows) io.out(`  ${auditRowLine(row)}`);
    // 代数顶到上限是「这一天的量不正常」的信号：写侧留了事件，读侧在这里说出来。
    for (const hint of cappedDayHints(readDiagRows(diagLogPath(dshHome)), rows)) io.out(hint);
  }
  return rows.length > 0 ? EXIT_OK : EXIT_HIT;
}

function runWhy(argv, io, dshHome) {
  let runId = "";
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      for (const line of WHY_USAGE) io.out(line);
      return EXIT_OK;
    }
    if (arg.startsWith("--")) throw new AuditQueryError(`未知参数 ${arg}（--help 看用法）`);
    if (runId !== "") throw new AuditQueryError(`why 只收一个 runId，收到第二个 ${arg}`);
    runId = arg;
  }
  if (runId === "") throw new AuditQueryError("why 缺 runId（--help 看用法）");

  const auditRows = ascending(tail(dshHome, { runId, n: 1000 }));
  const diagFile = diagLogPath(dshHome);
  const diagRows = readDiagRows(diagFile).filter((row) => String(row.runId || "") === runId);
  if (auditRows.length === 0 && diagRows.length === 0) {
    if (json) io.out(JSON.stringify({ runId, found: false, audit: [], diag: [], cards: [] }, null, 2));
    else io.out(`查无此 runId：${runId}（审计轨与诊断轨都没有这一轮）`);
    return EXIT_HIT;
  }

  const diagStarts = diagRows.filter((row) => row.event === "apply.start");
  const diagEnds = diagRows.filter((row) => row.event === "apply.end" || row.event === "apply.gate.reject");
  // 本轮落过失败卡就是这一轮有值得回看的东西：卡的文件名带 runId，扫描只认这个后缀。
  const cards = listRunCards(resolveAuditDir(dshHome), runId);
  const runs = summarizeRuns(auditRows, { patches: ALL_PATCHES }).runs;
  const cross = crossCheckRuns(runs, diagRows);
  // 「一致」只在一轮都没有的时候才可能是假：那说明审计侧没有这一轮，
  // 不是两轨说了不同的话。把它写成 false 会被读成「日志矛盾」。
  const comparable = cross.checked > 0;
  const consistent = comparable && cross.unmatched === 0;
  // 「下一步试什么」按现场算，不按文档抄：卡片只看这一轮真实出现了什么。
  // startup.ready 不带 runId，判「改动生效了没有」必须看整份诊断轨，所以另读一次。
  const remedies = matchRemedies({
    run: runs[0],
    auditRows,
    diagRows,
    cross,
    allDiagRows: readDiagRows(diagFile),
  });

  if (json) {
    io.out(JSON.stringify({
      runId,
      found: true,
      audit: auditRows,
      diag: { starts: diagStarts, ends: diagEnds, rows: diagRows.length, files: diagSourceInfo(diagFile).files },
      cards,
      runs,
      cross: { ...cross, consistent, comparable },
      remedies,
    }, null, 2));
    return EXIT_OK;
  }

  io.out(`runId: ${runId}`);
  io.out(`审计轨：${auditRows.length} 行`);
  if (auditRows.length === 0) {
    // 审计轨只记 apply，且只有四个入口写它：0 行有两条正常来路，读的人不该当成丢日志。
    io.out("  （审计轨只记 apply，不记 revert；且只有 http / command / tool / cli 四个入口写它）");
  }
  for (const row of auditRows) io.out(`  ${auditRowLine(row)}`);
  const diagSource = diagSourceInfo(diagFile);
  io.out(
    `诊断轨：${diagRows.length} 行（apply.start ${diagStarts.length} / 收尾 ${diagEnds.length}）`
    + `；读到 ${diagSource.files} 份文件（含主文件）${diagSource.rolled ? "，有滚过的旧代" : ""}`,
  );
  for (const row of diagStarts) io.out(`  ${diagRowLine(row)}`);
  for (const row of diagEnds) io.out(`  ${diagRowLine(row)}`);
  // 失败卡是这一轮「值得回看」的那张纸：写侧落盘、读侧原先零消费者，等于没有取证。
  // 路径照抄现场的绝对位置，读的人能直接打开；没有就说没有，别让它看起来像丢文件。
  if (cards.length === 0) {
    io.out("失败卡：本轮无卡");
  } else {
    for (const card of cards) io.out(`失败卡：${card}`);
  }
  io.out(comparable
    ? `cross: 对上 ${cross.matched} / 共 ${cross.checked} 轮；一致 ${consistent}`
    : "cross: 无可对账的轮（审计轨没有这一轮，不是两轨矛盾）");
  for (const problem of cross.problems.slice(0, 20)) io.out(`  ! ${problem}`);
  if (cross.problems.length > 20) io.out(`  ! 还有 ${cross.problems.length - 20} 条，用 --json 看全部`);
  // 次序信息项：两轨排序规则不同，读的人可以看，但不该据此判「日志坏了」。
  for (const note of cross.orderNotes) io.out(`  · ${note}`);
  // 「诊断轨滚过 ⇒ 这一轮不可判」也单列：它不是「两轨矛盾」，别让读者按矛盾去修。
  for (const note of cross.staleNotes) io.out(`  · ${note}`);
  for (const line of renderRemedies(remedies)) io.out(line);
  return EXIT_OK;
}

/** `audit remedy`：把卡片表摊开，给 id 就只打那一张。 */
function runRemedy(argv, io) {
  const ids = [];
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      for (const line of REMEDY_USAGE) io.out(line);
      return EXIT_OK;
    }
    if (arg.startsWith("--")) throw new AuditQueryError(`未知参数 ${arg}（--help 看用法）`);
    ids.push(arg);
  }
  if (ids.length > 1) throw new AuditQueryError(`remedy 最多收一个 id，收到 ${ids.length} 个`);
  const cards = ids.length === 0 ? REMEDY_CARDS : [remedyCard(ids[0])];
  if (cards.some((card) => card === null)) {
    const known = REMEDY_CARDS.map((card) => card.id).join(" / ");
    io.err(`[audit-query] 没有这个症候 id：${ids[0]}（可用：${known}）`);
    return EXIT_HIT;
  }
  if (json) {
    io.out(JSON.stringify(cards, null, 2));
    return EXIT_OK;
  }
  for (const card of cards) {
    io.out(`${card.id}  ${card.symptom}`);
    io.out(`  证据字段：${card.fields.join(" / ")}`);
    io.out(`  跑：${card.check}${card.needsHost ? "（要宿主）" : ""}`);
    io.out(`  动作：${card.action}`);
    io.out(`  判定：${card.decision}`);
    io.out(`  置信度：${card.confidence}${card.approvalRequired ? "  需人工确认" : ""}`);
  }
  return EXIT_OK;
}

/**
 * 查询子命令入口：`tail` / `why` / `remedy`。
 *
 * @param {string[]} argv `audit` 之后、子命令本身的参数（从 `tail` / `why` / `remedy` 开始）
 * @param {{out:(line:string)=>void, err:(line:string)=>void}} [io]
 * @param {{dshHome?:string}} [options] 落点；缺省按 DSH_HOME / 用户目录推断
 * @returns {number} 0 有结果 / 1 查无此 runId 或一条都没有（tail 筛完为空也算）/ 2 用法或环境错误
 */
export function runAuditQuery(argv, io = DEFAULT_IO, options = {}) {
  const sub = argv[0];
  const dshHome = String(options.dshHome || "").trim() || findDshHome();
  try {
    if (sub === "tail") return runTail(argv.slice(1), io, dshHome);
    if (sub === "why") return runWhy(argv.slice(1), io, dshHome);
    if (sub === "remedy") return runRemedy(argv.slice(1), io);
    throw new AuditQueryError(`未知子命令 ${JSON.stringify(sub ?? "")}（只认 tail / why / remedy）`);
  } catch (error) {
    if (!(error instanceof AuditQueryError)) throw error;
    io.err(`[audit-query] ${error.message}`);
    return EXIT_TOOLING;
  }
}
