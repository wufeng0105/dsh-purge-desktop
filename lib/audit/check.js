/**
 * lib/audit/check.js — 审计完整性：断号、坏行、末行与轮边界，一条命令判得出。
 * 审计日志完整性的第一层：不靠哈希链，只看每个文件自身与每一轮的边界。
 *
 * 为什么先做这一层：这三件事是「日志残缺」最常见的形态，而且不需要任何链外锚就能判。
 * 它们不报的后果是读日志的人（尤其是照着日志下结论的 AI）并不知道自己看到的是一份
 * 缺了角的证据 —— 残缺的日志比没有日志更危险，因为它看起来是完整的。
 *
 * 序号必须按文件判：存储层对每个文件各自从 0 起分配序号（同日写满轮转、跨天换文件
 * 都重新从 0 开始），所以「0、1、3」是断号，而「昨天的文件 5 号之后今天的文件 0 号」
 * 不是断号。按全局累计去判，每个轮转点都会假报。
 *
 * 本层只读文件：判据要能在事后单独跑，不要求宿主还在、插件还装着。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { crossCheckRuns, summarizeRuns } from "./runs.js";
// 现场读法的文件名只有写侧那一处定义：对账侧从同一个常量取，别自己拼字面量。
import { README_NAME } from "./handout.js";
// 分母的唯一来源：补丁表。它不是落账方写的，所以「落账方漏算」这件事第一次有了外部判据。
import { ALL_PATCHES } from "../patch/table.js";

const EXIT_OK = 0;
const EXIT_HIT = 1;
const EXIT_TOOLING = 2;

// 文件名口径与存储层一致：日期段 + 可选的同日轮转号。
const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
const JSONL_SUFFIX = ".jsonl";

// 序号口径的唯一出处：存储层取「文件内最大 seq + 1」，空文件从 0 起。
// 这两个常量是判据本身，改动它们等于改「什么叫断号」。
const SEQ_START = 0;
const SEQ_STEP = 1;

// 末行终止的唯一判据：最后一个字节是 LF。
const LF = 0x0a;

const DEFAULT_IO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const USAGE = [
  "用法：dsh-purge audit check [--dir <审计目录>] [--jsonl <某个 .jsonl>] [--run <runId>] [--diag <诊断轨>] [--strict] [--json]",
  "  （无参数）       判用户目录下 .dsh/dsh-purge/audit 里的所有 .jsonl",
  "  --dir <目录>     判指定目录下所有 .jsonl",
  "  --jsonl <文件>   只判一个文件",
  "  --run <runId>    只判这一轮：审计轨缺它、诊断轨有它，两个方向都判并点名是哪一方向",
  "  --diag <文件>    另给一份 diag.jsonl，逐轮与审计轨对账（补丁号 / 状态；次序只作信息项），",
  "                   并对账 audit.recorded 的 readme 字段与现场 README-for-ai.md",
  "  --strict         把 readme 对账的差异算进退出码（默认只作信息项，不改退出码）",
  "  --json            输出结构化结果",
  "判据：文件内 seq 从 0 起、步长 1（每个文件各自从 0 起）；每行都能 JSON.parse；末字节是换行；",
  "      每一轮有显式结束标记（层结论上的 detail.runEnd）、有文件行的层都有结论、层顺序为提示词→代码→工具；",
  "      v2-entry 及更早的轮没有这个标记：判不了收尾，记「不可判」，不算截断（世代由 ./generation.js 认）；",
  "      每层结论的 completeness 三项按它自己的 detail 复算、detail.table.recorded 按文件行里的补丁号个数复算；",
  "      这一轮该落账的补丁按**补丁表**核对，对不上就红。",
  "      给了 --diag 时再加两个方向：审计有的诊断轨必须有，诊断轨有的审计轨也必须有。",
  "      readme 对账（只写字段的读侧）默认不进退出码：读法没落盘不是日志残缺；要红加 --strict。",
  "退出码：0 全过 / 1 有判据不过 / 2 用法或环境错误。",
  "查询面见 dsh-purge audit tail / dsh-purge audit why <runId>（--help 各自给出用法）。",
];

/** 用法或环境错误一律按退出码 2 报出；其余异常说明本模块自己坏了，照常抛出。 */
class AuditCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuditCheckError";
  }
}

