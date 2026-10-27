/**
 * lib/audit/events.js — 审计事件的形状判据：不合规的事件在落盘前抛错。
 * 审计事件的形状判据与构造器。
 *
 * 为什么校验放在这里而不是散在写入处：审计日志的全部价值在于事后复核 ——
 * 缺 bytes 的文件证据事后分不清「文件不存在」与「文件是空的」；不带时区偏移的
 * 时刻换台机器就看不出先后；evidence 里写 {"ok": true} 等于拿结论冒充证据。
 * 所以不合规的事件必须在落盘前抛错，而不是写进去等人踩坑。
 *
 * 这里只做形状与自述检查，不碰文件系统：纯函数，任何环境（含单元测试）都能跑。
 * 落盘那一侧见 ./store.js，两边共用同一份 ts / event / evidence 规则。
 *
 * 这套判据**只给写侧用**：makeEvent 与 appendEvent 调它。读侧（读回、tail、why）
 * 一律不过它 —— 旧日志里的名字与字段可能早就落在今天的新规则之外，读的时候抛错
 * 等于把历史日志变成不可读的，那比格式漂移更糟。事件名的合法集合只在 ./vocabulary.js
 * 那一个地方定义：写侧不在词表里就抛错，读侧不查它。
 */
import { LAYER_ORDER } from "./layers.js";
import {
  CONCLUSION_SUFFIX,
  EVENT_NAMES,
  isFileEventName,
  isKnownEventName,
  nearestEventName,
} from "./vocabulary.js";

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// 带时区偏移的时刻。裸本地时间（2026-10-23T20:00:00）在这里就被拒：
// 同一份日志可能被不同时区的机器读，没有偏移就没有先后。
const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

// 点分事件名：至少两段，首段是动作域，只允许小写字母数字；后续段允许连字符。
const EVENT_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;

// 结论层事件的事件名首段必须就是层名，避免 layer 与 event 各自表述。
const LAYER_EVENT_PATTERN = /^(?:prompt|code|tool)\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

const RESULT_STATES = ["ok", "fail", "skip", "partial"];
const ACTORS = ["host", "client", "cli", "subagent"];

/**
 * partial 的两个来路。`record` = 记录缺口（completeness 有假项），`layer` = 层内部分成功。
 * 只允许这两个取值：多一档就说明还有第三种 partial，而读的人只学会了两种读法。
 */
const PARTIAL_REASONS = ["layer", "record"];

// 这三个键一旦取值为 true，就是用「我成功了」替换证据本身。schema 明确禁止。
const SELF_ATTEST_KEYS = ["ok", "success", "worked"];

const TOP_LEVEL_KEYS = new Set([
  "ts", "seq", "recordId", "runId", "observedTs", "event", "result", "layer", "actor", "entry",
  "target", "evidence", "detail",
]);

// 两张表就是 schema 里两份证据定义的全部属性：留下一个没有写入方的键，
// 等于给读的人一个「也许有」的错觉 —— 那比不写更贵，所以表里只留真会出现的键。
const FILE_EVIDENCE_KEYS = new Set(["file", "marker", "hits", "bytes", "offset", "before", "after"]);
const REF_EVIDENCE_KEYS = new Set(["refSeq", "quote"]);

// v2 三字段的形状。seq 每个日志文件从 0 起，跨文件定位一行只能靠 recordId；
// runId 把同一次尝试的事件整批捞出；observedTs 与 ts（落盘时刻）分开，差值即写入积压。
// v1 旧日志没有这三者 —— 读侧必须容忍，写侧由存储层与落账方补齐。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_KEYS = new Set(["sha256", "bytes"]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** 事件不合规。单独一个类型，调用方可以只接这一类错误而不吞掉真正的 IO 故障。 */
class AuditEventError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuditEventError";
  }
}

function fail(message) {
  throw new AuditEventError(message);
}

