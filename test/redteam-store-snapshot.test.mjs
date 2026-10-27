/**
 * 演练台事实库（`lib/redteam/store-core.js`）三条写路径的 characterization 快照。
 *
 * 为什么需要这个文件：演练台此前零行为覆盖，写库路径「被调用但语义错」查不出来 ——
 * 把 `UPDATE score_point SET enabled = ?` 里的参数直接写成常量 1，全量测试照样全绿，
 * 因为没有任何断言读过写进去的那一行。这份快照锁的是**写进去之后库里和面板上是什么**：
 *   一、`score_point` 的启用与排序：停用一条内置点后 `enabled` 真是 0、`enabledOnly`
 *      真的少一条；再启用并改 `sort_order` 后，面板排序真的跟着动（且不传 `sort_order`
 *      时旧值保留 —— 那是 `COALESCE(?, sort_order)` 的语义）；
 *   二、`asset` 的优先级写：`priority` / `potential` / `assess_reason` 三个字段落库，
 *      不传优先级时沿用旧值、非法优先级不覆盖旧值；
 *   三、`score_hit` 的落账：一条命中插入后 `points` / `port` / `self_created` 的取值、
 *      同资产同端口第二条更高分把第一条顶掉、自建账号只留痕不计分，以及面板总览的计数。
 *
 * 输入怎么造：**临时目录里的真 SQLite**（`node:sqlite` 的 `DatabaseSync`，由 store 自己开），
 * 用 `mkdtempSync` 建在工作区之外，跑完即删；模块级把诊断日志关掉（`DSH_PURGE_LOG=0`），
 * 不动真实的 `~/.dsh`。资产名、IP 与证据全部是合成值（示例保留网段 / 演示主机名），
 * 不含任何真实靶标、真实资产或本机路径。
 *
 * 判据是「重跑同一条命令，快照逐行相同」，不是「现状正确」：快照记录的是今天的行为，
 * 有意改口径（改计分、改启停、改排序）时必须重生成并逐行 review。
 *
 * 快照文件：test/fixtures/redteam-store.snapshot.txt
 *
 * 更新方式（只在**有意**改写入语义时用）：
 *   $env:DSH_PURGE_UPDATE_SNAPSHOT=1; node --test test/redteam-store-snapshot.test.mjs
 * 然后 `git diff test/fixtures/redteam-store.snapshot.txt` 逐行看：变了哪几行、为什么变。
 * 时间戳（`recorded_at` / `assessed_at` / `created_at`）与自增主键一律不进快照 ——
 * 它们每次运行都不同，写进去只会让这份基线变成「只在某台机器某一次绿」。
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* 事实库的诊断日志默认落到 <DSH_HOME>/dsh-purge/logs；快照测试必须在临时目录里自洽，
   真实 home 一个字节都不碰。diagLog 每次调用都重读环境变量，所以这里设一次即可。 */
process.env.DSH_PURGE_LOG = "0";

