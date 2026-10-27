#!/usr/bin/env node
/**
 * scripts/check-audit-completeness.mjs — audit 装机完备性探针的可重复执行形态。
 *
 * 为什么存在：roadmap 的适应度函数里有一条装机探针判据——「正常 apply 后审计必须
 * 记全」。WP3 已在远程验证机上真机验证过四条断言（行数 = audit.rows、三层各有
 * apply-result、completeness 三项全真、exempt 按表列示），但那是一次性手工断言。
 * 本脚本把同一组判据固化成可重复执行的命令：远程部分（部署、apply、取回产物）留作
 * 半自动，断言部分在任何机器上都能跑——仓库里跑夹具，装机树上跑真产物。
 *
 * 为什么不 import lib：scripts-must-not-import-lib 规则禁脚本 import lib，豁免名单
 * 只对存量生效。本脚本要的是**数据**（补丁表的 auditExempt 标记），按规则注释给的
 * 合规路径「要数据就读文件」文本读表；格式对不上一律 exit 2 不猜——CI 每轮都跑，
 * 表改版式会当场红，不会静默量错。
 *
 * 判据（对选定 run 的事件逐条断言）：
 *   一、JSONL 每行可解析；v2 三字段（recordId / runId / observedTs）齐全，
 *       recordId 是 uuid 且互不相同；
 *   二、文件事件数（evidence 带 file 字段）== apply 响应的 audit.rows；
 *   三、补丁表出现的每个 audit 层都有且仅有一条 <layer>.apply-result；
 *   四、每条 apply-result 的 detail.completeness 三项全真；
 *   五、detail.exempt 与补丁表的 auditExempt 逐层一致（PATCH-9：豁免必须可见），
 *       且 exempt 补丁不落文件事件；
 *   六、每条 apply-result 的 result 必须等于它自己的计数与 completeness 折算出来的值，
 *       且 detail.partialReason 与折算结果一致（record = 记录缺口，layer = 层内部分成功）。
 *       没有这一条，夹具里「三行 result 全写 skip、计数却是 1/1 与 1/0」也能照绿 ——
 *       一个照绿的门禁比没有门禁更糟，因为它让人不去看。
 *   七、detail.table.recorded 必须等于文件行里的不同补丁号个数，且「差只能由 unresolved 解释」。
 *       有 detail.table.selected（过滤 apply）时分母是 selected 去掉 exempt / unmapped 的条数，
 *       点得出 selected 里缺的 id；没有 selected 的过渡日志才按 total − exempt − unmapped 判，
 *       并打印「无 selected，按全表判」。它是唯一一个不指向任何一行的汇总数，写错时没有第二处
 *       能对照 —— 所以拿定义直接对账。
 *
 * 用法：
 *   node scripts/check-audit-completeness.mjs                       无参 = 跑仓库夹具（见下），exit 0 即判据成立
 *   node scripts/check-audit-completeness.mjs --fixtures <dir>       换一套夹具（该目录下的 audit-f6.jsonl / audit-f6-response.json）
 *   node scripts/check-audit-completeness.mjs --jsonl <path> --response <path>
 *   node scripts/check-audit-completeness.mjs --jsonl <path> --rows <n> [--run <runId>]
 *   --jsonl    取回的审计日志（当日 JSONL，可含多个 run）
 *   --response apply 响应 JSON（POST /dsh-purge/apply 的响应体存盘）
 *   --rows     没有响应体时直接给 audit.rows（此时跳过 unresolved 断言）
 *   --run      选定哪个 run；缺省取文件最后一条事件所属的 run（append-only，时序上最新）
 * 退出码：0 全过 / 1 有断言不过 / 2 用法或环境错误（文件缺失、参数缺失、表解析失败）。
 *
 * 为什么要有无参模式：探针进了本地的验证链之后，每一步都在无人值守的环境里跑。
 * 要求调用方每次手写两个路径，等于把「记得带参数」变成判据的前提 —— 忘一次就是 exit 2，
 * 而 exit 2 与「判据不过」在 CI 里长得一样。所以默认值必须是**仓库内那套夹具**：
 * 无参就是判据本身，要换证据才显式给路径。
 * 夹具目录是单一覆盖点：给了 --fixtures 就用那套，否则用 test/fixtures。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_OK = 0;
const EXIT_HIT = 1;
const EXIT_TOOLING = 2;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(SCRIPT_DIR, "..");
/** 无参 / --fixtures 时的夹具目录；两个文件名固定，换成别的形状就不再是同一组判据。 */
const FIXTURE_DIR = join(ROOT_DIR, "test", "fixtures");
const FIXTURE_JSONL = "audit-f6.jsonl";
const FIXTURE_RESPONSE = "audit-f6-response.json";