function scanSelfAttestation(value, where) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSelfAttestation(item, `${where}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (SELF_ATTEST_KEYS.includes(key) && nested === true) {
      fail(
        `${where}.${key} 是自述：它能被不跑任何检查的人随手写成 true，`
        + "事后无法复核。请写出证据本身（哪个文件、哪个 marker、命中几次、多少字节），或引用一条已落盘的事件",
      );
    }
    scanSelfAttestation(nested, `${where}.${key}`);
  }
}

function assertObjectShape(value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${where} 必须是对象，收到 ${Array.isArray(value) ? "数组" : JSON.stringify(value)}`);
  }
}

function assertBoundedString(value, where, { min = 1, max, field }) {
  if (typeof value !== "string") fail(`${where}.${field} 必须是字符串，收到 ${JSON.stringify(value)}`);
  if (value.length < min) fail(`${where}.${field} 不许为空：缺了它就复核不了`);
  if (max !== undefined && value.length > max) fail(`${where}.${field} 超过 ${max} 字符`);
  return value;
}

function assertNonNegativeInteger(value, where, field) {
  if (!Number.isInteger(value) || value < 0) {
    fail(`${where}.${field} 必须是≥0 的整数，收到 ${JSON.stringify(value)}`);
  }
}

function assertFileEvidence(ev, where) {
  assertObjectShape(ev, where);
  for (const key of Object.keys(ev)) {
    if (!FILE_EVIDENCE_KEYS.has(key)) {
      fail(
        `${where}.${key} 不是文件证据的字段：只允许 file / marker / hits / bytes（可选 offset / before / after）。`
        + "多写的字段没有任何地方会读",
      );
    }
  }
  assertBoundedString(ev.file, where, { max: 512, field: "file" });
  assertBoundedString(ev.marker, where, { max: 200, field: "marker" });
  assertNonNegativeInteger(ev.hits, where, "hits");
  assertNonNegativeInteger(ev.bytes, where, "bytes");
  if (has(ev, "offset")) assertNonNegativeInteger(ev.offset, where, "offset");
  if (has(ev, "before")) assertDigestSummary(ev.before, where, "before");
  if (has(ev, "after")) assertDigestSummary(ev.after, where, "after");
}

/**
 * before / after 摘要：{sha256, bytes} 或 null。
 * null 表示「那一侧读不到」（如 apply 前文件还在密封 asar 里），与「没写这个键」
 * （调用方根本没采集）区分开 —— 前者是留了痕的缺口，后者是没打算记。
 */
function assertDigestSummary(value, where, field) {
  if (value === null) return;
  assertObjectShape(value, `${where}.${field}`);
  for (const key of Object.keys(value)) {
    if (!DIGEST_KEYS.has(key)) {
      fail(`${where}.${field}.${key} 不是摘要的字段：只允许 sha256 / bytes`);
    }
  }
  if (!SHA256_PATTERN.test(String(value.sha256))) {
    fail(`${where}.${field}.sha256 必须是 64 位小写十六进制，收到 ${JSON.stringify(value.sha256)}`);
  }
  assertNonNegativeInteger(value.bytes, `${where}.${field}`, "bytes");
}

function assertRefEvidence(ev, where, { seq } = {}) {
  assertObjectShape(ev, where);
  for (const key of Object.keys(ev)) {
    if (!REF_EVIDENCE_KEYS.has(key)) {
      fail(
        `${where}.${key} 不是引用证据的字段：只允许 refSeq（可选 quote）`,
      );
    }
  }
  if (!has(ev, "refSeq")) fail(`${where}.refSeq 必填：引用证据必须指向一条已落盘的事件`);
  assertNonNegativeInteger(ev.refSeq, where, "refSeq");
  if (Number.isInteger(seq) && ev.refSeq >= seq) {
    fail(`${where}.refSeq=${ev.refSeq} 必须早于本条 seq=${seq}：引用只能指向已落盘的前序事件，否则链会成为环`);
  }
  if (has(ev, "quote")) assertBoundedString(ev.quote, where, { max: 200, field: "quote" });
}

