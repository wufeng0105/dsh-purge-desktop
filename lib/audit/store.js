/**
 * lib/audit/store.js — 审计日志的文件存储层：坏一行只丢一行，不拖垮整份。
 * 审计日志的存储层：追加一行 JSON、按天轮转、保留期清理、读回、证据链回溯。
 *
 * 为什么是「文件即接口」而不是数据库：审计行要在出事后**脱离程序**也能读 ——
 * 一条 JSON 打开就是全部信息，坏掉一行也只损失一行，不会拖垮整份日志。
 * 代价是没有事务，所以序号只由写入顺序分配、已落盘的行永不回改，
 * 日界与轮转全部编码进文件名，任何时刻扫一遍目录就能重建先后。
 *
 * 本层只碰 node:fs / node:path；事件形状的判据在 ./events.js。
 * 校验与落盘分开，是为了让「不合规就抛错」在没有文件系统的地方也能被测到，
 * 也避免这里反向依赖 lib/core.js 或 lib/desktop.js（模块边界判据）。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// 维护动作要留一条可读记录：清理删了哪些文件、代数是否顶到上限。
// 只依赖日志层自己（diag-log 只认识 log-rolling），不引入回环。
import { diagLog } from "../diag-log.js";
import { validateEvent } from "./events.js";

const AUDIT_SUBDIR = path.join("dsh-purge", "audit");
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;

// 两个数字是日志规格的硬约束：单文件上限决定何时按同日序号轮转，
// 保留天数决定清理边界。改它们等于改规格，必须先确认下游能接受。
//
// 三个都导出，理由是「读者要跟得上」：读数的一方若自己写一遍 30 天 / 23 代，
// 规格改的那天它不会跟着动，而症状只会是「读到的和写下的不一致」。
// `scripts/check-reader-follows.mjs` 把这条登记成判据。
export const MAX_FILE_BYTES = 10485760;
export const RETAIN_DAYS = 30;

/**
 * 单个日期最多几代（含主文件 `YYYY-MM-DD.jsonl` 记为第 0 代）。
 *
 * 为什么必须有上界：轮转号原先无上界，`pickFileName` 会一直往上找一个没写满的号。
 * 一个整天被反复写（或写放大 bug）时，那等于没有上限地造文件 —— 目录项数、清理成本、
 * 以及「这一天的日志有多大」三件事同时失控，而且没有任何一行日志说过它顶到了哪。
 *
 * 顶到上限后的行为是**继续写最后一代**，不是丢行：审计是取证动作，宁可单文件超限，
 * 也不能让新的证据无处可写。顶到的那一刻留一条 `prune.capped`，读的人因此知道
 * 「这一天的日志已经不是一个文件能装下的量了」。
 *
 * 导出给读侧：读者要从这里取上限，而不是自己再写一个 23。
 */
export const MAX_DAY_ROTATIONS = 23;

// v2 三字段紧跟 ts / seq：标识与观测时刻排在最前，人读与机读都不用翻完整行。
// 这里只列当场真写得出的键：`session` 已从 schema 与写侧白名单一起删掉，
// 键序表再留着它，读代码的人会以为那还是合法字段（旧行里残留的 session 照样读得回来，
// 读侧本来就不查白名单）。
const EVENT_KEY_ORDER = [
  "ts", "seq", "recordId", "runId", "observedTs",
  "event", "result", "layer", "actor", "entry", "target", "evidence", "detail",
];

/**
 * 日志目录 = <dshHome>/dsh-purge/audit。
 *
 * 必须显式给 dshHome：审计日志是运行期数据，回退到任何默认目录都可能在
 * 用户机器上凭空造出一棵不认识的状态树。
 */
export function resolveAuditDir(dshHome) {
  if (typeof dshHome !== "string" || dshHome.trim() === "") {
    throw new Error("审计日志只写在调用方显式给出的 DSH_HOME 之下：空值不回退到任何默认目录");
  }
  return path.join(path.resolve(dshHome), AUDIT_SUBDIR);
}

