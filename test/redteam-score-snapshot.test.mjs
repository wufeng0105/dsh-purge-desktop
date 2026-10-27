/**
 * 计分口径（`lib/redteam/score-rules.js`）的 characterization 快照。
 *
 * 为什么需要这个文件：这个 945 行的模块是面板 / 报告 / 攻击链三处**共用的唯一实现**，
 * 却零行为覆盖。拆它之前必须先有一份「固定输入 → 固定输出」的基线，否则「搬完行为没变」
 * 这句话只能靠通读全文件自证。快照锁的是**现状**，不是「现状正确」—— 见末节的说明。
 *
 * 锁住的东西（每条都在下面有 case）：
 *   一、口径数据本身 —— `DEFAULT_SCORE_POINTS` 的 sha256 与逐条字段、`SCORE_GROUPS`、
 *      `SCORE_CONFIRM` 的键集合、`TUNNEL_ENTRY_KINDS`、`SERVICE_CAPPED_POINT_CODES`、
 *      `SENSITIVE_DATA_MIN_ROWS`；
 *   二、四种 `dedup_scope`（service / system / target / none）各自的去重结果，
 *      外加 `SERVICE_CAPPED_POINT_CODES` 三个 code 的旧口径路径（`pointsByCode` 省略时
 *      走 `legacyCapGroup`）—— 这条路径在真实调用里仍会被走到，是搬移时最容易断的隐线；
 *   三、`system` 口径的四条判定序（显式 `system_key` 采信 / 不采信、资产名、服务键兜底、
 *      `#hit` 兜底），`rule` 上限与 `self_created` 的相互作用；
 *   四、服务键与解析类纯函数（`parseTargetPort` / `normalizePort` / `targetAuthority` /
 *      `scoreServiceKey` / `serviceLabel` / `scoreCapReasonText` / `scoreConfirmOf` /
 *      `parseRowCount` / `formatRows`）的固定输入输出；
 *   五、倍率与阈值：IPv6 判定（含裸写与 `host:端口` 的误判分界）、G5 的两档、
 *      `SENSITIVE_DATA_MIN_ROWS` 的 ±1；
 *   六、`evaluateScoreBoard` 的整条装配路径（用假 db 走 `loadScoreMeta` 与
 *      `loadAssetNames` 两条 SQL、`enabledOnly` 的停用集合）。
 *
 * 输入怎么造：全部是**合成行**与**假 db**，不含任何真实靶标、IP 或证据文本。
 * 构造不出来的 case 一律不编：写不出来的就不写，并在 exec 摘要里登记为什么。
 *
 * 快照文件：test/fixtures/redteam-score.snapshot.txt
 *
 * 更新方式（只在**有意**改口径时用）：
 *   $env:DSH_PURGE_UPDATE_SNAPSHOT=1; node --test test/redteam-score-snapshot.test.mjs
 * 然后 `git diff test/fixtures/redteam-score.snapshot.txt` 逐行看 —— 改了哪几行、
 * 为什么改，要能对上是哪次改动。**拆分搬移时这个文件必须零 diff**。
 */
import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as S from "../lib/redteam/score-rules.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, "fixtures", "redteam-score.snapshot.txt");

/** 紧凑序列化：键序由调用点的投影字面量固定，不依赖对象属性顺序。 */
const j = (v) => JSON.stringify(v);

/**
 * 一行快照。`name | payload` 两列，name 里带分类前缀，方便 diff 时定位是哪一族变了。
 * payload 里的数字与字符串都取自实跑结果，不手写。
 */
const row = (name, payload) => `${name} | ${j(payload)}`;

/** 命中行的投影：只留下「计分判定」相关的字段，`evidence` 之类的长文本不进快照。 */
const proj = (item) => [
  item.id,
  item.capped === true ? 1 : 0,
  item.capped_reason_kind,
  item.capped_by_id ?? null,
  item.dedup_scope ?? null,
  item.cap_group ?? null,
  item.rule ?? null,
  item.rule_cap ?? null,
  item.points ?? null,
  item.service_key ?? null,
  item.system_key ?? null,
];

