/**
 * lib/audit/runs.js — 轮边界判据：一次 apply 在审计轨上是收尾了还是被截断。
 *
 * 为什么需要它：审计轨按层落账，每层一行结论加若干文件行，但没有任何一行说「这一轮
 * 到此结束」。于是「这一轮是收尾了还是被杀在半路」只能靠诊断轨的 apply.start / apply.end
 * 反推，而诊断轨会被轮转覆盖 —— 两份日志只剩一份时，判断就悬空了。更麻烦的是残缺
 * 形态与完整形态长得一样：三层都有结论、末行是 tool.apply-result 的一次收尾轮，
 * 与「写完 code 那一层就被杀掉」的那一轮，在只看层结论时无法区分。
 *
 * 判据是什么：**一轮收尾 = 存在一条显式结束标记**，与「最后一条是什么」无关。
 *
 * 这个标记是本包新加的（`detail.runEnd`，由落账方写在它这一轮最后一条审计行上）。
 * 为什么不再按位置判：位置判据锚在「记录的排列」上，而排列是会变的 —— 一轮末尾
 * 本来就有多种像收尾的形态，每加一个（`audit.recorded` 就是这么加进去的），
 * 「末行是层结论」这条就会把正常轮判成中断一次。标记把判据锚在**内容**上：
 * 有就是有，没有就是没有，行排在哪、后面还有几条，都不影响。
 *
 * 标记之外仍保留四条集合判据（它们判的是「记录自相矛盾」，不是轮边界）：
 *
 *   一、每个有文件行的层都必须有自己的结论 —— 缺一个就是在那层之前断了；
 *   二、结论里的 `detail.completeness.layers` 为真时，三层必须都有结论 ——
 *       那个布尔是落账方在**动手写之前**按整批补丁算出来的，所以「声称记全了、
 *       实际少一层」只可能是被截断，不是那一层本来没活干；
 *   三、层第一次出现的顺序必须是 prompt → code → tool 的子序列 —— 落账方就按这个
 *       顺序逐层写，倒序只可能是两轮的行被拼到了同一个 runId 上；
 *   四、结论的计数与文件行的补丁号个数必须相等。
 *
 * 没有标记的那一代**不判收尾**，记成「不可判」（`judgeable=false`）：那一代的日志本来
 * 就没有标记，拿新判据去判它会把它全判成中断，而真相是判据没依据。这一档按世代分两条：
 * `v2-entry` 及更早的完整轮记「判不了收尾，不是截断」；`v3` 缺章才是真截断。世代由
 * `./generation.js` 只读日志认出来 —— 判据锚在写入方的不变量上，不锚在「当前形态」上。
 * 旧规则（末行是不是层结论）只作为信息项写出来，不参与退出码。
 *
 * 这一档的代价写在明处：`v2-entry` 里「结论齐、但确实写到一半」的形态判不出来。当前写入方
 * 的章与最后一条结论是同一次写入，那一形态不是它产得出来的；真要判它，只能靠诊断轨的窗口。
 *
 * 剩下一条判不了的（如实记在文档里）：某一层本来就没有可落账的补丁、且那一轮正好在
 * 它之前被杀 —— 判据一看不见它，判据二的布尔也是假；有标记的那一代由标记兜住，
 * 没有标记的那一代只能靠诊断轨那一侧判。
 *
 * 另一件由本模块承担的事：与诊断轨对账（`apply.start` … `apply.end` 这一段窗口）。
 * 逐条比补丁号与状态 —— 两轨各自记了一遍同一批判定，能对上才算互证。
 *
 * 补丁号的**次序不比**：审计轨按「层分组 + 层内补丁号升序」写，诊断轨按补丁表次序写，
 * 两套排序规则本来就不同（表里 70、73 紧跟 1、2、3，审计侧却排在 prompt 组末尾）。
 * 拿次序当判据会让每一轮都判成「对不上」，而那不是日志写错，是判据没有依据。
 * 次序差异照旧算出来，但只作信息项（`orderNotes`），不参与 `ok`。
 */
import { LAYER_ORDER, layerOf } from "./layers.js";
import { tableDeclarationOf, verifyRecordedAccounting } from "./accounting.js";
import {
  DIAG_END_EVENTS,
  GENERATION_V2_ENTRY,
  GENERATION_V3,
  auditGeneration,
  diagGeneration,
  hasRunEnd,
} from "./generation.js";

const CONCLUSION_SUFFIX = ".apply-result";
const FILE_SUFFIXES = [".patch-applied", ".patch-miss", ".patch-skipped"];

/**
 * 结束标记的字段名。这一个字符串就是「什么叫收尾」的全部判据 —— 改它等于改判据。
 *
 * 它写在层结论的 `detail` 上：`detail.runEnd === true`。落账方只在这一轮**最后一条**
 * 审计行上盖一次章（见 `./report.js` 的 `recordApply`），读的人按「有没有这个键」判，
 * 不按「它排在第几条」判。加多少个像收尾的事件，都不影响这个答案。
 */
const RUN_END_FIELD = "runEnd";


/**
 * 五个入口不写审计轨：它们各自在宿主内部重打（拿不到「一次用户 apply」的边界），
 * 或属二级路径。诊断轨里有它们、审计轨里没有，是设计边界，不是缺记录。
 *
 * 这份清单是唯一权威：`lib/audit/remedy.js` 的症候卡与本模块的反向对账都读它，
 * 两处各抄一份的话，某天只改一处就会让「设计边界」和「缺记录」互相冒充。
 */