/** 目录模式的默认落点：与存储层的「DSH_HOME 下 dsh-purge/audit」同形。 */
function defaultAuditDir() {
  return path.join(os.homedir(), ".dsh", "dsh-purge", "audit");
}

/**
 * 逐行解析。
 *
 * 坏行只记行号，不中断其余判定：一份日志里有一行坏了，另外三件判据照样要看 ——
 * 抛出去就只剩「命令崩了」，读的人连坏在第几行都拿不到。
 */
function parseLines(raw) {
  const events = [];
  const badLines = [];
  let nonEmptyLines = 0;
  raw.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    nonEmptyLines += 1;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 坏行只损失它自己：行号是 1-based，与编辑器里看到的一致。
      badLines.push(index + 1);
    }
  });
  return { events, badLines, nonEmptyLines };
}

/**
 * 缺失的序号。
 *
 * 上界取文件里出现过的最大 seq：末行被截断时最后一条可能整行消失，缺口就落在上界
 * 之后再无参照，那种残缺由末行判据负责，这一条只管「上界之内少了几号」。
 */
function missingSeqs(present) {
  let upper = SEQ_START - SEQ_STEP;
  for (const seq of present) if (seq > upper) upper = seq;
  const gaps = [];
  for (let seq = SEQ_START; seq <= upper; seq += SEQ_STEP) {
    if (!present.has(seq)) gaps.push(seq);
  }
  return gaps;
}

/** 一个文件的三种判定。读不到文件是环境错误（2），不是「判据不过」（1）。 */
function inspectFile(absolute) {
  let buffer;
  try {
    buffer = fs.readFileSync(absolute);
  } catch (error) {
    throw new AuditCheckError(`读不到日志文件 ${absolute}（${error.message}）`);
  }
  const raw = buffer.toString("utf8");
  const { events, badLines, nonEmptyLines } = parseLines(raw);
  const present = new Set();
  let seqless = 0;
  for (const event of events) {
    if (event && Number.isInteger(event.seq) && event.seq >= SEQ_START) present.add(event.seq);
    else seqless += 1;
  }
  const sorted = [...present].sort((a, b) => a - b);
  return {
    file: path.basename(absolute),
    path: absolute,
    bytes: buffer.length,
    nonEmptyLines,
    events: events.length,
    // 解析得出来但没有整数 seq 的行：不进密集性判定，但必须可见，否则是静默漏判。
    seqless,
    seq: {
      min: sorted.length > 0 ? sorted[0] : null,
      max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
      count: sorted.length,
    },
    gaps: missingSeqs(present),
    badLines,
    // 空文件没有「末行」可言：它不是被截断，是没有内容。
    lastLineTerminated: buffer.length === 0 || buffer[buffer.length - 1] === LF,
  };
}

/** 文件名排序：认得出日期段与轮转号的按时间排，认不出的排在后面按字典序。 */
function compareNames(a, b) {
  const left = FILE_PATTERN.exec(a);
  const right = FILE_PATTERN.exec(b);
  if (left && right) {
    if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
    const leftRotation = left[2] === undefined ? 0 : Number(left[2]);
    const rightRotation = right[2] === undefined ? 0 : Number(right[2]);
    return leftRotation - rightRotation;
  }
  if (left) return -1;
  if (right) return 1;
  return a.localeCompare(b);
}

function listJsonl(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const reason = error && error.code === "ENOENT" ? "目录不存在" : error.message;
    throw new AuditCheckError(`读不到审计目录 ${dir}（${reason}）`);
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(JSONL_SUFFIX))
    .map((entry) => entry.name)
    .sort(compareNames);
}