/** 本地时刻的 ISO 8601，必须带偏移（+08:00 / -05:00 / +00:00），否则跨机器无法比对。 */
export function localIso(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function formatLocalDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftLocalDate(date, days) {
  // 从当天零点起算再加减天数：夏令时切换日也只会挪到相邻日期的零点。
  const base = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  base.setDate(base.getDate() + days);
  return formatLocalDate(base);
}

function isInside(dir, absolute) {
  const rel = path.relative(dir, absolute);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 目录里的日志文件，按「新的在前」排序。
 *
 * 顺序只由文件名决定：日期段 + 同日轮转序号，不读文件内容、不看 mtime ——
 * mtime 会被解压 / 拷贝 / 备份工具改掉，文件名不会。
 */
function listAuditFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  return names
    .map((name) => {
      const matched = FILE_PATTERN.exec(name);
      if (!matched) return null;
      return { name, date: matched[1], rotation: matched[2] === undefined ? 0 : Number(matched[2]) };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date === b.date ? b.rotation - a.rotation : (a.date < b.date ? 1 : -1)));
}

function readFileEvents(absolute) {
  let raw;
  try {
    raw = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { events: [], skipped: 0 };
    throw error;
  }
  const events = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 坏行只损失它自己：计数让人知道日志里有多少行读不出来，但不阻断其余事件。
      skipped += 1;
    }
  }
  return { events, skipped };
}

/**
 * 读回的结果仍然是一个普通数组，跳过的行数挂在不可枚举的 skipped 上：
 * 计数不该参与结构比较（deepEqual 数组时多一个可枚举属性就会红），
 * 但调用方要能看见「这份日志并不完整」。
 */
function asEventArray(events, skipped) {
  Object.defineProperty(events, "skipped", { value: skipped, enumerable: false });
  return events;
}

/**
 * 挑文件名：主文件没写满就用它，否则按同日顺序号往上找，**到上限为止**。
 *
 * 返回 `capped` 而不是静默复用最后一代：顶到上限这件事本身是「这一天的量不正常」的
 * 信号，必须能被写进日志（`prune.capped`），否则读的人只会看到「日志都在这一个文件里」。
 */
function pickFileName(auditDir, date) {
  const sizeOf = (target) => {
    try {
      return fs.statSync(target).size;
    } catch {
      return -1;
    }
  };
  const base = `${date}.jsonl`;
  if (sizeOf(path.join(auditDir, base)) < MAX_FILE_BYTES) return { name: base, capped: false };
  for (let rotation = 1; rotation <= MAX_DAY_ROTATIONS; rotation += 1) {
    const name = `${date}.${rotation}.jsonl`;
    // 新序号文件不存在时 sizeOf 返回 -1，必然小于上限，循环不会空转。
    if (sizeOf(path.join(auditDir, name)) < MAX_FILE_BYTES) return { name, capped: false };
  }
  return { name: `${date}.${MAX_DAY_ROTATIONS}.jsonl`, capped: true };
}

/**
 * 下一个可用序号 = 文件里出现过的最大 seq + 1，空文件 / 不存在从 0 起。
 *
 * 用最大值而不是「最后一行的 seq」：坏行、乱序追加都不该让序号倒退或复用。
 * 整份文件一行都解析不出来时按行数续编，避开坏行里可能埋着的序号。
 */
function nextSeq(absolute) {
  let raw;
  try {
    raw = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return 0;
    throw error;
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  let max = -1;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (Number.isInteger(parsed.seq) && parsed.seq > max) max = parsed.seq;
    } catch {
      // 解析不出来的行既不计入序号，也不阻断追加；它已经会被读回时计为 skipped。
    }
  }
  if (max < 0) return lines.length;
  return max + 1;
}

function orderEvent(input, ts, seq) {
  const ordered = {};
  for (const key of EVENT_KEY_ORDER) {
    if (key === "ts") ordered.ts = ts;
    else if (key === "seq") ordered.seq = seq;
    else if (input[key] !== undefined) ordered[key] = input[key];
  }
  // 不认识的键照样带上，交给校验点名 —— 静默丢弃会让人以为写进去了。
  for (const key of Object.keys(input)) {
    if (!EVENT_KEY_ORDER.includes(key)) ordered[key] = input[key];
  }
  return ordered;
}

/**
 * 追加一行。上一次写到一半断电会留下没有换行结尾的行，直接写会把两条粘成一条、
 * 双双不可解析，所以先补一个换行再写。
 */