export const AUDIT_EXEMPT_ENTRIES = Object.freeze([
  "startup-auto", "reapply", "reapply-cli", "http-restart",
]);

/** 写审计轨的四个入口：反向对账只对这四个判「该写却没写」。 */
const AUDIT_WRITING_ENTRIES = Object.freeze(["http", "command", "tool", "cli"]);


function isConclusion(event) {
  return typeof event === "string" && event.endsWith(CONCLUSION_SUFFIX);
}

function isFileRow(event) {
  return typeof event === "string" && FILE_SUFFIXES.some((suffix) => event.endsWith(suffix));
}

function runIdOf(event) {
  const value = event && event.runId;
  return typeof value === "string" ? value.trim() : "";
}

function seqOf(event) {
  return event && Number.isInteger(event.seq) ? event.seq : null;
}

/**
 * 本地日期段（YYYY-MM-DD）。
 *
 * 为什么要单独一个换算：诊断轨的 `ts` 是 UTC（`…Z`），审计轨的文件名与 `ts` 都是本地日期。
 * 直接比字符串会把「本地 10-25 08:00」读成 10-25 而 UTC 那边是 10-25T00:00 —— 差 8 小时
 * 的那些轮次就会判错日期。先解析成时刻、再按本地时区取日期，两边才是同一把尺。
 */