function buildReport(options) {
  const mode = options.jsonl === null ? "dir" : "file";
  const target = path.resolve(mode === "file" ? options.jsonl : (options.dir ?? defaultAuditDir()));
  let absolutes;
  if (mode === "file") {
    absolutes = [target];
  } else {
    const names = listJsonl(target);
    // 目录在但没有可判对象时按环境错误报 2：报绿等于说「这份日志没问题」，
    // 而它可能只是指错了目录 —— 那是假绿的最短路径。
    if (names.length === 0) throw new AuditCheckError(`审计目录 ${target} 里没有 .jsonl 文件：没有可判的对象`);
    absolutes = names.map((name) => path.join(target, name));
  }

  const files = absolutes.map(inspectFile);
  const gaps = files.reduce((sum, file) => sum + file.gaps.length, 0);
  const badLines = files.reduce((sum, file) => sum + file.badLines.length, 0);
  const unterminated = files.filter((file) => !file.lastLineTerminated).map((file) => file.file);
  // 轮边界按「这一批文件里的全部行」算：同一天里几轮 apply 各成一组，
  // runId 相同而落在两个文件上的情形（恰好在轮转边界上）也只有合并后看得全。
  const allEvents = absolutes.flatMap((absolute) => readEvents(absolute));
  const runsAll = summarizeRuns(allEvents, { patches: ALL_PATCHES });
  // `--run` 只判一轮：审计轨那一侧先筛，诊断轨那一侧由对账自己按 runId 分组。
  // 筛完为空不是「没东西可判」—— 那正是「方向是审计缺」的形态，必须红。
  const wanted = options.run;
  const runs = wanted === null
    ? runsAll
    : { ...runsAll, runs: runsAll.runs.filter((run) => run.runId === wanted),
        total: runsAll.runs.filter((run) => run.runId === wanted).length };
  runs.closed = runs.runs.filter((run) => run.closed).length;
  runs.truncated = runs.runs.filter((run) => run.judgeable !== false && !run.closed).length;
  runs.unjudgeable = runs.runs.filter((run) => run.judgeable === false).length;
  runs.problems = wanted === null ? runsAll.problems : runsAll.problems.filter((line) => line.startsWith(`${wanted}：`));
  runs.notes = wanted === null ? runsAll.notes : runsAll.notes.filter((line) => line.startsWith(`${wanted}：`));
  const cross = options.diag === null
    ? null
    : crossCheckRuns(runs.runs, readDiag(options.diag), {
      // 反向判据要的是「审计轨里到底出现过哪些轮」，不是筛过之后的那一份；
      // 单轮模式也只就那一轮说方向，不把别的轮倒出来。
      coveredRunIds: new Set(runsAll.runs.map((run) => run.runId)),
      // 反向判据还要知道「这次实际给了哪几天」：只判 10-24 却拿着跨到 10-25 的诊断轨，
      // 会把 10-25 的轮次全报成「审计缺」，而真相是那一天的文件根本没给。
      coveredDates: coveredDatesOf(absolutes, allEvents),
      onlyRun: wanted === null ? "" : wanted,
    });
  const missingRun = wanted !== null && runs.runs.length === 0;
  // 只有诊断轨有这一轮时也得把方向说出来：`--run` 的用处正是「我知道这一轮跑过」。
  const diagOnly = missingRun && options.diag !== null
    ? readDiag(options.diag).filter((row) => String(row.runId || "") === wanted).length
    : 0;
  // 只写字段的读侧：`audit.recorded.readme` 与现场那一份读法对账。默认只作信息项，
  // 把「读法没落盘」算进 `ok` 会让日志完整性与一个投递问题互相冒充。
  const auditDirOfTarget = mode === "file" ? path.dirname(target) : target;
  const readme = reconcileReadme({
    diagRows: options.diag === null ? [] : readDiag(options.diag),
    auditDir: auditDirOfTarget,
  });
  const readmeBlocks = options.strict && readme.mismatches.length > 0;
  const ok = gaps === 0
    && badLines === 0
    && unterminated.length === 0
    && runs.truncated === 0
    && !(missingRun && (diagOnly === 0 || options.diag === null))
    && (!cross || (cross.unmatched === 0 && cross.missingAudit === 0))
    && !readmeBlocks;
  return {
    ok,
    mode,
    target,
    ...(wanted === null ? {} : { run: wanted, runFound: !missingRun }),
    files,
    // 下面三个是汇总口径：gaps / badLines 是条数，不是文件数。
    gaps,
    badLines,
    lastLineTerminated: unterminated.length === 0,
    unterminated,
    runs: {
      total: runs.total,
      runless: wanted === null ? runsAll.runless : 0,
      closed: runs.closed,
      truncated: runs.truncated,
      unjudgeable: runs.unjudgeable,
      detail: runs.runs,
      problems: runs.problems,
      notes: runs.notes,
    },
    ...(diagOnly > 0 ? { diagOnlyRows: diagOnly } : {}),
    readme,
    ...(cross === null ? {} : { cross }),
  };
}