const USAGE = [
  "用法：node scripts/check-audit-completeness.mjs [选项]",
  `  无参                     跑仓库夹具（${join("test", "fixtures", FIXTURE_JSONL)} + ${FIXTURE_RESPONSE}）`,
  "  --fixtures <dir>        换一套夹具：该目录下的 audit-f6.jsonl / audit-f6-response.json",
  "  --jsonl <path>          装机取回的审计日志（给了它就不再走夹具默认值）",
  "  --response <path>       apply 响应 JSON；不给时可改用 --rows",
  "  --rows <n>              直接给 audit.rows，跳过 unresolved 断言",
  "  --run <runId>           选定哪个 run，缺省取文件最后一条事件所属的 run",
  "  --table <path>          补丁表（缺省 lib/patch/table.js）：只为让「未映射层名」这道门禁",
  "                          能被用例真的点一次红灯——判据自己不测一遍，等于没写过",
  "退出码：0 全过 / 1 有断言不过 / 2 用法或环境错误。",
].join("\n");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESULT_SUFFIX = ".apply-result";

/**
 * 层结论的折算规则：**与 lib/audit/report.js 逐字同一条**。
 *
 * 为什么不 import 它：scripts-must-not-import-lib 规则禁脚本 import lib，而这里要的
 * 是一个能独立跑在装机树上的判据。所以照着实现抄一份，并用 `test/audit-completeness`
 * 的两条用例锁住「抄对了」：一条断言夹具的 result 与折算一致，一条改坏 result 必红。
 */
function foldResult(detail) {
  const tally = {
    applied: Number.isInteger(detail.applied) ? detail.applied : 0,
    failed: Number.isInteger(detail.failed) ? detail.failed : 0,
    skipped: Number.isInteger(detail.skipped) ? detail.skipped : 0,
  };
  const total = tally.applied + tally.failed + tally.skipped;
  const aggregate = total === 0
    ? "skip"
    : tally.failed > 0
      ? "fail"
      : tally.applied === total
        ? "ok"
        : tally.applied > 0
          ? "partial"
          : "skip";
  const completeness = detail.completeness;
  const complete = !completeness || typeof completeness !== "object"
    || (completeness.patches !== false && completeness.files !== false && completeness.layers !== false);
  if (complete) return aggregate;
  return aggregate === "fail" ? "fail" : "partial";
}

/** 补丁表里的中文层名 → 审计三层口径（与 lib/audit/report.js 的 auditRowsFromReport 同一映射）。 */
const LAYER_BY_CN = { "提示词": "prompt", "代码": "code", "工具": "tool" };
/* 非结论层（兼容层）：与 `lib/audit/layers.js` 的 NON_CONCLUSION_LAYERS 同源。
   脚本不许 import `lib/`，只能抄一份；`test/audit-completeness.test.mjs` 逐名比对两份。
   这一份存在之后，下面那道门禁就**没有**「数字开头就放过」的后门了 —— 未登记的层名
   （不管开头是什么字符）一律判红。 */
const NON_CONCLUSION_LAYERS = new Set(["0.1.5 兼容", "0.2.0 兼容"]);

const log = (msg) => process.stdout.write(`${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[check-audit-completeness] 无法完成检查：${msg}\n`);
  process.exit(EXIT_TOOLING);
};