function assertEvidence(ev, { seq } = {}) {
  assertObjectShape(ev, "evidence");
  scanSelfAttestation(ev, "evidence");
  const refShape = has(ev, "refSeq");
  const fileShapeFields = ["file", "marker", "hits", "bytes"].filter((key) => has(ev, key));
  if (refShape && fileShapeFields.length > 0) {
    fail(
      `evidence 两种形态混用：既有 refSeq，又有 ${fileShapeFields.join(" / ")}。`
      + "文件证据（file+marker+hits+bytes）与引用证据（refSeq）二选一",
    );
  }
  if (refShape) assertRefEvidence(ev, "evidence", { seq });
  else assertFileEvidence(ev, "evidence");
}

function assertEventName(event, layer) {
  if (typeof event !== "string") fail(`event 必须是字符串，收到 ${JSON.stringify(event)}`);
  if (!EVENT_PATTERN.test(event)) {
    fail(`event "${event}" 不是点分事件名：形如 code.probe / apply.result，至少两段，全小写`);
  }
  if (layer !== undefined) {
    if (!LAYER_ORDER.includes(layer)) {
      fail(`layer 只能是 ${LAYER_ORDER.join(" / ")}，收到 ${JSON.stringify(layer)}`);
    }
    if (!LAYER_EVENT_PATTERN.test(event)) {
      fail(`layer=${layer} 的事件名首段必须是 ${layer}，收到 "${event}"：层与事件名不许各说各话`);
    }
    const first = event.split(".")[0];
    if (first !== layer) {
      fail(`layer=${layer} 与 event "${event}" 的首段 "${first}" 不一致：哪一层的判断，就只能报那一层`);
    }
  }
  // 词表排在形状与层之后判：先告诉人「这不是合法事件名」，再告诉他「合法名长什么样」。
  if (!isKnownEventName(event)) {
    const nearest = nearestEventName(event);
    fail(
      `event "${event}" 不在审计事件词表里：词表在 lib/audit/vocabulary.js（${EVENT_NAMES.length} 个名字）。`
      + (nearest === null ? "词表里没有形状相近的名字。" : `最接近的合法名是 "${nearest}"。`)
      + "新增事件要先把名字加进词表再写写入方，否则落盘前就会在这里被拦下",
    );
  }
  // 结论层是「整层的判断」，必须自己说明是哪一层：层结论不带层名，事后分不清是替谁下的。
  if (layer === undefined && event.endsWith(CONCLUSION_SUFFIX)) {
    fail(
      `event "${event}" 是结论层事件，必须带 layer（${LAYER_ORDER.join(" / ")} 之一）：`
      + "结论层不带层名，事后分不清这条结论是替哪一层下的",
    );
  }
  // 文件层是「一条补丁在某个文件上的探针」：同一个后缀在三个层里都合法，
  // 不带层名就分不清这条探针替哪一层取证，层结论也就无从核对。
  if (layer === undefined && isFileEventName(event)) {
    fail(
      `event "${event}" 是文件层事件，必须带 layer（${LAYER_ORDER.join(" / ")} 之一）：`
      + "同一后缀在三个层里都合法，不带层名就分不清这条探针替哪一层取证",
    );
  }
}

function assertTs(ts, field = "ts") {
  if (typeof ts !== "string") fail(`${field} 必须是字符串，收到 ${JSON.stringify(ts)}`);
  if (!TS_PATTERN.test(ts)) {
    fail(
      `${field} "${ts}" 不带时区偏移：必须写成 2026-10-23T18:15:05+08:00 或带 Z 的 UTC 形式。`
      + "裸本地时间换台机器就看不出先后",
    );
  }
  if (Number.isNaN(Date.parse(ts))) fail(`${field} "${ts}" 解析不出真实时刻`);
}

function assertSeq(seq) {
  if (!Number.isInteger(seq) || seq < 0) fail(`seq 必须是≥0 的整数，收到 ${JSON.stringify(seq)}`);
}

const COMPLETENESS_KEYS = ["patches", "files", "layers"];

/**
 * 层结论的完备性与 result 不许互相拆台：completeness 任一项为假，结论只能是 partial 或 fail。
 *
 * 为什么不是「必须等于 partial」：记不全但层里有 miss 时，结论保持 fail ——
 * 失败比「记得不全」更严重，压成 partial 会把真失败读成记账问题。这与
 * ./layers.js 的 foldCompleteness 是同一口径，两处不许各说各话。
 *
 * 为什么反过来「三项全真就不许 partial」不成立：partial 还表示层内「有成功也有跳过」，
 * 那是记录完整时的正常结论，不是缺口信号。
 *
 * 只在 detail.completeness 是对象时判：老调用方不带 completeness，形状上不该被这条拦。
 */