/**
 * 这次实际给了哪几天的审计文件。
 *
 * 先按文件名取日期段（落盘口径就是这个名字），文件名不是日期形状的手工夹具再退回
 * 「行里出现过的本地日期」。反向对账靠它区分「这一天没给」与「这一天确实没写」。
 *
 * @param {string[]} absolutes 本次判的文件绝对路径
 * @param {Array<object>} events 这些文件里的全部行
 * @returns {Set<string>} `YYYY-MM-DD` 集合
 */
function coveredDatesOf(absolutes, events) {
  const days = new Set();
  for (const absolute of absolutes) {
    const named = FILE_PATTERN.exec(path.basename(absolute));
    if (named) days.add(named[1]);
  }
  if (days.size > 0) return days;
  for (const event of Array.isArray(events) ? events : []) {
    const at = Date.parse(String(event && event.ts !== undefined ? event.ts : ""));
    if (!Number.isFinite(at)) continue;
    const date = new Date(at);
    const pad = (value) => String(value).padStart(2, "0");
    days.add(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
  }
  return days;
}

/**
 * 只写字段的读侧：`audit.recorded.readme` 声称投递过读法，现场到底有没有那一份。
 *
 * 为什么要有它：`readme` 原先只有写侧，读到 `installed` 的人无法区分「真的落了盘」与
 * 「写的时候以为落了盘」。这里的判据是**对账**，不是重投：写侧说 `installed` / `kept`
 * 而现场没有那份文件，就点名；写侧说 `failed` 但文件却在，也点名（那是另一次成功投递
 * 留下的，说明这一轮的失败不是终态）。
 *
 * 默认**不改退出码**：读法缺失不说明日志本身残缺，把它算进 `ok` 会让「日志完整」这件事
 * 被一个与它无关的投递问题否掉。要看红就显式 `--strict`。
 *
 * @param {object} input
 * @param {Array<object>} input.diagRows 给了 `--diag` 时的诊断轨行；没给就是空数组
 * @param {string} input.auditDir 审计目录（`README-for-ai.md` 与 `cards/` 的父目录）
 * @returns {{dir:string, present:boolean, recorded:number, installed:number, kept:number,
 *   failed:number, mismatches:string[]}}
 */
function reconcileReadme({ diagRows, auditDir }) {
  const rows = (Array.isArray(diagRows) ? diagRows : []).filter((row) => row && row.event === "audit.recorded");
  const target = path.join(auditDir, README_NAME);
  const present = fs.existsSync(target);
  const tally = { installed: 0, kept: 0, failed: 0 };
  const mismatches = [];
  for (const row of rows) {
    const status = String(row.readme || "").trim();
    if (status === "installed" || status === "kept") {
      tally[status] += 1;
      if (!present) {
        mismatches.push(
          `${String(row.runId || "（无 runId）")}：账本记 readme=${status}，现场没有 ${README_NAME}`,
        );
      }
      continue;
    }
    if (status === "failed") {
      tally.failed += 1;
      // 失败但文件在：多半是另一次成功投递留下的，不是矛盾，但要让人看见。
      if (present) {
        mismatches.push(
          `${String(row.runId || "（无 runId）")}：账本记 readme=failed，但现场有 ${README_NAME}（另一次投递留下的？）`,
        );
      }
      continue;
    }
    mismatches.push(`${String(row.runId || "（无 runId）")}：audit.recorded 没有 readme 字段（旧口径）`);
  }
  return {
    dir: auditDir,
    present,
    recorded: rows.length,
    installed: tally.installed,
    kept: tally.kept,
    failed: tally.failed,
    mismatches,
  };
}

/** 解析一遍某个文件的行；坏行只丢它自己，与逐文件判定同一口径。 */
function readEvents(absolute) {
  try {
    const raw = fs.readFileSync(absolute).toString("utf8");
    const events = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // 坏行已经在逐文件判定里点名，这里跳过，别让轮边界跟着整份失败。
      }
    }
    return events;
  } catch {
    return [];
  }
}

/** `--diag` 给的那份诊断轨；读不到按环境错误退 2，不静默当成「没有诊断轨」。 */
function readDiag(file) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) {
    throw new AuditCheckError(`读不到诊断轨 ${absolute}：--diag 要的是 diag.jsonl 那一份文件`);
  }
  return readEvents(absolute);
}