/**
 * 判据不过：退出码 1。
 *
 * 与 `fail` 的分工见文件头的「退出码」那一行：`fail` 是**跑不起来**（读不到输入、用法错、
 * 缺字段），2 一律不算通过，但它说的是「这一档不可判」；而「补丁表里有未映射的层名」
 * 是对**仓库数据的判据**，是断言不过，必须是 1。两者混用之后，读的人会把一条真实的
 * 层口径缺口读成「工具没跑起来」。
 *
 * `readPatchTable` 在这个文件里跑得比 `failures` 数组早，所以它没法把结论并进那一轮
 * 汇总，只能就地退出 —— 这也正是这个函数存在的原因。
 */
const failHit = (msg) => {
  process.stderr.write(`[check-audit-completeness] 命中：${msg}\n`);
  process.exit(EXIT_HIT);
};

/**
 * 参数解析。两处与「无参即判据」有关：
 *   一、--fixtures 只是一次性替换夹具目录，最终仍折成 jsonl / response 两个真实路径 ——
 *      下游只有「读哪两份证据」一件事，不必知道证据从哪个开关来。
 *   二、夹具默认值是**兜底而非唯一**：显式给了 --jsonl 就不再碰夹具目录，
 *      装机树上跑真产物与被 CI 跑夹具走的是同一条断言体。
 */
function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    log(USAGE);
    process.exit(EXIT_OK);
  }
  const args = { jsonl: null, response: null, rows: null, run: null, fixtures: null, table: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--") || value === undefined) fail(`参数不完整：${key}（--help 看用法）`);
    const name = key.slice(2);
    if (!(name in args)) fail(`未知参数：${key}（--help 看用法）`);
    // 原始串先留住：Number("abc") 是 NaN，而 JSON.stringify(NaN) 打印成 null，
    // 报错就会说「收到 null」，把「给错了值」说成「没给值」。
    if (name === "rows" && !Number.isInteger(Number(value))) {
      fail(`--rows 必须是整数，收到 ${JSON.stringify(value)}`);
    }
    args[name] = name === "rows" ? Number(value) : value;
    i += 1;
  }
  if (args.rows !== null && !Number.isInteger(args.rows)) {
    fail(`--rows 必须是非负整数，收到 ${JSON.stringify(args.rows)}`);
  }
  if (!args.jsonl) {
    const dir = args.fixtures ? resolve(args.fixtures) : FIXTURE_DIR;
    args.jsonl = join(dir, FIXTURE_JSONL);
    if (!args.response) args.response = join(dir, FIXTURE_RESPONSE);
  }
  if (!args.response && !Number.isInteger(args.rows)) {
    fail("缺 --response <apply 响应 JSON> 或 --rows <audit.rows>：行数对账没有基准");
  }
  return args;
}

/** 逐行读 JSONL；坏行记为 FAIL 项而不是抛异常——判据要报「哪行坏了」。 */
function readEvents(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(`读不到 JSONL：${path}（${error.message}）`);
  }
  const events = [];
  const badLines = [];
  raw.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      events.push({ line: i + 1, event: JSON.parse(line) });
    } catch {
      badLines.push(i + 1);
    }
  });
  return { events, badLines };
}

/**
 * 文本读补丁表，取两样数据：各层的 auditExempt id 集合、表里出现过的 audit 层集合。
 *
 * 表是纯数据表，条目首行有两种格式：紧凑式（`id: N, name: "...", layer: "...", ...`
 * 全在一行）与展开式（`id: N,` 单独一行，`layer: "..."` 随后单独一行）。单遍扫描：
 * 记住当前条目，紧凑行直接定 id 与层，展开行等 layer 行补齐。auditExempt 标记在
 * 条目内部，归属到当前条目。层名以数字开头的是兼容类（0.1.5 / 0.2.0），不进三层
 * 口径；其余未映射的层名说明表新增了 audit 层，exit 2 逼着先补映射——不猜。
 */