function appendLine(absolute, line) {
  let needsNewline = false;
  try {
    const size = fs.statSync(absolute).size;
    if (size > 0) {
      const fd = fs.openSync(absolute, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        needsNewline = last[0] !== 0x0a;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    needsNewline = false;
  }
  fs.appendFileSync(absolute, `${needsNewline ? "\n" : ""}${line}\n`, "utf8");
}

/**
 * 保留策略的低频触发点：**每个审计目录每天只在第一次写入时清一次**。
 *
 * 为什么必须低频：清理的主体动作是「列一遍目录再逐个删文件」，那是 O(目录项) 的系统调用。
 * 一次 apply 会连着写几十上百行事件（一条补丁的每个落点一行 + 每层一条结论），
 * 挂在每次 append 上就等于把一次目录扫描乘上事件数 —— 审计是给排障用的旁路，
 * 不该让它在热路径上比被观测的动作还贵。
 *
 * 为什么一天一次就够：保留期是**按天**算的（文件名里的日期段，与 mtime 无关），
 * 一天之内目录的年龄结构不会变 —— 同一天里第二次清理能删的东西，第一次已经删完了。
 * 所以「按天首次写入」是这个策略的天然粒度，不是随手挑的节流。
 *
 * 为什么记住的是目录而不是 home：一个进程可能先后服务多个 dshHome（测试与真实安装同时存在
 * 是常态），按 home 记忆会让第二个目录永远拿不到清理。键是审计目录的绝对路径。
 *
 * 失败不许冒泡：清理是维护动作，写审计是取证动作。清理删不掉一个被占用的文件，
 * 不该让这一行事件写不进去 —— 那会让「日志缺失」变成「因为清理失败所以没记录」。
 */
const prunedDayByDir = new Map();

/** 同一天顶到代数上限这件事只记一条：它是一整天的属性，不是每次写入的属性。 */
const cappedDayByDir = new Map();

/** 本地日期段，与文件名用的是同一口径（formatLocalDate）。 */
function maybePrune(dshHome, auditDir, now) {
  const day = formatLocalDate(now);
  if (prunedDayByDir.get(auditDir) === day) return;
  // 先占位再动手：即使清理抛错，本进程这一天也不再重试，避免每次写入都撞同一个失败。
  prunedDayByDir.set(auditDir, day);
  try {
    const removed = prune(dshHome, { now });
    // 清理删了什么是「日志为什么变短了」的唯一答案：没有这一条，读者只能看到
    // 目录里少了几天的文件，然后猜是不是自己搬过。空删不记 —— 那会把日志填满噪声。
    if (removed.length > 0) {
      diagLog("prune.removed", {
        removed: removed.length,
        names: removed.join(","),
        retainDays: RETAIN_DAYS,
      }, dshHome);
    }
  } catch {
    // 见上：清理失败不阻断写入，也不在这里重试。
  }
}

/** 代数顶到上限：一天只记一条，写明上限与最后落点。 */
function noteCappedDay(dshHome, auditDir, day, fileName) {
  if (cappedDayByDir.get(auditDir) === day) return;
  cappedDayByDir.set(auditDir, day);
  diagLog("prune.capped", {
    day,
    generations: MAX_DAY_ROTATIONS + 1,
    file: fileName,
  }, dshHome);
}

/**
 * 追加一条事件：补本地带偏移的 ts、按文件现状分配 seq、分配行级 recordId、校验后追加一行。
 *
 * seq 与 recordId 都不接受入参自带：手写的序号会与已落盘的行撞号，外部造的行级 uuid
 * 绕开唯一性保证，而撞号之后「哪条发生了什么」就再也理不清了。校验失败时一行都不写。
 */
export function appendEvent(dshHome, input, { now = new Date() } = {}) {
  const auditDir = resolveAuditDir(dshHome);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("appendEvent 需要事件对象：先 makeEvent 再追加");
  }
  if (input.seq !== undefined) {
    throw new Error("seq 由追加顺序分配，入参不许自带：手写的序号会和已落盘的行撞号");
  }
  if (input.recordId !== undefined) {
    throw new Error("recordId 由存储层分配，入参不许自带：外部造的行级 uuid 绕开了唯一性保证");
  }
  const ts = input.ts === undefined ? localIso(now) : input.ts;
  const day = formatLocalDate(now);
  const picked = pickFileName(auditDir, day);
  const fileName = picked.name;
  const absolute = path.join(auditDir, fileName);
  const event = orderEvent({ ...input, recordId: randomUUID() }, ts, nextSeq(absolute));
  validateEvent(event);
  fs.mkdirSync(auditDir, { recursive: true });
  appendLine(absolute, JSON.stringify(event));
  // 清理排在写入之后：这一行已经落盘，清理再怎么失败都不影响本次取证。
  maybePrune(dshHome, auditDir, now);
  if (picked.capped) noteCappedDay(dshHome, auditDir, day, fileName);
  return event;
}

/**
 * 读回事件。
 *
 * 给 file 时只读那一个文件（必须落在审计目录内，避免顺手读到别的路径）；
 * 给 date 时读该日的主文件与全部同日轮转文件，按轮转顺序拼接；
 * 两者都不给时读今天 —— 今天还没有文件就退回最新一天，而不是返回空数组骗人。
 */
export function readEvents(dshHome, { date, file } = {}) {
  const auditDir = resolveAuditDir(dshHome);
  const targets = [];

  if (file !== undefined) {
    if (typeof file !== "string" || file.trim() === "") throw new Error("file 必须是非空文件名");
    const absolute = path.isAbsolute(file) ? file : path.join(auditDir, file);
    if (!isInside(auditDir, absolute)) throw new Error(`只读审计目录内的文件，收到 ${absolute}`);
    targets.push(absolute);
  } else {
    if (date !== undefined && !DAY_PATTERN.test(String(date))) {
      throw new Error(`date 必须是 YYYY-MM-DD，收到 ${JSON.stringify(date)}`);
    }
    const all = listAuditFiles(auditDir);
    let day = date === undefined ? formatLocalDate(new Date()) : String(date);
    let sameDay = all.filter((entry) => entry.date === day);
    if (sameDay.length === 0 && date === undefined && all.length > 0) {
      day = all[0].date;
      sameDay = all.filter((entry) => entry.date === day);
    }
    sameDay
      .slice()
      .sort((a, b) => a.rotation - b.rotation)
      .forEach((entry) => targets.push(path.join(auditDir, entry.name)));
  }

  const events = [];
  let skipped = 0;
  for (const absolute of targets) {
    const result = readFileEvents(absolute);
    events.push(...result.events);
    skipped += result.skipped;
  }
  return asEventArray(events, skipped);
}

function compareByRecency(a, b) {
  const left = Date.parse(a.ts);
  const right = Date.parse(b.ts);
  if (left !== right) return right - left;
  return (b.seq ?? 0) - (a.seq ?? 0);
}

/**
 * 最新 n 条，倒序。
 *
 * 同一文件里就是 seq 倒序；跨天 / 跨轮转时 ts 是唯一可比的主序，
 * seq 只在时刻相同时作次级判据（它每个文件都从 0 起，单独排会乱）。
 */
export function tail(dshHome, { n = 50, layer, event, runId } = {}) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`tail 的 n 必须是非负整数，收到 ${JSON.stringify(n)}`);
  const auditDir = resolveAuditDir(dshHome);
  const wanted = (candidate) => {
    if (layer !== undefined && candidate.layer !== layer) return false;
    // v1 旧行没有 runId，按 runId 过滤时自然排除 —— 它们本就不属于那次运行。
    if (runId !== undefined && candidate.runId !== runId) return false;
    if (event !== undefined) {
      if (typeof candidate.event !== "string") return false;
      if (!candidate.event.startsWith(event)) return false;
    }
    return true;
  };

  const picked = [];
  for (const entry of listAuditFiles(auditDir)) {
    const { events } = readFileEvents(path.join(auditDir, entry.name));
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (wanted(events[index])) picked.push(events[index]);
    }
    if (picked.length >= n) break;
  }
  picked.sort(compareByRecency);
  return picked.slice(0, n);
}