function localDayOf(ts) {
  const at = Date.parse(String(ts ?? ""));
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 补丁号统一成字符串比较：审计侧是数字、诊断侧是字符串，形状不同不算分歧。 */
function patchKeyOf(row) {
  const raw = row && row.detail ? row.detail.patchId : null;
  if (raw === null || raw === undefined || raw === "") return "";
  return String(raw);
}

/**
 * 一层的落账实况：文件行数、出现过哪些补丁号、哪几行的摘要不全。
 * 这三样都是「复算 completeness」要的分母，从日志本身能数出来。
 */
function emptyBucket() {
  return { rows: 0, ids: new Set(), digestGaps: [] };
}

/**
 * 按审计行自己的 `detail` 重算 completeness 三项，与声称值比对。
 *
 * 为什么必须能复算：三个布尔原先由落账方在动手写之前自己算，而唯一的机械复核
 * （`audit check --diag`）是单向的 —— 审计行说「记全了」，没有任何东西能反驳它。
 * 真机就出现过「66 条补丁只覆盖 62 条、缺的三条既不在 unresolved 也不在 exempt，
 * 而 completeness.patches 仍是 true」，当时所有判据都是绿的。
 *
 * 分母写进了层结论自己的 detail：`considered` 是折进来的补丁号、`expectedRows` 是
 * 它们声明的落点总数。所以「少一条」现在是对着自己声明过的清单数出来的，不是猜的。
 *
 * 老口径的行（无 considered / expectedRows）只记一条信息项，不算问题：那几个字段是
 * 后来才写的，旧日志缺它们不是错——但它们也真的无法复算，读的人必须知道这一点。
 *
 * @param {{conclusions:Map<string,object>, buckets:Map<string,object>, concluded:Set<string>}} view
 * @returns {{problems:Array<string>, notes:Array<string>}}
 */
function verifyCompleteness({ conclusions, buckets, concluded }) {
  const problems = [];
  const notes = [];
  for (const [layer, conclusion] of conclusions) {
    const detail = conclusion.detail;
    const claimed = detail.completeness;
    if (!claimed || typeof claimed !== "object") continue;
    const bucket = buckets.get(layer) || emptyBucket();
    const unresolved = Array.isArray(detail.unresolved) ? detail.unresolved.map(String) : [];
    const considered = Array.isArray(detail.considered) ? detail.considered.map(String) : null;
    const expectedRows = Number.isInteger(detail.expectedRows) ? detail.expectedRows : null;
    // 新口径 = 分母已写进这一行。旧日志没有 considered / expectedRows（连 before/after
    // 摘要都是后加的），拿它们当必要条件会把历史日志判红 —— 判据没依据时报红等于报假。
    const newFormat = considered !== null && expectedRows !== null;
    if (!newFormat) {
      notes.push(
        `${layer}.apply-result 是老口径（detail.considered / expectedRows 缺席）：completeness 三项无法复算`,
      );
    }

    // 一、patches：没有缺口（unresolved 空），且声称折进来的每个补丁号都真的有下落 ——
    // 有文件行，或明确列在 unresolved 里。两者都没有就是「少了一条」，点名是哪个号。
    const wantPatches = unresolved.length === 0;
    if (claimed.patches === true && !wantPatches) {
      problems.push(
        `${layer}.apply-result 的 completeness.patches 声称记全了，但 detail.unresolved 里有 ${unresolved.join(",")}：`
        + "有缺口的层不许记 patches=true",
      );
    } else if (claimed.patches === false && wantPatches) {
      problems.push(`${layer}.apply-result 的 completeness.patches 记成假，但 detail.unresolved 是空的`);
    }
    if (considered !== null) {
      const missing = considered.filter((id) => !bucket.ids.has(id) && !unresolved.includes(id));
      if (missing.length > 0) {
        problems.push(
          `${layer}.apply-result 的 detail.considered 列了补丁 ${missing.join(",")}，`
          + "但这一轮既没有它们的文件行、也不在 unresolved 里：这几条记录缺了",
        );
      }
    }

    // 二、files：落点行数与声称的 expectedRows 相等，且每一行的 before / after 摘要都在。
    // 这一条只在分母写进日志之后才判 —— 摘要字段本身也是后来才加的。
    if (newFormat) {
      const wantFiles = bucket.digestGaps.length === 0 && bucket.rows === expectedRows;
      if (claimed.files === true && !wantFiles) {
        const why = [];
        if (bucket.digestGaps.length > 0) why.push(`摘要缺在补丁 ${bucket.digestGaps.join(",")} 的行上`);
        if (bucket.rows !== expectedRows) why.push(`文件行 ${bucket.rows} 条 ≠ 声称 ${expectedRows} 条`);
        problems.push(`${layer}.apply-result 的 completeness.files 声称记全了，但${why.join("；")}`);
      } else if (claimed.files === false && wantFiles) {
        problems.push(`${layer}.apply-result 的 completeness.files 记成假，但落点行数与摘要都齐`);
      }
    }

    // 三、layers：声称三层都记全 ⇒ 三层都必须有结论；新口径再要求各层的 considered 非空。
    // 这张布尔是**整批**属性，所以「真」要求三层齐，「假」要求确实缺一层。
    // `considered` 只在全部三层都是新口径时才参与判：旧日志缺这个字段不是错，
    // 拿它当必要条件会把历史日志判红 —— 那正是「判据没依据时报红等于报假」。
    const newFormatAll = LAYER_ORDER.every((name) => Array.isArray(conclusions.get(name)?.detail?.considered));
    const consideredEmpty = newFormatAll
      ? LAYER_ORDER.filter((name) => (conclusions.get(name)?.detail?.considered || []).length === 0)
      : [];
    const missingConclusion = LAYER_ORDER.filter((name) => !concluded.has(name));
    if (claimed.layers === true && missingConclusion.length > 0) {
      problems.push(
        `${layer}.apply-result 的 completeness.layers 声称三层都记全了，但 ${missingConclusion.join("/")} 没有结论`,
      );
    } else if (claimed.layers === true && consideredEmpty.length > 0) {
      problems.push(
        `${layer}.apply-result 的 completeness.layers 声称三层都记全了，但 ${consideredEmpty.join("/")} 的 detail.considered 是空的`,
      );
    } else if (claimed.layers === false && missingConclusion.length === 0 && consideredEmpty.length === 0
      && newFormatAll) {
      problems.push(`${layer}.apply-result 的 completeness.layers 记成假，但三层都有结论且 considered 非空`);
    }

    // 四、partial 的来路必须与数据一致：有假项 ⇒ record，三项全真 ⇒ layer。
    if (conclusion.result === "partial") {
      const wantReason = Object.values(claimed).includes(false) ? "record" : "layer";
      const stated = detail.partialReason;
      if (stated === undefined) {
        notes.push(`${layer}.apply-result 是老口径（detail.partialReason 缺席）：这一条 partial 的来路判不出来`);
      } else if (stated !== wantReason) {
        problems.push(
          `${layer}.apply-result 的 detail.partialReason=${stated}，但按 completeness 复算应是 ${wantReason}：`
          + (wantReason === "record" ? "有假项说明是记录缺口" : "三项全真说明是层内部分成功"),
        );
      }
    }
  }
  return { problems, notes };
}

/**
 * 按**补丁表**复算这一轮该落账的补丁，与日志里真出现的补丁做集合差。
 *
 * 判据三条，前两条是「声明本身是否诚实」，第三条才是缺口：
 *   一、`unmapped` 只许是补丁表里**真的没有层**的那些 id —— 否则有层的补丁被塞进这一栏，
 *       就等同于从分母里悄悄删掉一条；
 *   二、`exempt` 只许是补丁表里真的标了 `auditExempt` 的那些 id；
 *   三、`expected ∖ (文件行 ∪ unresolved ∪ exempt ∪ unmapped)` 必须为空。
 *
 * `expected` 的来源分两种：有 `detail.table.selected` 时只取 `selected` 里去掉 `exempt` /
 * `unmapped` 的那些（apply 带过滤时，没选中的补丁本来就不该有账）；没有 `selected` 的
 * 过渡日志才退回补丁表全量，并由记账自证那条判据留「无 selected，按全表判」信息项。
 *
 * @param {object} input
 * @param {Map<string,object>} input.conclusions 层名 → `{detail}`
 * @param {object} [input.table] 补丁表（`ALL_PATCHES`）；不给就跳过这一档
 * @param {Array<string>} input.patchIds 这一轮文件行里出现过的补丁号
 * @param {Array<string>} input.unresolved 各层 `detail.unresolved` 的并集
 * @param {Array<string>} input.exempt 各层 `detail.exempt` 的并集
 * @returns {{problems:Array<string>, notes:Array<string>, gap:Array<string>, judged:boolean}}
 */
function verifyAgainstTable({ conclusions, table, patchIds, unresolved, exempt }) {
  const problems = [];
  const notes = [];
  const list = Array.isArray(table) ? table.filter((patch) => patch && patch.id !== undefined) : [];
  if (list.length === 0 || conclusions.size === 0) {
    return { problems, notes, gap: [], judged: false };
  }
  const tableExempt = new Set(
    list.filter((patch) => patch.auditExempt === true).map((patch) => String(patch.id)),
  );
  const unmappable = new Set(
    list
      .filter((patch) => patch.auditExempt !== true && !LAYER_ORDER.includes(layerOf(patch)))
      .map((patch) => String(patch.id)),
  );
  // 声明写在盖章那条结论上；没有盖章的老日志就从任一条结论里找，找不到就是没声明。
  const declared = tableDeclarationOf(conclusions);
  const declaredUnmapped = declared && Array.isArray(declared.unmapped)
    ? declared.unmapped.map(String)
    : [];
  const declaredExempt = declared && Array.isArray(declared.exempt)
    ? declared.exempt.map(String)
    : [];
  // 过滤 apply 的分母：这一轮真选中的补丁号写在 detail.table.selected 上。没有它的过渡
  // 日志才拿补丁表全量当分母 —— 否则「没选中」会被读成「丢了」。
  const declaredSelected = declared && Array.isArray(declared.selected)
    ? [...new Set(declared.selected.map(String))]
    : null;
  const expected = declaredSelected === null
    ? list.filter((patch) => patch.auditExempt !== true).map((patch) => String(patch.id))
    : declaredSelected.filter((id) => !tableExempt.has(id) && !unmappable.has(id));
  // 表的身份先对一遍：日志是按**写那一刻**那张补丁表落的账，本机今天这张可能已经不同
  // （插件升级、宿主换代）。两张表不是同一张时，分母不适用 —— 拿今天的表判昨天的账，
  // 每加一条补丁就会把历史轮全判成缺口，那是假红。
  if (declared !== null && (!Number.isInteger(declared.total) || declared.total !== list.length)) {
    notes.push(
      `这一轮是按另一张补丁表落的账（声明 total=${JSON.stringify(declared.total)}，`
      + `本机补丁表 ${list.length} 条）：分母不适用，这一档不可判，不是缺口`,
    );
    return { problems, notes, gap: [], judged: false };
  }
  if (declared !== null) {
    const badUnmapped = declaredUnmapped.filter((id) => !unmappable.has(id));
    if (badUnmapped.length > 0) {
      problems.push(
        `detail.table.unmapped 列了补丁 ${badUnmapped.join(",")}，但补丁表里这几条**有层**：`
        + "把有层的补丁记成无层，等于从分母里悄悄删掉它",
      );
    }
    const badExempt = declaredExempt.filter((id) => !tableExempt.has(id));
    if (badExempt.length > 0) {
      problems.push(
        `detail.table.exempt 列了补丁 ${badExempt.join(",")}，但补丁表里这几条没有标 auditExempt`,
      );
    }
  }
  const present = new Set([
    ...patchIds.map(String),
    ...unresolved.map(String),
    ...exempt.map(String),
    ...declaredUnmapped,
  ]);
  const gap = expected.filter((id) => !present.has(id));
  if (gap.length === 0) return { problems, notes, gap, judged: declared !== null };
  // 点名有上限：缺口可能是几十条，全打出来会把同一条输出里的别的判据挤掉。
  const named = gap.slice(0, 8).join(",");
  const origin = declaredSelected === null ? "补丁表里有" : "detail.table.selected 里有";
  const line = `${named}${gap.length > 8 ? ` …（共 ${gap.length} 条）` : ""}：${origin}、这一轮既没有文件行`
    + "也没有 unresolved，也没有在 detail.table.unmapped 里交代";
  if (declared === null) {
    notes.push(`老口径（没有 detail.table）：按补丁表复算，${line} —— 旧规则不判红，但缺口是真的`);
  } else {
    problems.push(line);
  }
  return { problems, notes, gap, judged: declared !== null };
}

/** 补丁号并集：各层结论里的 `unresolved` 与 `exempt` 摊平去重。 */
function layerIdUnion(conclusions, key) {
  const out = new Set();
  for (const conclusion of conclusions.values()) {
    const value = conclusion && conclusion.detail ? conclusion.detail[key] : null;
    if (!Array.isArray(value)) continue;
    for (const id of value) out.add(String(id));
  }
  return [...out];
}

/**
 * 把一次 apply 的审计行折成一条轮边界结论。
 *
 * @param {Array<object>} events 同一次尝试的全部行，按文件内行序传入
 * @param {Array<object>} [table] 补丁表；给了就按它复算分母（见 verifyAgainstTable）
 * @returns {{runId:string, rows:number, firstSeq:number|null, lastSeq:number|null,
 *   layers:Array<string>, concluded:Array<string>, lastEvent:string,
 *   patchIds:Array<string>, generation:string, sealed:boolean, judgeable:boolean, closed:boolean,
 *   reasons:Array<string>, notes:Array<string>, gap:Array<string>, lagMs:number|null}}
 */
function summarizeRun(runId, events, table) {
  const fileLayers = new Set();
  const concluded = new Set();
  const layersSeen = [];
  const patchIds = [];
  const statuses = {};
  const tally = { applied: 0, failed: 0, skipped: 0 };
  const conclusions = new Map();
  const buckets = new Map();
  let claimsAllLayers = false;
  let sealed = false;
  let lastSeq = null;
  let lagMs = null;
  let firstTs = null;

  const bucketOf = (layer) => {
    if (!buckets.has(layer)) buckets.set(layer, emptyBucket());
    return buckets.get(layer);
  };

  for (const row of events) {
    const layer = typeof row.layer === "string" ? row.layer : "";
    if (layer && !layersSeen.includes(layer)) layersSeen.push(layer);
    const seq = seqOf(row);
    if (seq !== null) lastSeq = seq;
    // 积压 = 落盘时刻 − 观测时刻。读的人据此知道「这份账滞后多久」，
    // 而不是把「写晚了几秒」当成「这一轮晚了」。
    const written = Date.parse(String(row.ts ?? ""));
    const observed = Date.parse(String(row.observedTs ?? ""));
    if (Number.isFinite(written) && (firstTs === null || written < firstTs)) firstTs = written;
    if (Number.isFinite(written) && Number.isFinite(observed)) {
      const lag = written - observed;
      if (lag >= 0 && (lagMs === null || lag > lagMs)) lagMs = lag;
    }
    if (isFileRow(row.event)) {
      const key = patchKeyOf(row);
      if (layer) {
        fileLayers.add(layer);
        const bucket = bucketOf(layer);
        bucket.rows += 1;
        if (key) bucket.ids.add(key);
        const evidence = row.evidence && typeof row.evidence === "object" ? row.evidence : null;
        // 与落账方同一条判据：before 缺席 / 为 null、after 为 null，都算那一侧读不到，
        // 也就是「摘要不全」。只有两半都在，files 才可能为真。
        const beforeOk = evidence !== null
          && Object.prototype.hasOwnProperty.call(evidence, "before")
          && evidence.before !== null;
        const afterOk = evidence !== null && evidence.after !== null && evidence.after !== undefined;
        if (!beforeOk || !afterOk) bucket.digestGaps.push(key || `seq=${seq ?? "?"}`);
      }
      if (key && !patchIds.includes(key)) patchIds.push(key);
      if (key && statuses[key] === undefined) {
        statuses[key] = String((row.detail && row.detail.status) || "");
      }
    } else if (isConclusion(row.event)) {
      if (layer) concluded.add(layer);
      const detail = row.detail && typeof row.detail === "object" ? row.detail : {};
      if (layer) conclusions.set(layer, { seq, result: String(row.result ?? ""), detail });
      // 结束标记：内容判据，不看这一行排在第几。盖过章就是收尾，没盖过就不是。
      if (detail[RUN_END_FIELD] === true) sealed = true;
      for (const key of Object.keys(tally)) {
        if (Number.isInteger(detail[key])) tally[key] += detail[key];
      }
      const completeness = detail.completeness;
      if (completeness && typeof completeness === "object" && completeness.layers === true) {
        claimsAllLayers = true;
      }
    }
  }

  // 「每个有文件行的层，其结论里的计数」逐个核：层结论的 applied+failed+skipped 必须
  // 等于那一层出现过的不同补丁号个数 —— 一条补丁落在多个文件上时文件行多于补丁数，
  // 拿行数去比会永远差，所以分母是补丁号。
  const perLayerPatches = new Map();
  for (const row of events) {
    if (!isFileRow(row.event)) continue;
    const layer = typeof row.layer === "string" ? row.layer : "";
    const key = patchKeyOf(row);
    if (!layer || !key) continue;
    if (!perLayerPatches.has(layer)) perLayerPatches.set(layer, new Set());
    perLayerPatches.get(layer).add(key);
  }
  let tallyRows = 0;
  for (const set of perLayerPatches.values()) tallyRows += set.size;

  const last = events[events.length - 1] || {};
  const reasons = [];
  const notes = [];
  // 收尾判据只有一条：**有没有结束标记**。位置不参与 —— 末行是什么、后面还跟了几条，
  // 都不改变「这一轮盖过章没有」。没有标记的那一代按世代分两条：`v3` 缺章才是真截断；
  // v2-entry 及更早的轮判不了收尾，记成不可判（判据没依据时报红等于报假）。
  const generation = auditGeneration(events);
  if (!sealed && generation === GENERATION_V3) {
    reasons.push(
      "缺结束标记：这一轮的层结论上没有 detail.runEnd —— 落账没走到盖章那一步（写到一半被杀，"
      + "或写盘失败），不能算收尾",
    );
  } else if (!sealed) {
    notes.push(
      "v2-entry 世代无结束标记：判不了收尾（不是截断）—— 那一代的写侧还没有盖章这一步，"
      + "拿新判据判它会把它全判成中断",
    );
  }
  for (const layer of fileLayers) {
    if (!concluded.has(layer)) reasons.push(`${layer} 有文件层事件，却没有这一层的结论`);
  }
  if (claimsAllLayers) {
    for (const layer of LAYER_ORDER) {
      if (!fileLayers.has(layer)) {
        reasons.push(`层结论声称三层都记全了（detail.completeness.layers 为真），但 ${layer} 一条文件层事件都没有`);
      } else if (!concluded.has(layer)) {
        reasons.push(`层结论声称三层都记全了，但 ${layer} 没有结论`);
      }
    }
  }
  const order = layersSeen.filter((layer) => LAYER_ORDER.includes(layer));
  const expected = LAYER_ORDER.filter((layer) => order.includes(layer));
  if (order.join(",") !== expected.join(",")) {
    reasons.push(`层第一次出现的顺序是 ${order.join(" → ")}，与落账顺序 ${expected.join(" → ")} 不一致`);
  }
  const totals = tally.applied + tally.failed + tally.skipped;
  if (totals > 0 && totals !== tallyRows) {
    reasons.push(`层结论的计数合计 ${totals}（applied+failed+skipped）与文件行里的补丁号个数 ${tallyRows} 对不上`);
  }
  // 记录缺口比轮边界更根本：一轮「收尾了」但层结论谎称记全了，同样是不可信的记录。
  const completeness = verifyCompleteness({ conclusions, buckets, concluded });
  for (const problem of completeness.problems) reasons.push(problem);
  notes.push(...completeness.notes);
  // 分母来自补丁表：这一条看得见「落账方自己没算进去的那几条」，而 considered 看不见。
  const against = verifyAgainstTable({
    conclusions,
    table,
    patchIds,
    unresolved: layerIdUnion(conclusions, "unresolved"),
    exempt: layerIdUnion(conclusions, "exempt"),
  });
  for (const problem of against.problems) reasons.push(problem);
  notes.push(...against.notes);
  // 汇总数自证：recorded 不指向任何一行，只能拿「文件行里不同补丁号」去对。
  const recorded = verifyRecordedAccounting({
    conclusions,
    patchIds,
    unresolved: layerIdUnion(conclusions, "unresolved"),
  });
  for (const problem of recorded.problems) reasons.push(problem);
  notes.push(...recorded.notes);
  // 判得了 / 判不了的最终口径：有章、或这一代本来有章、或别的集合判据已经报出了问题
  // ——第三种里「问题」本身就是结论，不能因为没章就降级成不可判。
  const judgeable = sealed || generation === GENERATION_V3 || reasons.length > 0;

  return {
    runId,
    rows: events.length,
    firstSeq: seqOf(events[0] || {}),
    lastSeq,
    layers: order,
    concluded: LAYER_ORDER.filter((layer) => concluded.has(layer)),
    lastEvent: String(last.event || ""),
    patchIds,
    statuses,
    tally: totals,
    lagMs,
    firstTs,
    generation,
    sealed,
    judgeable,
    closed: judgeable && reasons.length === 0,
    reasons,
    notes,
    gap: against.gap,
  };
}

/**
 * 全部轮边界：按文件内出现顺序给出每一轮的结论，另附一行汇总。
 *
 * @param {Array<object>} events 审计行，按文件内行序
 * @param {{patches?:Array<object>}} [options] `patches` = 补丁表（分母的来源）
 * @returns {{total:number, runless:number, closed:number, truncated:number,
 *   unjudgeable:number, runs:Array<object>, problems:Array<string>, notes:Array<string>}}
 */
export function summarizeRuns(events, options = {}) {
  const table = options && Array.isArray(options.patches) ? options.patches : null;
  const list = (Array.isArray(events) ? events : []).filter((event) => event && typeof event === "object");
  const groups = new Map();
  let runless = 0;
  for (const event of list) {
    const runId = runIdOf(event);
    if (!runId) {
      runless += 1;
      continue;
    }
    if (!groups.has(runId)) groups.set(runId, []);
    groups.get(runId).push(event);
  }
  const runs = [];
  const problems = [];
  const notes = [];
  for (const [runId, rows] of groups) {
    const run = summarizeRun(runId, rows, table);
    runs.push(run);
    for (const reason of run.reasons) problems.push(`${runId}：${reason}`);
    for (const note of run.notes) notes.push(`${runId}：${note}`);
  }
  const closed = runs.filter((run) => run.closed).length;
  const unjudgeable = runs.filter((run) => run.judgeable === false).length;
  return {
    total: runs.length,
    runless,
    closed,
    // 截断只数「判得了、且没盖章」的：老口径没有标记，判不了不是截断。
    truncated: runs.filter((run) => run.judgeable !== false && !run.closed).length,
    unjudgeable,
    runs,
    problems,
    notes,
  };
}

/**
 * 诊断轨里一次 apply 的窗口：起始、结束、这一代有没有结束标记，与逐补丁判定。
 *
 * `sealed` 只问一件事：结束事件上有没有 `runEnd`。它决定反向对账能不能判「当时该写审计」——
 * 老一代的诊断行有 `apply.end` 却没有这个字段，拿「事件在不在」当判据，会把整段旧世代
 * 都判成「该写审计却没写」，而真相是那一代根本没有这个约定。
 */
function diagWindow(events) {
  const rows = (Array.isArray(events) ? events : []).filter((event) => event && typeof event === "object");
  const start = rows.find((row) => row.event === "apply.start") || null;
  const ends = rows.filter((row) => DIAG_END_EVENTS.includes(row.event));
  const patches = rows.filter((row) => row.event === "apply.patch");
  const order = [];
  const statusById = new Map();
  for (const row of patches) {
    const id = row.id === undefined || row.id === null ? "" : String(row.id);
    if (!id) continue;
    if (!order.includes(id)) order.push(id);
    if (!statusById.has(id)) statusById.set(id, String(row.status || ""));
  }
  return {
    start,
    ends,
    sealed: ends.some((row) => hasRunEnd(row)),
    generation: diagGeneration(rows),
    patches,
    order,
    statusById,
  };
}

/**
 * 审计轨与诊断轨对账：**两个方向都查**，同一批判定在两份日志里各记了一遍，能对上才算互证。
 *
 * 比三件事，每件都能指出具体是哪一条对不上：
 *   一、窗口：诊断轨必须有 apply.start，且必须有一条结束事件（apply.end / apply.gate.reject）；
 *   二、逐条：审计侧每个文件行带的补丁号与状态，诊断侧都要有同号同状态的那一条；
 *   三、反向：诊断侧有一轮**完整的** apply（有 apply.start、结束事件上有 `runEnd`、
 *       entry 属于写审计的四个入口），审计轨却一行都没有 —— 那是「审计漏了这一轮」，
 *       必须红，而且要说出是哪个入口。
 *
 * 为什么反向也要判：真机上有两个完整的 CLI apply 在审计轨 0 行，而所有判据都是绿的 ——
 * 单向对账只能证明「我记了的确实发生过」，证明不了「发生过的我都记了」。
 *
 * 四条不该判红的边界，各自单列：
 *   · 轮次早于诊断轨现存的任何一行 ⇒ 诊断轨已被轮转覆盖（只留一代），这一轮不可判，
 *     记进 `staleNotes`。真机上 `--dir --diag` 因此在健康机器上也 exit 1，那就是假红：
 *     读者会把「诊断轨滚过」读成「日志坏了」。
 *   · 反向命中但 entry 属于不写审计的五个入口 ⇒ 记进 `orderNotes` 之外的信息项，不是缺口。
 *   · 诊断轨结束事件上没有 `runEnd`（上一代）⇒ 记「上一代（无 runEnd）：无法判定当时是否该写审计」；
 *     一条 `apply.patch` 都没有（aborted / 0 补丁，`apply.end.total` 为 0 或空）⇒ 没有可落账的判定，
 *     审计 0 行不是缺记录。两条都不进 `missingAudit`。
 *
 * 审计轨缺章、诊断轨有章的轮（`v2-entry` 审计 + v3 诊断同轮）在 `staleNotes` 里写
 * 「以诊断轨为准，这一轮算收尾」，但 `run.closed` 仍是审计轨自己的字段（false）——
 * 跨轨结论只作信息项，不冒充审计轨的收尾；两边都没章就只说「判不了收尾」。
 *
 * 补丁号的次序只作信息项记进 `orderNotes`：两轨的排序规则不同，次序差异不构成分歧
 * （判据缺依据时，报红等于报假）。
 *
 * @param {Array<object>} runs summarizeRuns 的 runs（可能已被 `--run` 筛过）
 * @param {Array<object>} diagEvents 诊断轨行
 * @param {{coveredRunIds?:Set<string>, coveredDates?:Set<string>, onlyRun?:string}} [options]
 *   反向判据的三个口径：`coveredRunIds` 是**未筛选**的审计轨里出现过的全部 runId ——
 *   拿筛过的那份去判，会把「本来就有的别的轮」报成缺的；`coveredDates` 是**这次实际给了
 *   哪几天的审计文件** —— 只判 10-24 却拿着一份跨到 10-25 的诊断轨，会把 10-25 的轮次
 *   全报成「审计缺」，而真相是那一天的文件根本没给；`onlyRun` 让单轮模式只就那一轮说方向。
 * @returns {{checked:number, matched:number, unmatched:number, missingAudit:number,
 *   problems:Array<string>, orderNotes:Array<string>, staleNotes:Array<string>}}
 */
export function crossCheckRuns(runs, diagEvents, options = {}) {
  const groups = new Map();
  const diagRows = Array.isArray(diagEvents) ? diagEvents : [];
  for (const event of diagRows) {
    const runId = runIdOf(event);
    if (!runId) continue;
    if (!groups.has(runId)) groups.set(runId, []);
    groups.get(runId).push(event);
  }
  // 诊断轨现存的起点：比它更早的轮次「不可判」，不是「对不上」。
  let diagFloor = null;
  for (const row of diagRows) {
    const at = Date.parse(String(row && row.ts !== undefined ? row.ts : ""));
    if (Number.isFinite(at) && (diagFloor === null || at < diagFloor)) diagFloor = at;
  }
  const problems = [];
  // 次序差异是「读的人可以知道、但不该据此判红」的一条：与 problems 分开收，
  // 免得下游把信息项当成判据（`audit check` 的退出码只看 problems 与 unmatched）。
  const orderNotes = [];
  // 诊断轨滚过导致「这一轮不可判」的也单列：它是保留期差异，不是日志残缺。
  const staleNotes = [];
  let matched = 0;
  let missingAudit = 0;
  // 早于诊断轨现存第一行的轮次：不可判，既不算对上也不算对不上。
  let stale = 0;
  const list = Array.isArray(runs) ? runs : [];
  for (const run of list) {
    const rows = groups.get(run.runId) || [];
    if (rows.length === 0) {
      const runFirst = Number.isInteger(run.firstTs) ? run.firstTs : null;
      if (runFirst !== null && diagFloor !== null && runFirst < diagFloor) {
        stale += 1;
        staleNotes.push(`${run.runId}：这一轮早于诊断轨现存的第一行（诊断轨只留一代，已被轮转覆盖），这一轮在诊断轨侧不可判 —— 不是日志残缺`);
        continue;
      }
      problems.push(`${run.runId}：诊断轨里没有这个 runId（滚过、搬过，或这一轮不是从写诊断轨的入口发起的）`);
      continue;
    }
    const window = diagWindow(rows);
    if (!window.start) problems.push(`${run.runId}：诊断轨缺 apply.start，这一段窗口的起点只能靠猜`);
    if (window.ends.length === 0) problems.push(`${run.runId}：诊断轨没有 apply.end / apply.gate.reject，这一轮在诊断轨里也没有收尾`);
    let ok = Boolean(window.start) && window.ends.length > 0;
    for (const [id, status] of Object.entries(run.statuses || {})) {
      if (!window.statusById.has(id)) {
        problems.push(`${run.runId}：审计侧有补丁 ${id}，诊断轨的 apply.patch 里没有它`);
        ok = false;
        continue;
      }
      const diagStatus = window.statusById.get(id);
      if (diagStatus !== status) {
        problems.push(`${run.runId}：补丁 ${id} 的状态两轨不一致（审计 ${status} / 诊断 ${diagStatus}）`);
        ok = false;
      }
    }
    // 集合口径：审计侧每个补丁号都要在诊断侧出现（反向不要求 —— 审计只记有落点的补丁，
    // 诊断轨记全部，审计是子集属于正常形态），且同号状态相同。
    const auditOrder = Array.isArray(run.patchIds) ? run.patchIds : [];
    const orderInDiag = auditOrder.filter((id) => window.order.includes(id));
    const sortedByDiag = window.order.filter((id) => orderInDiag.includes(id));
    if (orderInDiag.join(",") !== sortedByDiag.join(",")) {
      orderNotes.push(
        `${run.runId}：补丁号次序两轨不同（审计按层内补丁号升序，诊断按补丁表序），`
        + `这是排序规则差异不是分歧；以集合与状态为准`
        + `（审计侧 ${orderInDiag.join(" → ") || "（无）"}）`,
      );
    }
    if (!window.patches.length && run.rows > 0) {
      problems.push(`${run.runId}：诊断轨这一轮一条 apply.patch 都没有，审计侧却有 ${run.rows} 行`);
      ok = false;
    }
    // 跨轨的收尾判法：审计轨缺章时，诊断轨的 `runEnd` 是唯一能用的依据。它只落成这一条
    // `·` 信息项：`closed` 是审计轨自己的字段，不因诊断轨有章而改写 —— 文档里不许把
    // 「以诊断轨为准」读成 `closed=true`。两边都没章就只是判不了，不许冒充截断。
    if (run.sealed !== true) {
      staleNotes.push(
        window.sealed
          ? `${run.runId}：审计轨缺结束标记（${run.generation} 世代），诊断轨的结束事件上有 runEnd ——`
            + "看这一行：以诊断轨为准，这一轮算收尾；`closed` 仍是审计轨自己的字段（false），不是缺记录"
          : `${run.runId}：审计轨与诊断轨都没有 runEnd —— 这一轮判不了收尾（不是截断）`,
      );
    }
    if (ok) matched += 1;
  }

  // 反向：诊断侧有完整的 apply、审计侧 0 行。只对「本来就该写审计」的四个入口判红。
  const covered = options && options.coveredRunIds instanceof Set ? options.coveredRunIds : new Set(list.map((run) => run.runId));
  const onlyRun = options && typeof options.onlyRun === "string" ? options.onlyRun : "";
  const coveredDates = options && options.coveredDates instanceof Set && options.coveredDates.size > 0 ? options.coveredDates : null;
  for (const [runId, rows] of groups) {
    if (onlyRun !== "" && runId !== onlyRun) continue;
    if (covered.has(runId)) continue;
    const window = diagWindow(rows);
    if (!window.start) continue;
    const day = localDayOf(window.start.ts);
    if (coveredDates !== null && day !== "" && !coveredDates.has(day)) {
      staleNotes.push(
        `${runId}：这一轮的本地日期 ${day} 不在这次所判的审计文件里`
        + `（只给了 ${[...coveredDates].sort().join(", ")}）—— 不可判，不是审计缺`,
      );
      continue;
    }
    const entry = String(window.start.entry ?? "");
    if (AUDIT_EXEMPT_ENTRIES.includes(entry)) {
      orderNotes.push(`${runId}：诊断轨里有这一轮（entry=${entry}），这个入口不写审计轨 —— 设计边界，不是缺记录`);
      continue;
    }
    if (!AUDIT_WRITING_ENTRIES.includes(entry)) {
      orderNotes.push(
        `${runId}：诊断轨里有这一轮，但 apply.start 的 entry=${entry || "（缺失）"} 不是写审计的四个入口之一 ——`
        + "无法判定这一轮本该有审计行",
      );
      continue;
    }
    if (window.ends.length === 0) continue;
    // 世代门：结束事件上没有 `runEnd` 的那一代，还没有「一轮结束要落审计」这个约定
    // （CLI 落审计比第一个章早了几个小时），判它「审计缺」是把新约定套在旧行上 —— 假红。
    if (!window.sealed) {
      staleNotes.push(`${runId}：上一代（无 runEnd）：无法判定当时是否该写审计 —— 不判红`);
      continue;
    }
    // 没有逐补丁判定（aborted / 0 补丁）：`apply.patch` 一条都没有，`apply.end.total` 为 0 或空
    // （门禁拒绝、一台宿主都没找到都是这种形态）。报告为空就不写审计 —— 落账方按报告早退，
    // 也就是说「审计 0 行」在这里是设计边界，不是这一轮丢了账。
    if (window.patches.length === 0) {
      const total = String(window.ends[window.ends.length - 1]?.total ?? "").trim();
      orderNotes.push(`${runId}：没有逐补丁判定（apply.patch 0 条、apply.end.total=${total || "（空）"}）—— 没有可落账的判定，审计 0 行不是缺记录`);
      continue;
    }
    missingAudit += 1;
    problems.push(
      `${runId}：诊断轨里有一轮完整的 apply（entry=${entry}，apply.patch ${window.order.length} 条、有收尾），`
      + "审计轨却一行都没有 —— 方向是「诊断有、审计缺」",
    );
  }

  return {
    checked: list.length,
    matched,
    unmatched: list.length - matched - stale,
    missingAudit,
    stale,
    problems,
    orderNotes,
    staleNotes,
  };
}