/** 造一行命中；默认值是「有服务键、无倍率、非自建」的常见形态。 */
const hit = (id, code, points, extra = {}) => ({ id, code, points, ...extra });

/**
 * 四种 `dedup_scope` 的元数据。`rule` 取互不相同的值，避免不同 case 之间互相吃到上限；
 * `cap = 0` 表示不设上限，让去重与封顶两条路径分开受控。
 */
const META = new Map([
  ["svc-code", { rule: 1, cap: 0, dedup_scope: "service", points: 10 }],
  ["sys-code", { rule: 2, cap: 0, dedup_scope: "system", points: 10 }],
  ["tgt-code", { rule: 3, cap: 0, dedup_scope: "target", points: 100 }],
  ["none-code", { rule: 4, cap: 0, dedup_scope: "none", points: 5 }],
  ["cap-code", { rule: 5, cap: 30, dedup_scope: "none", points: 10 }],
]);

/** 资产 id → 系统名。只用保留域名与假名，不含真实资产。 */
const NAMES = new Map([
  [7, "oa-a"],
  [8, "oa-b"],
]);

/**
 * 假靶标库：只回答 `loadScoreMeta` / `loadAssetNames` 这两条 SQL，其余一律抛错。
 * 抛错是刻意的 —— 若搬移后多出第三条查询，这里会立刻红，而不是静默返回空集。
 */
const FAKE_DB = {
  prepare(sql) {
    if (/FROM score_point/.test(sql)) {
      return {
        all: () => [
          { code: "svc-code", rule: 1, cap: 200, dedup_scope: "service", points: 10, enabled: 1, builtin: 1, src: 1 },
          { code: "off-code", rule: 2, cap: 0, dedup_scope: "system", points: 5, enabled: 0, builtin: 0, src: null },
          { code: "tgt-code", rule: 3, cap: 0, dedup_scope: "target", points: 100, enabled: 1, builtin: 1, src: 3 },
        ],
      };
    }
    if (/FROM asset/.test(sql)) {
      return { all: () => [{ id: 7, primary_name: "oa-a" }, { id: 8, primary_name: null }] };
    }
    throw new Error(`假 db 收到了未预期的查询：${sql}`);
  },
};

/** 口径数据一族。 */
function dataRows() {
  return [
    row("data DEFAULT_SCORE_POINTS sha256",
      createHash("sha256").update(JSON.stringify(S.DEFAULT_SCORE_POINTS)).digest("hex")),
    row("data DEFAULT_SCORE_POINTS count", S.DEFAULT_SCORE_POINTS.length),
    ...S.DEFAULT_SCORE_POINTS.map((p) => row(
      `point ${p.code}`,
      [p.src, p.rule, p.category, p.points, p.cap, p.dedup_scope, p.tier.length, p.description.length],
    )),
    row("data SCORE_GROUPS", S.SCORE_GROUPS.map((g) => [g.code, g.name])),
    row("data SCORE_CONFIRM keys", Object.keys(S.SCORE_CONFIRM).sort()),
    row("data TUNNEL_ENTRY_KINDS", Object.entries(S.TUNNEL_ENTRY_KINDS)),
    row("data SERVICE_CAPPED_POINT_CODES", S.SERVICE_CAPPED_POINT_CODES),
    row("data SENSITIVE_DATA_MIN_ROWS", S.SENSITIVE_DATA_MIN_ROWS),
  ];
}

/**
 * 去重与封顶一族。
 *
 * 每个 case 都只把该 case 关心的分支推到「真的发生了」：去重要真有一条被压住，
 * 上限要真有超出的一条 —— 只喂一组不触发结果的输入等于没测这一条路径。
 */