/**
 * 证据链回溯：本条 → evidence.refSeq → 被引事件，直到落在文件证据上。
 *
 * seq 只在文件内唯一（每个文件从 0 起），所以 `why(seq)` 天然有一个跨文件歧义：
 * 同一天轮转出来的两个文件都可能有 seq=0。这里不假装它不存在 —— 把所有含该 seq 的
 * 文件都列进 `ambiguous` / `candidates`，起点按「新文件优先」取（与 tail 同一顺序），
 * 读的人因此知道「这条结论只在其中一个文件里成立」，而不是以为日志里只有一个 seq=0。
 * 要消歧就把文件名显式传进来（`options.file`），那时只在该文件里找。
 *
 * 引用证据只允许指向同一个文件：跨文件的 refSeq 没有可比性（两个文件各自从 0 起），
 * 所以链上不再读 `evidence.file`，落盘时也不再写它。
 *
 * 返回 { seq, file, event, chain, complete, brokenAt, ambiguous, candidates }。
 * 链断时不抛错，因为「断在哪」本身就是最有用的结论；brokenAt 说明断点。
 *
 * @param {string} dshHome 状态目录
 * @param {number} seq 文件内序号
 * @param {{file?: string}} [options] 显式指定文件名（消歧用）
 */
export function why(dshHome, seq, options = {}) {
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`why 需要非负整数 seq，收到 ${JSON.stringify(seq)}`);
  const auditDir = resolveAuditDir(dshHome);
  const wanted = typeof options?.file === "string" ? options.file.trim() : "";
  const files = listAuditFiles(auditDir).filter((entry) => wanted === "" || entry.name === wanted);

  const inFile = (fileName, target) => {
    const absolute = path.join(auditDir, fileName);
    if (!isInside(auditDir, absolute)) return null;
    const { events } = readFileEvents(absolute);
    return events.find((candidate) => candidate.seq === target) ?? null;
  };

  // 新文件在前的顺序由 listAuditFiles 给出：candidates[0] 就是「最新那个文件」，
  // 与旧实现选中同一个起点，只是现在把「还有别的文件也有同号」这件事说出来。
  const candidates = [];
  for (const entry of files) {
    if (inFile(entry.name, seq)) candidates.push(entry.name);
  }
  let start = null;
  if (candidates.length > 0) start = { event: inFile(candidates[0], seq), file: candidates[0] };
  if (!start) {
    return {
      seq,
      file: null,
      event: null,
      chain: [],
      complete: false,
      ambiguous: false,
      candidates: [],
      brokenAt: {
        refSeq: null,
        fromSeq: null,
        file: wanted === "" ? null : wanted,
        reason: wanted === ""
          ? `审计目录 ${auditDir} 下没有任何文件的 seq=${seq}`
          : `审计目录 ${auditDir} 下的 ${wanted} 里没有 seq=${seq}`,
      },
    };
  }

  const chain = [];
  const seen = new Set();
  let current = start;
  let brokenAt = null;
  let complete = false;

  while (current) {
    const key = `${current.file}#${current.event.seq}`;
    if (seen.has(key)) {
      brokenAt = {
        refSeq: current.event.seq,
        fromSeq: current.event.seq,
        file: current.file,
        reason: `引用成环：${key} 在链上第二次出现`,
      };
      break;
    }
    seen.add(key);
    chain.push({
      seq: current.event.seq,
      event: current.event.event,
      file: current.file,
      evidence: current.event.evidence,
    });

    const evidence = current.event.evidence;
    const isRef = evidence && typeof evidence === "object" && !Array.isArray(evidence)
      && Number.isInteger(evidence.refSeq);
    if (!isRef) {
      // 落到文件证据（或证据本身残缺）就是链尾。
      complete = true;
      break;
    }

    const refSeq = evidence.refSeq;
    // 引用只许同文件：两个文件各自从 0 起分配 seq，跨文件的 refSeq 没有可比性。
    // 落盘侧也不再写 evidence.file，所以这里就按条目所在文件找。
    const refFile = current.file;
    if (refSeq >= current.event.seq) {
      brokenAt = {
        refSeq,
        fromSeq: current.event.seq,
        file: refFile,
        reason: `refSeq=${refSeq} 不小于本条 seq=${current.event.seq}：引用必须指向更早的事件`,
      };
      break;
    }
    const next = inFile(refFile, refSeq);
    if (!next) {
      brokenAt = {
        refSeq,
        fromSeq: current.event.seq,
        file: refFile,
        reason: `被引用的事件 seq=${refSeq} 不在本条所在文件 ${refFile} 里（引用只许同文件）`,
      };
      break;
    }
    current = { event: next, file: refFile };
  }

  return {
    seq,
    file: start.file,
    event: start.event.event,
    chain,
    complete,
    brokenAt,
    // 同号 seq 出现在多个文件里时点名全部候选：按「新文件优先」选出的起点不是唯一解，
    // 读的人必须知道这一点，否则会把两个文件里的 seq=0 当成同一条。
    ambiguous: candidates.length > 1,
    candidates,
  };
}

/**
 * 清理超过保留期的日志文件，返回被删的文件名。
 *
 * 只认 YYYY-MM-DD(.n).jsonl 形状：别的文件不是本模块写的，不代替别人删。
 * 保留期按「日期段」算，与文件大小、mtime 无关。
 */
export function prune(dshHome, { retainDays = RETAIN_DAYS, now = new Date() } = {}) {
  if (!Number.isInteger(retainDays) || retainDays < 0) {
    throw new Error(`retainDays 必须是非负整数，收到 ${JSON.stringify(retainDays)}`);
  }
  const auditDir = resolveAuditDir(dshHome);
  const cutoff = shiftLocalDate(now, -retainDays);
  const removed = [];
  for (const entry of listAuditFiles(auditDir)) {
    if (entry.date >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(auditDir, entry.name));
      removed.push(entry.name);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  return removed;
}