function assertCompletenessFold(event) {
  if (!event.event.endsWith(CONCLUSION_SUFFIX)) return;
  if (!has(event, "detail")) return;
  const detail = event.detail;
  const completeness = detail.completeness;
  if (completeness === undefined) return;
  assertObjectShape(completeness, "detail.completeness");
  const falseOnes = COMPLETENESS_KEYS.filter((key) => completeness[key] === false);
  if (falseOnes.length === 0) return;
  if (event.result === "partial" || event.result === "fail") return;
  fail(
    `event "${event.event}" 的 detail.completeness 有假项（${falseOnes.join(" / ")}），`
    + `result 却是 "${event.result}"：绿结论不许盖住记录缺口，只能记 partial 或 fail`,
  );
}

/**
 * partial 的来路必须与 result 一致：写了 partialReason 而 result 不是 partial，
 * 是在给一条非 partial 的结论安一个来路 —— 读者会去按 partial 的两种读法解读它。
 *
 * 反过来（result=partial 却没写来路）不拦：旧口径的行本来就没有这个字段，
 * 写侧把它变成必填会把历史日志变成不可读的。缺来路由 `audit check` 记成信息项。
 */
function assertPartialReason(event) {
  if (!has(event, "detail")) return;
  const detail = event.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return;
  if (!has(detail, "partialReason")) return;
  const reason = detail.partialReason;
  if (!PARTIAL_REASONS.includes(reason)) {
    fail(
      `detail.partialReason ${JSON.stringify(reason)} 非法：只能是 ${PARTIAL_REASONS.join(" / ")}`
      + "（record = 记录缺口，layer = 层内部分成功）",
    );
  }
  if (event.result !== "partial") {
    fail(
      `detail.partialReason=${reason} 只属于 result=partial 的结论，收到 result=${JSON.stringify(event.result)}：`
      + "partial 的来路不能安在别的结论上",
    );
  }
}

/**
 * 宿主 build 是「这条补丁为哪个 build 写的」唯一的字段，所以它不许单独出现。
 *
 * 空串的合法含义是「没读到宿主」，而没读到与「这一行压根没打算记」在日志里同形 ——
 * 除非同一行里有一句来源说明。所以这里判的不是值对不对（写侧复核不了宿主），
 * 而是「空串有没有解释」：`hostBuild` 在场，`hostBuildSource` 就必须在场且非空。
 */
function assertHostBuildDetail(event) {
  if (!has(event, "detail")) return;
  const detail = event.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return;
  if (!has(detail, "hostBuild")) return;
  if (typeof detail.hostBuild !== "string") {
    fail(`detail.hostBuild 必须是字符串（取不到时写空串），收到 ${JSON.stringify(detail.hostBuild)}`);
  }
  if (!has(detail, "hostBuildSource")) {
    fail(
      "detail.hostBuild 必须配 detail.hostBuildSource：只留空串的话，"
      + "「读不到宿主」与「没打算记」在日志里长得一模一样",
    );
  }
  assertBoundedString(detail.hostBuildSource, "detail", { max: 1000, field: "hostBuildSource" });
}

/**
 * 全量校验一条事件。
 *
 * stamped 为 true 时要求 ts 与 seq 都已就位（落盘前的最终检查）；
 * 为 false 时两者可缺席（构造阶段的草稿），但一旦出现就照样校验。
 *
 * 只给写侧用：makeEvent 与 appendEvent 是仅有的两个调用方。它会把不在词表里的
 * 事件名、以及缺 layer 的层结论判死，所以读侧绝不能调它 —— 旧行必须原样读得回来。
 */