function dedupRows() {
  const caps = (rows, meta, names) => S.applyScoreCaps(rows, meta, names);

  const out = [];

  /* service 口径：两条同端口（同服务键）留高分一条；第三条无服务信息不参与去重。 */
  out.push(row("dedup service 同服务键留高分", caps([
    hit(1, "svc-code", 10, { asset_id: 7, port: 443, target: "https://a.test/x" }),
    hit(2, "svc-code", 20, { asset_id: 7, port: 443, target: "https://a.test/y" }),
    hit(3, "svc-code", 30, { target: "" }),
  ], META, NAMES).items.map(proj)));
  out.push(row("dedup service 两条独立服务", caps([
    hit(1, "svc-code", 10, { target: "https://a.test/" }),
    hit(2, "svc-code", 20, { target: "https://b.test/" }),
  ], META, NAMES).items.map(proj)));

  /* system 口径：资产名的「名字 + 服务键」是主力路径。 */
  out.push(row("dedup system 资产名路径", caps([
    hit(1, "sys-code", 10, { asset_id: 7, port: 443, target: "x" }),
    hit(2, "sys-code", 50, { asset_id: 7, port: 443, target: "x" }),
    hit(3, "sys-code", 10, { asset_id: 8, port: 443, target: "x" }),
  ], META, NAMES).items.map(proj)));

  /* 显式 system_key 采信：它包含服务键前缀。 */
  out.push(row("dedup system 显式键采信", caps([
    hit(1, "sys-code", 10, { system_key: "oa-a|t10.0.0.1:443", target: "https://10.0.0.1:443/" }),
    hit(2, "sys-code", 99, { system_key: "oa-a|t10.0.0.1:443", target: "https://10.0.0.1:443/z" }),
  ], META, NAMES).items.map(proj)));

  /* 显式 system_key 含服务键前缀时**不采信**，退化到资产名 —— 这是防「野键合并错封」的那一刀。 */
  out.push(row("dedup system 显式键不采信退资产名", caps([
    hit(1, "sys-code", 10, { asset_id: 7, port: 443, system_key: "别处的系统|443" }),
    hit(2, "sys-code", 50, { asset_id: 7, port: 443, system_key: "别处的系统|443" }),
  ], META, NAMES).items.map(proj)));

  /* 拿不到服务键时：名字段非空才采信显式键；`|443` 这种名字为空的野键不采信。 */
  out.push(row("dedup system 无服务键时显式键判名", caps([
    hit(1, "sys-code", 10, { system_key: "oa-sub|443" }),
    hit(2, "sys-code", 50, { system_key: "oa-sub|443" }),
    hit(3, "sys-code", 90, { system_key: "|443" }),
  ], META, NAMES).items.map(proj)));

  /* 三条都拿不到 → `#hit<id>`，即「各算各的」，宁可少封顶也不错封。 */
  out.push(row("dedup system 三条皆空各算各", caps([
    hit(1, "sys-code", 10),
    hit(2, "sys-code", 50),
  ], META, NAMES).items.map(proj)));

  /* target 口径：整个目标只算一次，与资产/端口无关。 */
  out.push(row("dedup target 只留最高", caps([
    hit(1, "tgt-code", 100, { target: "a" }),
    hit(2, "tgt-code", 300, { target: "b" }),
  ], META, NAMES).items.map(proj)));

  /* none 口径：不去重，按次累加。 */
  out.push(row("dedup none 不去重", caps([
    hit(1, "none-code", 5, { target: "a" }),
    hit(2, "none-code", 5, { target: "b" }),
  ], META, NAMES).items.map(proj)));

  /*
   * 旧口径路径（`pointsByCode` 省略 → `legacyCapGroup`）：`SERVICE_CAPPED_POINT_CODES`
   * 的三个 code 与一个非成员。这条路径的真实触发条件是「得分点元数据里没有该 code」，
   * 老库与未回填的库仍会走到 —— 三个 code 各一条，非成员一条做对照。
   */
  for (const code of [...S.SERVICE_CAPPED_POINT_CODES, "server-host"]) {
    out.push(row(`legacy ${code}`, caps([
      hit(1, code, 10, { asset_id: 7, port: 443, target: "https://a.test/x" }),
      hit(2, code, 20, { asset_id: 7, port: 443, target: "https://a.test/y" }),
    ], null, null).items.map(proj)));
  }

  /* rule 上限：按分值从高到低累计，超出的标 `cap`；去重与上限叠加时先标 dedup。 */
  out.push(row("cap 规则上限", caps([
    hit(1, "cap-code", 10),
    hit(2, "cap-code", 25),
    hit(3, "cap-code", 5),
  ], META, NAMES).items.map(proj)));
  out.push(row("cap 上限用量表", [...caps([
    hit(1, "cap-code", 10),
    hit(2, "cap-code", 25),
    hit(3, "cap-code", 5),
  ], META, NAMES).caps]));
  out.push(row("cap 与 dedup 叠加", caps([
    hit(1, "svc-code", 10, { target: "https://a.test/" }),
    hit(2, "svc-code", 20, { target: "https://a.test/x" }),
  ], new Map([["svc-code", { rule: 9, cap: 15, dedup_scope: "service", points: 10 }]]), NAMES).items.map(proj)));

  /* 自建账号不计分、也不占位：它既不参与去重，也不计入上限。 */
  out.push(row("self_created 不参与", caps([
    hit(1, "svc-code", 100, { self_created: 1, target: "https://a.test:443/" }),
    hit(2, "svc-code", 20, { self_created: 0, target: "https://a.test:443/" }),
    hit(3, "svc-code", 30, { target: "https://a.test:443/" }),
  ], META, NAMES).items.map(proj)));

  /* 元数据的两种形态都要认：Map 与普通对象。取不到时退化成「每个 code 自成一组」。 */
  out.push(row("meta 普通对象与 Map 等价", caps([
    hit(1, "svc-code", 10, { target: "https://a.test/" }),
    hit(2, "svc-code", 20, { target: "https://a.test/x" }),
  ], { "svc-code": { rule: 1, cap: 0, dedup_scope: "service", points: 10 } },
  { 7: "oa-a" }).items.map(proj)));

  return out;
}