/** 单个文件的一行摘要；三种判据原文都在里面，便于按文件定位。 */
function describe(file) {
  const range = file.seq.min === null ? "（无 seq）" : `${file.seq.min}..${file.seq.max}`;
  return `events=${file.events} seq=${range} gaps=${JSON.stringify(file.gaps)}`
    + ` badLines=${JSON.stringify(file.badLines)} terminated=${file.lastLineTerminated}`
    + (file.seqless > 0 ? ` noSeq=${file.seqless}` : "");
}

/** 轮边界与跨轨对账的几行文字：与 JSON 里的字段一一对应，别让两种输出各说各话。 */
function emitRuns(report, io) {
  const runs = report.runs;
  io.out(
    `runs: ${runs.total}（收尾 ${runs.closed} / 截断 ${runs.truncated}`
    + `${runs.unjudgeable > 0 ? ` / 不可判 ${runs.unjudgeable}` : ""}）无 runId 行 ${runs.runless}`,
  );
  for (const run of runs.detail) {
    // 积压（ts − observedTs）跟在轮结论后面：读的人据此知道「这份账滞后多久」，
    // 没有它只能把「日志写得慢」误读成「这一轮跑得慢」。
    const lag = run.lagMs === null || run.lagMs === undefined ? "（无 observedTs）" : `${run.lagMs} ms`;
    // sealed 是收尾判据本身：true = 这一轮盖过结束标记，false = 没盖（截断或旧口径）。
    io.out(
      `  ${run.runId}  rows=${run.rows} seq=${run.firstSeq === null ? "（无 seq）" : `${run.firstSeq}..${run.lastSeq}`}`
      + ` layers=${run.layers.join("→") || "（无层）"} closed=${run.closed} sealed=${run.sealed}`
      + ` judgeable=${run.judgeable} lagMs=${lag}`,
    );
  }
  // 问题行给上限：一份被截断的日志可能有上千条同类，全打出来反而看不到别的判据。
  for (const problem of runs.problems.slice(0, 20)) io.out(`  ! ${problem}`);
  if (runs.problems.length > 20) io.out(`  ! 还有 ${runs.problems.length - 20} 条，用 --json 看全部`);
  // 信息项：老口径无法复算、诊断轨滚过导致这一轮不可判。都不是「日志坏了」，
  // 所以不进 problems、不参与退出码 —— 但它们必须可见，否则读的人会以为判据是全的。
  for (const note of (runs.notes || []).slice(0, 20)) io.out(`  · ${note}`);
  if ((runs.notes || []).length > 20) io.out(`  · 还有 ${runs.notes.length - 20} 条信息项，用 --json 看全部`);
  if (report.cross) {
    const cross = report.cross;
    io.out(`cross: 对上 ${cross.matched} / 共 ${cross.checked} 轮（补丁号与状态逐条比；次序不比；反方向另判）`);
    for (const problem of cross.problems.slice(0, 20)) io.out(`  ! ${problem}`);
    if (cross.problems.length > 20) io.out(`  ! 还有 ${cross.problems.length - 20} 条，用 --json 看全部`);
    // 次序差异不判红：两轨按不同规则排序，把它当判据会让每一轮都「对不上」。
    for (const note of cross.orderNotes.slice(0, 5)) io.out(`  · ${note}`);
    if (cross.orderNotes.length > 5) io.out(`  · 还有 ${cross.orderNotes.length - 5} 条次序说明，用 --json 看全部`);
    for (const note of cross.staleNotes.slice(0, 5)) io.out(`  · ${note}`);
    if (cross.staleNotes.length > 5) io.out(`  · 还有 ${cross.staleNotes.length - 5} 条「不可判」说明，用 --json 看全部`);
  }
  // 读法投递的对账：有记录才说话。没给 --diag 时这一节没有输入，不应打印成「对上了」。
  if (report.readme.recorded > 0) {
    io.out(
      `readme: 记 ${report.readme.recorded} 次（installed ${report.readme.installed} / kept ${report.readme.kept}`
      + ` / failed ${report.readme.failed}）现场 ${report.readme.present ? "有" : "无"} ${README_NAME}`,
    );
  }
  for (const mismatch of report.readme.mismatches.slice(0, 20)) io.out(`  · readme 对账：${mismatch}`);
  if (report.readme.mismatches.length > 20) {
    io.out(`  · readme 对账还有 ${report.readme.mismatches.length - 20} 条，用 --json 看全部`);
  }
}