function readPatchTable(tablePath) {
  let text;
  try {
    text = readFileSync(tablePath, "utf8");
  } catch (error) {
    fail(`读不到补丁表：${tablePath}（${error.message}）`);
  }
  const exemptByLayer = new Map();
  const layers = new Set();
  const noteLayer = (at, layerCn) => {
    const slug = LAYER_BY_CN[layerCn];
    if (slug) {
      layers.add(slug);
      return;
    }
    // 已声明的非结论层（兼容层）放行；其余未映射的层名一律判红。
    // 旧写法是 `if (!/^\d/.test(layerCn)) fail(...)`：凡数字开头就静默跳过 ——
    // 兼容层确实以数字开头，但「新加了一个没人映射的层」也常以数字开头（版本号习惯），
    // 于是这条门禁对最该拦的那一形态完全失效，而它声称守的正是这件事。
    if (NON_CONCLUSION_LAYERS.has(layerCn)) return;
    failHit(`补丁表第 ${at} 行出现未映射的层名「${layerCn}」：audit 层口径见 lib/audit/layers.js —— 要么在 LAYER_BY_NAME 里给它一个结论层，要么在 NON_CONCLUSION_LAYERS 里显式声明「不参与三档结论」`);
  };
  let current = null;
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    const at = i + 1;
    const compact = /^\s*id:\s*(\d+),\s*name:\s*"[^"]*",\s*layer:\s*"([^"]+)"/.exec(line);
    if (compact) {
      current = { id: Number(compact[1]), layerCn: compact[2] };
      noteLayer(at, compact[2]);
      return;
    }
    const idOnly = /^\s*id:\s*(\d+)\s*,?\s*$/.exec(line);
    if (idOnly) {
      current = { id: Number(idOnly[1]), layerCn: null };
      return;
    }
    const layerLine = /^\s*layer:\s*"([^"]+)"/.exec(line);
    if (layerLine) {
      if (current && current.layerCn === null) current.layerCn = layerLine[1];
      noteLayer(at, layerLine[1]);
      return;
    }
    if (!/^\s*auditExempt:\s*true\s*,?\s*$/.test(line)) return;
    if (!current || current.layerCn === null) {
      fail(`补丁表第 ${at} 行有 auditExempt 标记，但所属条目的 id 或 layer 还没读到（表格式变了？）`);
    }
    const slug = LAYER_BY_CN[current.layerCn];
    if (!slug) return;
    if (!exemptByLayer.has(slug)) exemptByLayer.set(slug, []);
    exemptByLayer.get(slug).push(current.id);
  });
  return { exemptByLayer, layers: [...layers] };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { events, badLines } = readEvents(args.jsonl);
  const table = readPatchTable(args.table ? resolve(args.table) : join(ROOT_DIR, "lib", "patch", "table.js"));

  let expectedRows = args.rows;
  let expectUnresolvedEmpty = false;
  if (args.response) {
    let response;
    try {
      response = JSON.parse(readFileSync(args.response, "utf8"));
    } catch (error) {
      fail(`读不到或解析不了 apply 响应：${args.response}（${error.message}）`);
    }
    const audit = response && response.audit;
    if (!audit || !Number.isInteger(audit.rows)) {
      fail("apply 响应里没有 audit.rows——响应体存全（POST /dsh-purge/apply 的完整 JSON）");
    }
    expectedRows = audit.rows;
    expectUnresolvedEmpty = true;
  }

  const failures = [];
  const check = (label, ok, detail = "") => {
    if (ok) {
      log(`PASS ${label}`);
      return;
    }
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  };

  check("JSONL 逐行可解析", badLines.length === 0, badLines.length ? `坏行：${badLines.join(",")}` : "");

  // 选定 run：缺省取最后一条事件所属的 run（append-only，时序上最新）
  const runId = args.run ?? (events.length > 0 ? events[events.length - 1].event.runId : null);
  if (!runId) {
    console.error("[check-audit-completeness] FAIL JSONL 里没有事件，无从选定 run");
    process.exit(EXIT_HIT);
  }
  const run = events.filter((e) => e.event && e.event.runId === runId).map((e) => e.event);
  log(`INFO 选定 run ${runId}：${run.length} / ${events.length} 条事件`);
  const exemptBrief = [...table.exemptByLayer]
    .map(([layer, ids]) => `${layer}=[${ids.join(",")}]`)
    .join(" ");
  log(`INFO 补丁表 exempt：${exemptBrief || "（空）"}；audit 层：${table.layers.join(", ")}`);

  // 判据一：v2 三字段齐全，recordId 是 uuid 且互不相同
  const missingV2 = run.filter((e) => !e.recordId || !e.runId || !e.observedTs).length;
  check("v2 三字段齐全（recordId / runId / observedTs）", missingV2 === 0, `缺 ${missingV2} 条`);
  const badUuid = run.filter((e) => e.recordId && !UUID_RE.test(e.recordId)).length;
  check("recordId 都是 uuid", badUuid === 0, `不合规 ${badUuid} 条`);
  check("recordId 互不相同", new Set(run.map((e) => e.recordId)).size === run.length);

  // 判据二：文件事件数 == audit.rows
  // 文件事件按 evidence 形状判（带 file 字段的文件证据），不按事件名——层结论引用
  // 的是 refEvidence，名里带不带 apply-result 都可能变，形状不会。
  const isFileEvent = (e) => e.evidence && typeof e.evidence.file === "string";
  const fileEvents = run.filter(isFileEvent);
  check(
    `文件事件数 == audit.rows（${expectedRows}）`,
    fileEvents.length === expectedRows,
    `实落 ${fileEvents.length} 条`,
  );

  // 判据三：每个 audit 层有且仅有一条 apply-result
  for (const layer of table.layers) {
    const conclusions = run.filter((e) => e.event === `${layer}${RESULT_SUFFIX}`);
    check(
      `${layer} 层有且仅有一条 apply-result`,
      conclusions.length === 1,
      `实有 ${conclusions.length} 条`,
    );
  }

  // 判据四：completeness 三项全真
  const conclusions = run.filter((e) => typeof e.event === "string" && e.event.endsWith(RESULT_SUFFIX));
  for (const c of conclusions) {
    const completeness = (c.detail || {}).completeness || {};
    const falseOnes = ["patches", "files", "layers"].filter((k) => completeness[k] !== true);
    check(`${c.event} 的 completeness 三项全真`, falseOnes.length === 0, `假：${falseOnes.join(",")}`);
  }

  // 判据六：result 与自己的计数 / completeness 折算后必须一致，partial 的来路也要对得上。
  for (const c of conclusions) {
    const detail = c.detail || {};
    const want = foldResult(detail);
    check(`${c.event} 的 result 与计数折算一致（应为 ${want}）`, c.result === want, `实为 ${c.result}`);
    if (c.result !== "partial") continue;
    const completeness = detail.completeness || {};
    const wantReason = ["patches", "files", "layers"].some((key) => completeness[key] === false)
      ? "record"
      : "layer";
    check(
      `${c.event} 的 partialReason 与来路一致（应为 ${wantReason}）`,
      detail.partialReason === wantReason,
      `实为 ${JSON.stringify(detail.partialReason)}`,
    );
  }

  // 判据七：detail.table.recorded 与文件行里的不同补丁号个数相等，且「差只能由 unresolved 解释」。
  // 定义见 docs/log-generations.json 的 recorded 一行：**有文件行的补丁号个数**（不含 unresolved）。
  // 为什么不写成「该落账的减 unmapped」：那样会把写不出证据的那几条也算成落了账。这一条与
  // lib/audit/runs.js 的 verifyRecordedAccounting 同口径；脚本不许 import lib，所以照定义复算一次。
  const declaredTable = conclusions
    .map((c) => (c.detail || {}).table)
    .find((t) => t && typeof t === "object") || null;
  if (declaredTable === null) {
    log("INFO 这一轮没有 detail.table.recorded（v2 / v2-entry 世代）：recorded 自证不可判");
  } else {
    const recordedIds = new Set(fileEvents.map((e) => String((e.detail || {}).patchId)));
    check(
      `detail.table.recorded == 文件行里的不同补丁号个数（${recordedIds.size}）`,
      declaredTable.recorded === recordedIds.size,
      `实为 ${JSON.stringify(declaredTable.recorded)}`,
    );
    const unresolvedIds = new Set();
    for (const c of conclusions) {
      for (const id of ((c.detail || {}).unresolved || [])) unresolvedIds.add(String(id));
    }
    const exemptIds = new Set((declaredTable.exempt || []).map(String));
    const unmappedIds = new Set((declaredTable.unmapped || []).map(String));
    // 过滤 apply：写侧把这一轮 report 里出现过的补丁号记在 detail.table.selected 上。
    // 有它时只对 selected 记账 —— 没选中的补丁本来就不该有账，拿全表判会把合法过滤轮判红。
    const selected = Array.isArray(declaredTable.selected)
      ? [...new Set(declaredTable.selected.map(String))]
      : null;
    if (selected === null) {
      log("INFO detail.table 没有 selected（过渡形态）：无 selected，按全表判");
      const total = declaredTable.total;
      if (Number.isInteger(total)) {
        const budget = total - exemptIds.size - unmappedIds.size;
        check(
          `detail.table.recorded + unresolved == total − exempt − unmapped（${budget}）`,
          Number.isInteger(declaredTable.recorded) && declaredTable.recorded + unresolvedIds.size === budget,
          `recorded=${JSON.stringify(declaredTable.recorded)} unresolved=${unresolvedIds.size}`,
        );
      }
    } else {
      const wanted = selected.filter((id) => !exemptIds.has(id) && !unmappedIds.has(id));
      const present = new Set([...recordedIds, ...unresolvedIds]);
      const absent = wanted.filter((id) => !present.has(id));
      check(
        "detail.table.selected 里的补丁都落了文件行或进了 unresolved",
        absent.length === 0,
        `缺 ${absent.join(",") || "（无）"}`,
      );
      const budget = wanted.length;
      check(
        `detail.table.recorded + unresolved == selected 去掉 exempt / unmapped（${budget}）`,
        Number.isInteger(declaredTable.recorded) && declaredTable.recorded + unresolvedIds.size === budget,
        `recorded=${JSON.stringify(declaredTable.recorded)} unresolved=${unresolvedIds.size}`,
      );
    }
  }

  // 判据五：exempt 与补丁表逐层一致，且 exempt 补丁不落文件事件
  for (const layer of table.layers) {
    const c = conclusions.find((e) => e.event === `${layer}${RESULT_SUFFIX}`);
    if (!c) continue;
    const listed = ((c.detail || {}).exempt || []).slice().sort((a, b) => a - b);
    const want = (table.exemptByLayer.get(layer) || []).slice().sort((a, b) => a - b);
    check(
      `${layer} 层 detail.exempt 与补丁表一致（[${want.join(",")}]）`,
      JSON.stringify(listed) === JSON.stringify(want),
      `实列 [${listed.join(",")}]`,
    );
  }
  const exemptAll = new Set([...table.exemptByLayer.values()].flat());
  const exemptWritten = fileEvents
    .filter((e) => exemptAll.has((e.detail || {}).patchId))
    .map((e) => (e.detail || {}).patchId);
  check("exempt 补丁不落文件事件", exemptWritten.length === 0, `落了：${exemptWritten.join(",")}`);

  // 有响应体时顺带断言 unresolved 为空（记全的另一半：缺口可见）
  if (expectUnresolvedEmpty) {
    const unresolved = (JSON.parse(readFileSync(args.response, "utf8")).audit || {}).unresolved;
    check("apply 响应 audit.unresolved 为空", Array.isArray(unresolved) && unresolved.length === 0,
      `实为 [${(unresolved || []).join(",")}]`);
  }

  if (failures.length > 0) {
    console.error(`[check-audit-completeness] 命中 ${failures.length} 条：${failures.join("；")}`);
    process.exit(EXIT_HIT);
  }
  log(`SMOKE OK: run ${runId}，文件事件 ${fileEvents.length} + 层结论 ${conclusions.length}`);
  process.exit(EXIT_OK);
}

main();