/** 服务键与解析一族。 */
function parseRows() {
  const targets = [
    "https://h:8443/a?b=1",
    "http://h/x",
    "https://h/x",
    "h:6379",
    "h",
    "2001:db8::1",
    "[::1]:22",
    "http://[2001:db8::1]:8080/x",
    "10.0.0.5:65536",
    "10.0.0.5:0",
    "",
    "   ",
  ];
  return [
    row("parse parseTargetPort", targets.map((t) => [t, S.parseTargetPort(t)])),
    row("parse normalizePort", [null, undefined, "", 0, "443", 443, 65536, -1, 80.5, "0"].map((v) => [String(v), S.normalizePort(v)])),
    row("parse targetAuthority", targets.map((t) => [t, S.targetAuthority(t)])),
    row("parse scoreServiceKey 只有 target", targets.map((t) => [t, S.scoreServiceKey({ target: t })])),
    row("parse scoreServiceKey 退资产", [
      [S.scoreServiceKey({ asset_id: 7, port: 443 })],
      [S.scoreServiceKey({ asset_id: 7 })],
      [S.scoreServiceKey({ asset_id: "" })],
      [S.scoreServiceKey({})],
    ].map((x) => x[0])),
    row("parse serviceLabel", [
      [S.serviceLabel({ target: "https://a.test/x" }, "10.0.0.9")],
      [S.serviceLabel({ target: "https://a.test/x", asset_ip: "10.0.0.9" })],
      [S.serviceLabel({ target: "https://a.test/x", port: 8443 })],
      [S.serviceLabel({ target: "https://a.test:8443/x", port: 8443 })],
      [S.serviceLabel({ target: "h" })],
      [S.serviceLabel({ target: "" })],
      [S.serviceLabel({})],
    ].map((x) => x[0])),
    row("parse scoreCapReasonText", [
      S.scoreCapReasonText({ capped_reason_kind: "cap", rule: 9, rule_cap: 15, target: "https://a.test/x" }),
      S.scoreCapReasonText({ target: "https://a.test/x" }),
      S.scoreCapReasonText({ target: "https://a.test/x" }, 20),
      S.scoreCapReasonText({ capped_reason_kind: "cap", rule: null, rule_cap: null }),
    ]),
    row("parse scoreConfirmOf", [
      S.scoreConfirmOf("db-credential"),
      S.scoreConfirmOf("  db-credential  "),
      S.scoreConfirmOf("不存在的得分点"),
      S.scoreConfirmOf(""),
      S.scoreConfirmOf(null),
    ]),
    row("parse parseRowCount", [
      "999999 条", "1000000 条", "1000001 条",
      "120 万条", "1,200,000 条记录", "2.5万行", "1200000 records",
      "导出 120 万", "123456", "", null,
    ].map((e) => [String(e), S.parseRowCount(e)])),
    row("parse SENSITIVE_DATA_MIN_ROWS 阈值邻域", [
      "999999 条", "1000000 条", "1000001 条",
    ].map((e) => {
      const n = S.parseRowCount(e);
      return [e, n, n >= S.SENSITIVE_DATA_MIN_ROWS];
    })),
    row("parse formatRows", [0, 1000000, 1234567].map((n) => S.formatRows(n))),
    row("parse tunnelIsLegit", [
      "target-outbound", "target-http", "target-agent", "self-only", "  self-only  ", "", null,
    ].map((k) => [String(k), S.tunnelIsLegit(k)])),
  ];
}