function emit(report, options, io) {
  if (options.json) {
    io.out(JSON.stringify(report, null, 2));
    return;
  }
  if (report.mode === "file") {
    const file = report.files[0];
    io.out(`file: ${file.path}`);
    io.out(`lines: ${file.nonEmptyLines}（非空行）  ${describe(file)}`);
    io.out(`gaps: ${JSON.stringify(file.gaps)}`);
    io.out(`badLines: ${JSON.stringify(file.badLines)}`);
    io.out(`lastLineTerminated: ${file.lastLineTerminated}`);
    if (report.run !== undefined) {
      io.out(
        report.runFound
          ? `run: ${report.run}（审计轨有这一轮）`
          : `run: ${report.run}（审计轨没有这一轮${report.diagOnlyRows ? `；诊断轨有 ${report.diagOnlyRows} 行，方向是「审计缺」` : ""}）`,
      );
    }
    emitRuns(report, io);
    io.out(`ok: ${report.ok}`);
    return;
  }
  io.out(`dir: ${report.target}`);
  for (const file of report.files) io.out(`  ${file.file}  ${describe(file)}`);
  io.out(`gaps: 共 ${report.gaps}`);
  io.out(`badLines: 共 ${report.badLines}`);
  io.out(`lastLineTerminated: ${report.lastLineTerminated}`);
  io.out(
    `files: ${report.files.length} / gaps: 共 ${report.gaps} / badLines: 共 ${report.badLines}`
    + ` / 未终止末行: ${report.unterminated.length > 0 ? report.unterminated.join(", ") : "无"}`,
  );
  if (report.run !== undefined) {
    io.out(
      report.runFound
        ? `run: ${report.run}（审计轨有这一轮）`
        : `run: ${report.run}（审计轨没有这一轮${report.diagOnlyRows ? `；诊断轨有 ${report.diagOnlyRows} 行，方向是「审计缺」` : ""}）`,
    );
  }
  emitRuns(report, io);
  io.out(`ok: ${report.ok}`);
}

/** 参数解析：只认七个，别的一律当用法错误 —— 打错一个字就静默判默认目录，等于判错了对象。 */
function parseArgs(argv) {
  const options = { jsonl: null, dir: null, diag: null, run: null, json: false, strict: false, help: false };
  if (argv[0] !== "check") {
    if (argv.includes("--help") || argv.includes("-h")) {
      options.help = true;
      return options;
    }
    throw new AuditCheckError(`audit 只支持 check 子命令，收到 ${JSON.stringify(argv[0] ?? "")}（--help 看用法）`);
  }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg !== "--jsonl" && arg !== "--dir" && arg !== "--diag" && arg !== "--run") {
      throw new AuditCheckError(`未知参数 ${arg}（--help 看用法）`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new AuditCheckError(`${arg} 缺一个路径值（--help 看用法）`);
    }
    options[arg.slice(2)] = value;
    i += 1;
  }
  if (options.jsonl !== null && options.dir !== null) {
    throw new AuditCheckError("--jsonl 与 --dir 是两种判法，只能给一个");
  }
  return options;
}

/**
 * 命令行入口：解析参数 → 判定 → 打印 → 返回退出码。
 *
 * 返回码而不是自己 process.exit，是为了让「退出码」这一条判据能被测试直接断言。
 *
 * @param {string[]} argv `check` 之后的参数
 * @param {{out: (line: string) => void, err: (line: string) => void}} [io] 输出通道
 * @returns {number} 0 全过 / 1 有判据不过 / 2 用法或环境错误
 */
export function runAuditCli(argv, io = DEFAULT_IO) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      for (const line of USAGE) io.out(line);
      return EXIT_OK;
    }
    const report = buildReport(options);
    emit(report, options, io);
    return report.ok ? EXIT_OK : EXIT_HIT;
  } catch (error) {
    if (!(error instanceof AuditCheckError)) throw error;
    io.err(`[audit-check] ${error.message}`);
    return EXIT_TOOLING;
  }
}