const { RedteamStore } = await import("../lib/redteam/store-core.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, "fixtures", "redteam-store.snapshot.txt");

/** 紧凑序列化：键序由调用点的投影字面量固定，不依赖对象属性顺序。 */
const j = (v) => JSON.stringify(v);

/** 一行快照。`name | payload` 两列，name 带写路径前缀，diff 时先定位是哪条路径变了。 */
const row = (name, payload) => `${name} | ${j(payload)}`;

/**
 * 面板总览里**可复现**的那部分。
 *
 * 白名单而不是黑名单：`latestCapped` 里带 `recorded_at`，漏进来就会让快照随运行时间抖动。
 * 这里只收计数与分值，它们是这条路径真正要锁的东西。
 */
const SUMMARY_KEYS = [
  "achievedPoints", "pointCount", "hitPointCount", "hitCount",
  "countedHits", "selfCreatedHits", "serviceCappedHits",
  "cappedByDedup", "cappedByRuleLimit", "legacyPointCount", "legacyHitCount",
];
const summaryOf = (board) => SUMMARY_KEYS.map((k) => [k, board.summary[k]]);

/** 命中行的投影：只留计分判定相关的字段，长文本只记「有没有」。 */
const projHit = (h) => [
  h.point,
  h.base_points,
  h.multiplier,
  h.points,
  h.port,
  h.self_created ? 1 : 0,
  h.counted ? 1 : 0,
  h.capped_by_service ? 1 : 0,
  h.warning ? "warning" : "none",
];

/**
 * 把三条写路径按固定顺序跑一遍，返回快照行。
 *
 * 每次调用都在**新的临时目录**里跑一份完整的库：两次调用互不干扰，同一个脚本重复跑
 * 结果逐字节相同。临时目录在 `finally` 里删干净 —— 删除失败也要先关句柄（Windows 上
 * 打开着的 SQLite 文件删不掉）。
 */
function snapshotRows() {
  const root = mkdtempSync(join(tmpdir(), "dsh-purge-wp6-store-"));
  const store = new RedteamStore(root);
  const out = [];
  try {
    const { id } = store.openEngagement("wp6-snapshot-target", ["198.51.100.0/24"], { bindCurrent: false });
    const db = store.db(id);

    /* ── 一、score_point：播种基线 + 停用 + 启用并改排序 + 自建点 ─────────── */
    const seeded = db.prepare("SELECT code, points, enabled, sort_order, builtin FROM score_point ORDER BY sort_order, id").all();
    out.push(row("score 播种基线", seeded.map((p) => [p.code, p.points, p.enabled, p.sort_order, p.builtin])));
    out.push(row("score 初始面板", summaryOf(store.listScorePoints(id))));

    /* 停用走的是 UPDATE 分支（内置点只允许改启用/排序）：把参数写成常量就会在这里露馅。 */
    const target = db.prepare("SELECT id, code, points, sort_order FROM score_point WHERE code = 'terminal-access'").get();
    const off = store.saveScorePoint(id, { id: target.id, enabled: false });
    out.push(row("score 停用内置点", {
      saved: [off.updated, off.builtin, off.overridden, off.points],
      row: db.prepare("SELECT enabled, sort_order FROM score_point WHERE id = ?").get(target.id),
      board: summaryOf(store.listScorePoints(id)),
      enabledOnly: store.listScorePoints(id, { enabledOnly: true }).items.length,
    }));

    /* 再启用并改排序：`sort_order` 显式给 -3，效果必须落在面板的先后顺序上。 */
    const on = store.saveScorePoint(id, { id: target.id, enabled: true, sort_order: -3 });
    const boardAfterSort = store.listScorePoints(id);
    out.push(row("score 启用并改排序", {
      saved: [on.updated, on.builtin],
      row: db.prepare("SELECT enabled, sort_order FROM score_point WHERE id = ?").get(target.id),
      order: boardAfterSort.items.slice(0, 6).map((it) => it.code),
      index: boardAfterSort.items.findIndex((it) => it.code === target.code),
    }));

    /* 自建点走 INSERT 分支：分值由自己定、builtin 必须是 0、sort_order 自动排在最后。 */
    const custom = store.saveScorePoint(id, {
      code: "wp6-custom", name: "wp6 演示得分点", category: "OTHER", points: 7,
      description: "演示用得分点，不含真实资产",
    });
    out.push(row("score 自建点", {
      saved: [custom.updated, custom.builtin, custom.overridden, custom.points],
      row: db.prepare("SELECT code, points, enabled, sort_order, builtin FROM score_point WHERE id = ?").get(custom.id),
    }));

    /* ── 二、asset：导入两条合成资产，写优先级 ─────────────────────────── */
    const bundle = store.importBundle(id, {
      scan: { tool: "wp6-fixture", argv: ["--fixture"] },
      assets: [
        {
          ip: "203.0.113.10", primary_name: "demo-host-a",
          names: [{ name: "demo-a.test" }],
          ports: [{ port: 443, service: "https" }, { port: 8443 }],
        },
        { ip: "203.0.113.11", primary_name: "demo-host-b", ports: [{ port: 22 }] },
      ],
    });
    out.push(row("asset 导入计数", bundle.counts));
    const assetA = db.prepare("SELECT id FROM asset WHERE ip = '203.0.113.10'").get().id;
    const assetB = db.prepare("SELECT id FROM asset WHERE ip = '203.0.113.11'").get().id;

    const high = store.assessAsset(id, {
      asset_id: assetA, priority: "high", potential: "示例成果", reason: "示例依据", assessed_by: "wp6-agent",
    });
    out.push(row("asset 优先级写", {
      saved: [high.priority, high.potential],
      row: db.prepare("SELECT priority, potential, assess_reason, assessed_by FROM asset WHERE id = ?").get(assetA),
    }));
    /* 不传优先级 → 沿用该资产旧值；非法优先级同样不覆盖（旧值是 high）。 */
    out.push(row("asset 优先级回退", [
      store.assessAsset(id, { asset_id: assetB }).priority,
      store.assessAsset(id, { asset_id: assetA, priority: "urgent" }).priority,
    ]));

    /* ── 三、score_hit：落账 + 同服务封顶 + 自建账号 ───────────────────── */
    const hit1 = store.addScoreHit(id, {
      code: "wp6-custom", asset_id: assetA, port: 443, target: "https://demo-a.test/",
      evidence: "示例：管理员口令回显", recorded_by: "wp6-agent",
    });
    const hit2 = store.addScoreHit(id, {
      code: "wp6-custom", asset_id: assetA, port: 443, target: "https://demo-a.test/x",
      evidence: "示例：同一服务的第二档", points: 30, recorded_by: "wp6-agent",
    });
    const hit3 = store.addScoreHit(id, {
      code: "wp6-custom", asset_id: assetB, port: 22, target: "demo-host-b:22",
      evidence: "示例：自建账号", self_created: true, recorded_by: "wp6-agent",
    });
    out.push(row("score_hit 首条", projHit(hit1)));
    out.push(row("score_hit 同服务高分", [...projHit(hit2), hit2.demoted_hits.length]));
    out.push(row("score_hit 自建账号", projHit(hit3)));

    /* 落账行本身：这四条列是「写进去了」的直接证据；`points` 为 null 表示用点默认分值。 */
    const hits = db.prepare(`SELECT p.code AS point_code, h.asset_id, h.port, h.self_created,
        h.points, h.multiplier, h.recorded_by, h.target, length(h.evidence) AS evidence_len
      FROM score_hit h JOIN score_point p ON p.id = h.point_id ORDER BY h.id`).all();
    out.push(row("score_hit 落账行", hits.map((h) => [
      h.point_code, h.asset_id, h.port, h.self_created, h.points,
      h.multiplier, h.recorded_by, h.target, h.evidence_len,
    ])));
    out.push(row("score_hit 记分总览", summaryOf(store.listScorePoints(id))));

    return out;
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const HEADER = [
  "# dsh-purge 演练台事实库 characterization 快照（score_point / asset / score_hit 三条写路径）",
  "#",
  "# 列：name | payload",
  "#",
  "# 生成：test/redteam-store-snapshot.test.mjs（见文件头注释）",
  "# 更新：$env:DSH_PURGE_UPDATE_SNAPSHOT=1; node --test test/redteam-store-snapshot.test.mjs",
  "#",
  "# 输入全部是合成值：临时目录里的 SQLite、示例网段 198.51.100.0/24 与 203.0.113.0/24、演示主机名。",
  "# 不含真实靶标、真实资产、真实证据，也不含任何本机路径。",
  "#",
  "# 这个文件是三条写路径的唯一行为基线，锁的是**现状**，不是「现状正确」。",
  "# 有意改写入语义（启停、排序、优先级回退、落账口径）才允许出现差异；其余情况必须逐行不变。",
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

test("快照基线：演练台三条写路径 = 逐行快照不变", () => {
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
    `演练台写路径与快照基线不同（${diffs.length} 行）。\n`
      + `改的是写入语义时用 DSH_PURGE_UPDATE_SNAPSHOT=1 重生成并 review 每一行；\n`
      + `没打算改语义却出现差异，就是写坏了一条路径：\n${diffs.join("\n")}`,
  );
});

/**
 * 覆盖度护栏：快照必须真的踩到三条写路径，而不是「跑通了就算」。
 *
 * 判据取自快照正文与同一次运行的返回值 —— 手抄一份 case 清单不叫覆盖，
 * 清单能改，正文不能白改（改了就要 diff）。这里额外做三条**行为断言**：
 * 停用之后 `enabled` 真是 0、排序真是被 `sort_order` 推前、同服务第二条真是把第一条顶掉。
 * 它们和快照重叠是有意的：快照给「哪一行变了」，断言给「错在哪」。
 */
test("快照覆盖度：三条写路径都在，且启用/排序/封顶真的生效", () => {
  const text = normalize(HEADER + snapshotRows().join("\n") + "\n");
  for (const name of ["score 停用内置点", "score 启用并改排序", "asset 优先级写", "score_hit 落账行"]) {
    assert.ok(text.includes(`${name} | `), `快照里没有 ${name} 的 case —— 这条写路径没被覆盖`);
  }

  /* 同一份输入再跑一遍，单独验三条语义（不再依赖快照文本是否被顺手改过）。 */
  const root = mkdtempSync(join(tmpdir(), "dsh-purge-wp6-assert-"));
  const store = new RedteamStore(root);
  try {
    const { id } = store.openEngagement("wp6-snapshot-target", ["198.51.100.0/24"], { bindCurrent: false });
    const db = store.db(id);
    const point = db.prepare("SELECT id, code FROM score_point WHERE code = 'terminal-access'").get();
    const before = store.listScorePoints(id).summary.pointCount;

    store.saveScorePoint(id, { id: point.id, enabled: false });
    const disabled = store.listScorePoints(id);
    const offRow = db.prepare("SELECT enabled FROM score_point WHERE id = ?").get(point.id);
    assert.equal(offRow.enabled, 0, "停用后库里的 enabled 不是 0：参数被写成了常量（写死 enabled = 1）");
    assert.equal(disabled.summary.pointCount, before - 1, "停用后启用的得分点个数没有减少");
    assert.equal(
      disabled.items.filter((it) => it.enabled).length,
      before - 1,
      "面板上仍然把被停用的点算作启用",
    );

    store.saveScorePoint(id, { id: point.id, enabled: true, sort_order: -3 });
    const sorted = store.listScorePoints(id);
    assert.equal(
      db.prepare("SELECT sort_order FROM score_point WHERE id = ?").get(point.id).sort_order,
      -3,
      "sort_order 没有落库",
    );
    assert.ok(
      sorted.items.findIndex((it) => it.code === point.code) < sorted.items.length - 1,
      "sort_order 改了，但面板排序没有把它推到前面",
    );

    store.importBundle(id, {
      assets: [{ ip: "203.0.113.10", ports: [{ port: 443 }] }, { ip: "203.0.113.11", ports: [{ port: 22 }] }],
    });
    const assetA = db.prepare("SELECT id FROM asset WHERE ip = '203.0.113.10'").get().id;
    store.assessAsset(id, { asset_id: assetA, priority: "high" });
    assert.equal(
      db.prepare("SELECT priority FROM asset WHERE id = ?").get(assetA).priority,
      "high",
      "assessAsset 没有把优先级写进 asset 行",
    );

    store.saveScorePoint(id, { code: "wp6-custom", name: "wp6 演示得分点", points: 7 });
    const first = store.addScoreHit(id, {
      code: "wp6-custom", asset_id: assetA, port: 443, evidence: "示例：第一条", recorded_by: "wp6-agent",
    });
    const second = store.addScoreHit(id, {
      code: "wp6-custom", asset_id: assetA, port: 443, evidence: "示例：第二条", points: 30, recorded_by: "wp6-agent",
    });
    assert.equal(first.counted, true, "首条命中没有计分");
    assert.equal(second.counted, true, "同服务更高分的第二条没有计分");
    assert.equal(second.demoted_hits.length, 1, "同资产同端口的首条没有被顶掉（服务级封顶失效）");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM score_hit").get().n,
      2,
      "score_hit 落账条数不对",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