/** 倍率、IPv6 与统一评估入口。 */
function multiplierRows() {
  return [
    row("multi targetHasIpv6Host", [
      "http://[2001:db8::1]:8080/x", "2001:db8::1", "[::1]:22", "2001:db8::1:443",
      "dc01:389", "ad01:8080", "https://h/x", "", "http://[::1]/",
    ].map((t) => [t, S.targetHasIpv6Host(t)])),
    row("multi scoreMultiplierOf", [
      { target: "http://[2001:db8::1]:8080/x" },
      { target: "2001:db8::1" },
      { target: "dc01:389" },
      { target: "https://h/x", data_scale: "large" },
      { target: "https://h/x", data_scale: "knowledge-base" },
      { target: "https://h/x", data_scale: "kb" },
      { target: "2001:db8::1", data_scale: "large" },
      { target: "https://h/x", ip_version: 6 },
      { target: "https://h/x", data_scale: "别的" },
      {},
    ].map((h) => [h, S.scoreMultiplierOf(h)])),
    row("multi hitPointsOf", [
      [S.hitPointsOf({ points: 50 }), "自带分值优先"],
      [S.hitPointsOf({ points: 50, multiplier: 3 })],
      [S.hitPointsOf({ code: "tgt-code" }, META)],
      [S.hitPointsOf({ code: "tgt-code", multiplier: 2 }, { "tgt-code": { points: 100 } })],
      [S.hitPointsOf({ code: "不存在的", points: null }, META)],
      [S.hitPointsOf({}, null)],
    ]),
    row("multi evaluateScoreBoard", (() => {
      const r = S.evaluateScoreBoard(FAKE_DB, [
        hit(1, "svc-code", 10, { asset_id: 7, port: 443, target: "https://x.test/" }),
        hit(2, "svc-code", 20, { asset_id: 7, port: 443, target: "https://x.test/y" }),
        hit(3, "off-code", 5, { asset_id: 8, target: "z" }),
        hit(4, null, null, { asset_id: 8 }),
        hit(5, "tgt-code", 100, { ip_version: 6 }),
      ], { enabledOnly: true });
      return {
        items: r.items.map(proj),
        caps: [...r.caps],
        disabled: [...r.disabledIds].sort((a, b) => a - b),
        meta: [...r.meta.keys()].sort(),
        names: [...r.names],
      };
    })()),
    row("multi evaluateScoreBoard 复用已读元数据", (() => {
      const meta = new Map([["svc-code", { rule: 1, cap: 0, dedup_scope: "service", points: 10, enabled: 1, builtin: true, src: 1 }]]);
      const names = new Map([[7, "oa-a"]]);
      const r = S.evaluateScoreBoard({ prepare() { throw new Error("给了 meta 就不该再查库"); } },
        [hit(1, "svc-code", 10, { asset_id: 7, port: 443 })], { meta, names });
      return { items: r.items.map(proj), disabled: [...r.disabledIds] };
    })()),
  ];
}

/** 快照正文：三族顺序固定，改动会让 diff 整片可见。 */
function snapshotRows() {
  return [...dataRows(), ...dedupRows(), ...parseRows(), ...multiplierRows()];
}