export function validateEvent(event, { stamped = true } = {}) {
  assertObjectShape(event, "事件");
  for (const key of Object.keys(event)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      fail(`未知顶层字段 "${key}"：事件形状是封闭的，多写的字段没有任何地方会读`);
    }
  }

  if (stamped) {
    if (!has(event, "ts")) fail("缺 ts：落盘前必须带上带时区偏移的时刻");
    if (!has(event, "seq")) fail("缺 seq：落盘前必须由存储层分配序号");
    if (!has(event, "recordId")) fail("缺 recordId：落盘前必须由存储层分配行级 uuid");
  }
  if (has(event, "ts")) assertTs(event.ts);
  if (has(event, "seq")) assertSeq(event.seq);
  if (has(event, "recordId") && !UUID_PATTERN.test(String(event.recordId))) {
    fail(`recordId ${JSON.stringify(event.recordId)} 不是小写 uuid：跨文件定位一行全靠它，形状必须稳定`);
  }
  if (has(event, "runId")) assertBoundedString(event.runId, "事件", { max: 64, field: "runId" });
  if (has(event, "observedTs")) assertTs(event.observedTs, "observedTs");

  if (!has(event, "event")) fail("缺 event：点分事件名，形如 code.probe");
  assertEventName(event.event, event.layer);
  // 文件层事件属于某一次 apply：文件探针与层结论靠同一个 runId 拼成一批，
  // 缺了它就只能按时间邻近去猜，而时间邻近在两次 apply 挨着跑时并不成立。
  if (isFileEventName(event.event) && !has(event, "runId")) {
    fail(
      `event "${event.event}" 是文件层事件，必须带 runId：`
      + "文件探针与层结论靠同一个 runId 拼成一次 apply，缺了它这批事件就查不回来",
    );
  }

  if (!has(event, "result")) fail(`缺 result：只能是 ${RESULT_STATES.join(" / ")}`);
  if (!RESULT_STATES.includes(event.result)) {
    fail(`result ${JSON.stringify(event.result)} 非法：只能是 ${RESULT_STATES.join(" / ")}`);
  }

  if (has(event, "evidence")) assertEvidence(event.evidence, { seq: event.seq });
  else fail("缺 evidence：要么文件证据（file+marker+hits+bytes），要么引用证据（refSeq）");

  if (has(event, "actor") && !ACTORS.includes(event.actor)) {
    fail(`actor ${JSON.stringify(event.actor)} 非法：只能是 ${ACTORS.join(" / ")}`);
  }
  // entry 是「哪个入口触发的」，取值集合在 lib/diag-log.js 的九个身份隔壁（这里不复制那张表：
  // 复制一张枚举就是第二份真相，加第十个入口时只改一处才对）。这里只锁形状。
  if (has(event, "entry")) assertBoundedString(event.entry, "事件", { max: 32, field: "entry" });
  if (has(event, "target")) assertBoundedString(event.target, "事件", { max: 512, field: "target" });
  if (has(event, "detail")) {
    assertObjectShape(event.detail, "detail");
    scanSelfAttestation(event.detail, "detail");
  }
  assertCompletenessFold(event);
  assertPartialReason(event);
  assertHostBuildDetail(event);
  return event;
}

/** 文件证据：哪个文件的哪个字面量命中几次、文件多少字节。四个字段缺一不可。 */
export function fileEvidence(input = {}) {
  assertObjectShape(input, "fileEvidence 入参");
  const evidence = { ...input };
  assertFileEvidence(evidence, "evidence");
  return evidence;
}

/** 引用证据：本条结论建立在另一条已落盘的事件上。 */
export function refEvidence(input = {}) {
  assertObjectShape(input, "refEvidence 入参");
  const evidence = { ...input };
  assertRefEvidence(evidence, "evidence");
  return evidence;
}

/**
 * 构造一条尚未落盘的事件草稿（没有 ts / seq，由存储层补）。
 *
 * 入参的键原样保留（包括不认识的键），这样多写的字段会在校验里被点名，
 * 而不是被静默丢弃 —— 静默丢弃等于让人以为写进去了。
 */
export function makeEvent(input = {}) {
  assertObjectShape(input, "makeEvent 入参");
  const draft = { ...input };
  validateEvent(draft, { stamped: false });
  return draft;
}