const HEADER = [
  "# dsh-purge 计分口径 characterization 快照",
  "#",
  "# 列：name | payload",
  "#",
  "# 生成：test/redteam-score-snapshot.test.mjs（见文件头注释）",
  "# 更新：$env:DSH_PURGE_UPDATE_SNAPSHOT=1; node --test test/redteam-score-snapshot.test.mjs",
  "#",
  "# 这个文件是计分口径的唯一行为基线，锁的是**现状**，不是「现状正确」。",
  "# 拆分搬移时它必须逐行不变；只有有意改口径（改分值 / 改上限 / 改去重口径）才允许出现差异。",
].join("\n") + "\n\n";

/**
 * 归一到 LF 再比较。
 *
 * 必须做这一步：仓库 `core.autocrlf=true`，快照文件在 Windows 检出时是 CRLF、
 * 在 CI（ubuntu）上是 LF。原样逐字符串比较会让这条测试变成「只在写它那台机器上绿」。
 */
function normalize(text) {
  return String(text).replace(/\r\n/g, "\n");
}

test("快照基线：计分口径全量 case = 逐行快照不变", () => {
  const actual = normalize(HEADER + snapshotRows().join("\n") + "\n");
  if (process.env.DSH_PURGE_UPDATE_SNAPSHOT === "1") {
    writeFileSync(SNAPSHOT, actual, "utf8");
    console.log(`[snapshot] 写回 ${SNAPSHOT}`);
    return;
  }
  assert.ok(existsSync(SNAPSHOT), `快照文件不存在：${SNAPSHOT}。先生成：DSH_PURGE_UPDATE_SNAPSHOT=1 node --test`);
  const expected = normalize(readFileSync(SNAPSHOT, "utf8"));
  if (actual === expected) return;

  const a = actual.split("\n");
  const e = expected.split("\n");
  const diffs = [];
  const max = Math.max(a.length, e.length);
  for (let i = 0; i < max; i += 1) {
    if ((a[i] ?? "") === (e[i] ?? "")) continue;
    diffs.push(`  L${i + 1}\n    快照: ${e[i] ?? "（缺行）"}\n    实际: ${a[i] ?? "（缺行）"}`);
  }
  assert.fail(
    `计分口径与快照基线不同（${diffs.length} 行）。\n`
      + `如果这次是拆分搬移，行为必须零 diff —— 出现差异说明搬坏了：\n${diffs.join("\n")}\n\n`
      + `如果是有意改口径，用 DSH_PURGE_UPDATE_SNAPSHOT=1 重生成并 review 每一行。`,
  );
});

/**
 * 覆盖度护栏：快照必须真的覆盖被移动的每条路径，而不是「跑通了就算」。
 *
 * 四条断言对应四族里最容易在搬移中悄悄丢掉的分支。判据取自快照正文本身，
 * 手抄一份 case 清单不叫覆盖 —— 清单能改，正文不能白改（改了就要 diff）。
 */
test("快照覆盖度：四种 dedup_scope + 三个 service 封顶 code + 阈值邻域都在快照里", () => {
  const text = normalize(HEADER + snapshotRows().join("\n") + "\n");
  for (const scope of ["service", "system", "target", "none"]) {
    assert.ok(
      text.includes(j(scope)),
      `快照里没有出现 dedup_scope=${scope} 的判定结果 —— 这条去重路径没被覆盖`,
    );
    // 光出现在输入侧不算覆盖：每种口径都必须真有一条被压住（capped=1）的结果。
    assert.match(
      text,
      new RegExp(`\\[[0-9]+,1,("dedup"|"cap"),(null|[0-9]+),"${scope}"`),
      `快照里 dedup_scope=${scope} 没有一条真被判掉分的 case —— 这条路径没跑到`,
    );
  }
  for (const code of S.SERVICE_CAPPED_POINT_CODES) {
    assert.ok(text.includes(`legacy ${code} | `), `快照里没有 ${code} 的旧口径 case`);
  }
  for (const e of ["999999 条", "1000000 条", "1000001 条"]) {
    assert.ok(text.includes(e), `快照里没有阈值邻域的输入 ${e}`);
  }
  assert.ok(text.includes("multi evaluateScoreBoard | "), "快照里没有 evaluateScoreBoard 的装配 case");
  assert.ok(text.includes("multi targetHasIpv6Host | "), "快照里没有 IPv6 判定 case");
});
