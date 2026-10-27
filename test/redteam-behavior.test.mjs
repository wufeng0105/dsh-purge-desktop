/**
 * test/redteam-behavior.test.mjs — 演练台的三类**行为**覆盖：计分、存取、工具参数校验。
 *
 * ## 为什么这个文件非有不可
 *
 * 演练台 16879 行、12+ 页签，行为覆盖原先只有三份快照（`redteam-store-snapshot` /
 * `redteam-score-snapshot` / `redteam-log`）。快照锁的是「跑出来的行没变」，它说不出
 * 「这条规则对不对」：把 `dedup_scope` 判反、把 `UPDATE ... WHERE id = ?` 的参数写成常量，
 * 快照会变红但没人知道该改哪一边；更常见的是快照顺手重生成，差异就随着 review 一起过了。
 *
 * 这份用例只做一件事：**断言行为本身**。三类各四条以上，都拿合成夹具：
 *
 *   一、计分 —— 同一服务只算最高分、换一个维度分数就变、空集/全 0/封顶边界、
 *      自建账号不计分也不占位、G5/G6 倍率相乘；
 *   二、存取 —— 写 → 读回 → 改 → 删、两个靶标互不串味、缺库/关库的失败语义是抛错
 *      而不是静默空结果（后者比没有日志更危险：它看起来像「就是这样」）；
 *   三、工具参数校验 —— 声明在宿主认可的关键字子集下拒绝缺参/错类型/越界，合法参数
 *      真的走到执行体并落库。
 *
 * ## 两条硬约束
 *
 * - **不依赖真宿主**：SQLite 用 `mkdtempSync` 的临时目录（`node:sqlite` 由 store 自己开），
 *   `@deepseek-ai/dsh-tools` 用 `$DSH_HOME` 下的**最小替身**（`defineTool` 只识别声明、
 *   原样返回），所以本文件在任何一台机器上结论相同。
 * - **不引新依赖**（`CONTRACT-3`）、**不 import `lib/core.js`**（`ARCH-2`：redteam 与
 *   `lib/redteam` 的测试都不许回引 core）。
 *
 * 工具参数校验的判据边界写在第三节开头：宿主 `defineTool` 在调用前用 JSON Schema 校验
 * 实参（关键字子集 `type / properties / required / additionalProperties / items / enum /
 * const / oneOf`），本文件按同一子集解释 `parameters` 声明 —— 判的是**声明**拒绝这些输入，
 * 而不是「跑了一遍宿主」。
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* 诊断日志默认落 <DSH_HOME>/dsh-purge/logs：本文件的每一次写入都要在临时目录里自洽。
   diagLog 每条都重读环境变量，所以在 import store-core 之前设一次即可。 */
process.env.DSH_PURGE_LOG = "0";

const { RedteamStore, dispatch } = await import("../lib/redteam/store-core.js");
const { evaluateScoreBoard, scoreMultiplierOf, hitPointsOf, applyScoreCaps } =
  await import("../lib/redteam/score-rules.js");

/** 临时根目录 + store，跑完必关句柄再删目录（Windows 上打开着的 SQLite 删不掉）。 */
function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), "dsh-purge-wp12-"));
  const store = new RedteamStore(root);
  return Promise.resolve()
    .then(() => fn(store, root))
    .finally(() => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
}

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`工具回包不是 JSON：${String(text).slice(0, 200)}（${error.message}）`);
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   一、计分：规则、维度敏感与边界
   ══════════════════════════════════════════════════════════════════════════════ */

/** 一份最小的得分点元数据：两个服务级封顶的账号点 + 一个不封顶的边界点。 */
function scoreMeta() {
  return new Map([
    ["web-account-user", { rule: 5, cap: 20, dedup_scope: "service", points: 10 }],
    ["web-account-admin", { rule: 5, cap: 20, dedup_scope: "service", points: 20 }],
    ["boundary-break", { rule: 9, cap: 0, dedup_scope: "target", points: 30 }],
  ]);
}

/** 一行命中。`id` 参与同分择优（越小越早），所以显式给。 */
const hit = (id, over) => ({
  id,
  code: "web-account-user",
  points: 10,
  asset_id: 1,
  port: 443,
  target: "https://demo-a.test/",
  self_created: 0,
  ...over,
});

/* 服务键的口径：`scoreServiceKey` 优先用 `target` 的 authority（host[:port]），有 target 时
   `port` 列不参与 —— 所以夹具里要换「服务」，换 target 才有效。这条口径本身也是行为，
   写在这里免得下一个人拿 port 去造夹具然后以为去重坏了。 */
const sameServiceTarget = "https://demo-a.test/";
const otherServiceTarget = "https://demo-a.test:8443/";

test("计分：同一服务只算最高分，另一条被标 dedup（不是「两条都算」）", () => {
  const rows = [
    hit(1, { points: 10 }),
    hit(2, { points: 20, code: "web-account-admin" }),
  ];
  const board = evaluateScoreBoard({}, rows, { meta: scoreMeta(), names: new Map([[1, "demo-a"]]) });
  const counted = board.items.filter((row) => row.capped !== true);
  const capped = board.items.filter((row) => row.capped === true);
  assert.equal(counted.length, 1, "同一服务同一口径下只该有一条计分");
  assert.equal(counted[0].id, 2, "计分的必须是最高的那条（20 分），不是先记的那条");
  assert.equal(capped.length, 1);
  assert.equal(capped[0].capped_reason_kind, "dedup");
  assert.equal(capped[0].capped_by_id, 2);
});

test("计分：改一个维度（端口）判定就翻 —— 分数不是常量", () => {
  /* 上限放到 100：这一条只判**去重**这一件事，别让规则上限把结论盖掉（那是下一条）。 */
  const meta = new Map([["web-account-admin", { rule: 5, cap: 100, dedup_scope: "service", points: 20 }]]);
  const names = new Map([[1, "demo-a"]]);
  const sameService = evaluateScoreBoard({}, [
    hit(1, { port: 443, points: 20, code: "web-account-admin", target: sameServiceTarget }),
    hit(2, { port: 443, points: 20, code: "web-account-admin", target: sameServiceTarget }),
  ], { meta, names });
  const otherService = evaluateScoreBoard({}, [
    hit(1, { port: 443, points: 20, code: "web-account-admin", target: sameServiceTarget }),
    hit(2, { port: 8443, points: 20, code: "web-account-admin", target: otherServiceTarget }),
  ], { meta, names });
  assert.equal(sameService.items.filter((r) => r.capped !== true).length, 1, "同一服务只算一条");
  assert.equal(
    otherService.items.filter((r) => r.capped !== true).length,
    2,
    "换了服务（target 的 host:port 变了）两条都该计分 —— 判定跟着维度走，不是写死的",
  );
});

test("计分：空集 / 全 0 分 / 封顶边界（用到上限不算超）", () => {
  const meta = scoreMeta();
  const names = new Map([[1, "demo-a"]]);

  const empty = evaluateScoreBoard({}, [], { meta, names });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.caps.size, 0);

  /* 全 0 分但分属两个服务：不触发封顶、也不占上限用量（「记了但没分」不是「超了」）。 */
  const zero = evaluateScoreBoard({}, [
    hit(1, { points: 0, target: sameServiceTarget }),
    hit(2, { points: 0, port: 8443, target: otherServiceTarget }),
  ], { meta, names });
  assert.equal(zero.items.filter((r) => r.capped === true).length, 0, "0 分命中不该被标成超限");
  for (const tally of zero.caps.values()) assert.equal(tally.used, 0);

  /* 同服务两条 0 分：仍然按口径去重（一条不参与计分），但上限用量还是 0。 */
  const zeroSameService = evaluateScoreBoard({}, [
    hit(1, { points: 0, target: sameServiceTarget }),
    hit(2, { points: 0, target: sameServiceTarget }),
  ], { meta, names });
  assert.equal(zeroSameService.items.filter((r) => r.capped === true).length, 1, "同服务 0 分也是同一口径：只留一条");
  for (const tally of zeroSameService.caps.values()) assert.equal(tally.used, 0);

  /* 边界：cap = 20，两个**不同服务**各 10 分正好用满（不算超），第三个服务再来 1 分才超。
     这里换服务要换 target：`scoreServiceKey` 有 target 时按 authority 算（见上面的口径说明）。 */
  const exact = evaluateScoreBoard({}, [
    hit(1, { points: 10, target: sameServiceTarget }),
    hit(2, { points: 10, target: otherServiceTarget }),
  ], { meta: new Map([["web-account-user", { rule: 5, cap: 20, dedup_scope: "service", points: 10 }]]), names });
  const exactUsage = [...exact.caps.values()][0];
  assert.equal(exactUsage.used, 20, "正好用满上限时用量必须等于上限");
  assert.equal(exactUsage.capped, 0, "正好用满不算超限");

  const over = evaluateScoreBoard({}, [
    hit(1, { points: 10, target: sameServiceTarget }),
    hit(2, { points: 10, target: otherServiceTarget }),
    hit(3, { points: 1, target: "https://demo-a.test:9443/" }),
  ], { meta: new Map([["web-account-user", { rule: 5, cap: 20, dedup_scope: "service", points: 10 }]]), names });
  const overUsage = [...over.caps.values()][0];
  assert.equal(overUsage.used, 20, "超限的那条不许再抬高用量");
  assert.equal(overUsage.capped, 1);
});

test("计分：自建账号不计分、也不占位；倍率按 G5/G6 相乘", () => {
  const rows = [
    hit(1, { points: 10, self_created: 1 }),
    hit(2, { points: 20, code: "web-account-admin" }),
  ];
  const board = evaluateScoreBoard({}, rows, { meta: scoreMeta(), names: new Map([[1, "demo-a"]]) });
  const countable = board.items.filter((r) => Number(r.self_created) !== 1);
  assert.equal(countable.length, 1);
  assert.equal(
    board.items.find((r) => r.id === 1).capped,
    false,
    "自建账号本来就不计分：它不该以「被同服务顶掉」的形态出现（那会占掉别人的名额）",
  );

  const ipv6 = scoreMultiplierOf({ target: "https://[2001:db8::1]:8443/portal" });
  assert.equal(ipv6.multiplier, 3, "IPv6 成果 ×3（G6）");
  const large = scoreMultiplierOf({ data_scale: "large" });
  assert.equal(large.multiplier, 2, "数据规模超 1 亿 / 10TB ×2（G5）");
  const both = scoreMultiplierOf({ target: "[2001:db8::1]:22", data_scale: "knowledge-base" });
  assert.equal(both.multiplier, 6, "两条倍率同时命中要相乘（3 × 2）");
  assert.equal(hitPointsOf({ points: 10, multiplier: 3 }), 30, "实际分值 = 档位分 × 倍率");
});

test("计分：同一组输入两次评估结果相同（口径稳定，不掺随机）", () => {
  const rows = [hit(1, { points: 10 }), hit(2, { points: 20, code: "web-account-admin" })];
  const a = evaluateScoreBoard({}, rows.map((r) => ({ ...r })), { meta: scoreMeta(), names: new Map([[1, "demo-a"]]) });
  const b = evaluateScoreBoard({}, rows.map((r) => ({ ...r })), { meta: scoreMeta(), names: new Map([[1, "demo-a"]]) });
  assert.deepEqual(
    a.items.map((r) => [r.id, r.capped, r.capped_reason_kind]),
    b.items.map((r) => [r.id, r.capped, r.capped_reason_kind]),
  );
  /* 没有 asset_id、没有系统名时的兜底键必须稳定：用随机数会让两次评估给出不同结论。 */
  const loose = applyScoreCaps([{ id: 7, code: "x", points: 1, dedup_scope: null }], null, null);
  assert.equal(loose.items[0].capped, false);
});

/* ══════════════════════════════════════════════════════════════════════════════
   二、存取：写 → 读 → 改 → 删，隔离与失败语义
   ══════════════════════════════════════════════════════════════════════════════ */

test("存取：一条漏洞写进去、读得回来、改得动、字段缺失时回退旧值", async () => {
  await withStore((store) => {
    const { id } = store.openEngagement("wp12-crud", ["198.51.100.0/24"], { bindCurrent: false });
    const created = store.addVuln(id, {
      title: "示例：默认口令", severity: "high", target: "https://demo-a.test/",
      evidence: "示例证据", source: "curl",
    });
    assert.ok(Number(created.id) > 0, "写入没有拿到 id");

    const readBack = store.listVulns(id, { q: "默认口令" });
    assert.equal(readBack.items.length, 1, "写进去的漏洞读不回来");
    assert.equal(readBack.items[0].severity, "high");
    assert.equal(readBack.items[0].status, "candidate", "状态缺省应为 candidate");

    store.updateVuln(id, created.id, { severity: "low", status: "confirmed" });
    const after = store.listVulns(id, { q: "默认口令" }).items[0];
    assert.equal(after.severity, "low", "改严重度没有落库");
    assert.equal(after.status, "confirmed");
    assert.equal(after.title, "示例：默认口令", "没改的字段必须保留（COALESCE 语义）");

    /* 非法严重度：updateVuln 的口径是**不覆盖旧值**（与 assessAsset 的 priority 同一条规矩），
       而不是归一成 info、更不是抛错 —— 这条是现状语义，改它要连带改面板的档位显示。 */
    store.updateVuln(id, created.id, { severity: "严重" });
    assert.equal(
      store.listVulns(id, { q: "默认口令" }).items[0].severity,
      "low",
      "非法严重度覆盖了旧值：面板会出现一个不认识的档位",
    );
  });
});

test("存取：自建得分点写 → 列 → 删（删除之后列表里真的没有）", async () => {
  await withStore((store) => {
    const { id } = store.openEngagement("wp12-del", ["198.51.100.0/24"], { bindCurrent: false });
    const saved = store.saveScorePoint(id, {
      code: "wp12-custom", name: "wp12 演示得分点", category: "OTHER", points: 5,
      description: "演示用",
    });
    assert.ok(saved && saved.id, "自建点没有返回 id");
    const listed = store.listScorePoints(id, {}).items.find((item) => item.code === "wp12-custom");
    assert.ok(listed, "自建点没有出现在列表里");

    store.deleteScorePoint(id, saved.id);
    const gone = store.listScorePoints(id, {}).items.find((item) => item.code === "wp12-custom");
    assert.equal(gone, undefined, "删掉的自建点还在列表里");
  });
});

test("存取：两个靶标各写各的，互不串味", async () => {
  await withStore((store) => {
    const a = store.openEngagement("wp12-target-a", ["198.51.100.0/24"], { bindCurrent: false }).id;
    const b = store.openEngagement("wp12-target-b", ["203.0.113.0/24"], { bindCurrent: false }).id;
    store.addVuln(a, { title: "只属于 A 的漏洞", severity: "high" });
    store.addVuln(b, { title: "只属于 B 的漏洞", severity: "low" });

    const listA = store.listVulns(a, {}).items.map((item) => item.title);
    const listB = store.listVulns(b, {}).items.map((item) => item.title);
    assert.deepEqual(listA, ["只属于 A 的漏洞"]);
    assert.deepEqual(listB, ["只属于 B 的漏洞"]);
    assert.notEqual(a, b);
  });
});

test("存取：缺库与关库是**抛错**，不是静默空结果；写 op 的失败形状统一 { ok:false, error }", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-purge-wp12-bad-"));
  const store = new RedteamStore(root);
  try {
    assert.throws(() => store.db("no-such-engagement"), /engagement not found/, "缺库时应该抛出明确的错");
    assert.throws(
      () => store.listVulns("no-such-engagement", {}),
      /engagement not found/,
      "读类方法在缺库时静默返回空，会让「没这个靶标」看起来像「这个靶标没问题」",
    );

    const { id } = store.openEngagement("wp12-fail", ["198.51.100.0/24"], { bindCurrent: false });
    /* 三种失败都要落在同一个形状上：删一个不存在的得分点（store 抛）、缺必填的凭据
       （store 抛）、未知 op（dispatch 抛）。空参数的 addVuln 不算失败 —— 它本来就允许
       只写标题，拿它当失败用例会把「写成功了」误判成缺陷。 */
    for (const request of [
      { op: "deleteScorePoint", engagement: id, id: 999999 },
      { op: "addCredential", engagement: id, credential: { username: "wp12" } },
      { op: "definitelyUnknownOp", engagement: id },
    ]) {
      const result = dispatch(store, request);
      assert.deepEqual(
        Object.keys(result).sort(),
        ["error", "ok"],
        `${request.op} 的失败回包形状不是 { ok, error }：${JSON.stringify(result).slice(0, 120)}`,
      );
      assert.equal(result.ok, false, `${request.op} 的失败回包 ok 不是 false`);
      assert.equal(typeof result.error, "string", `${request.op} 的失败回包没有 error 文案`);
    }
  } finally {
    store.close();
    assert.throws(() => store.db("anything"), /.+/, "关库之后句柄不该还能用");
    rmSync(root, { recursive: true, force: true });
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
   三、工具参数校验
   ══════════════════════════════════════════════════════════════════════════════

   宿主的 `defineTool` 在调用执行体之前用 JSON Schema 校验实参，声明侧的关键字子集是
   `type / properties / required / additionalProperties / items / enum / const / oneOf`
   （`dsh-tools` 的 `validateJsonSchemaValue` 与 `parameterSchemaSpecToJsonSchema`）。
   所以「schema 拒绝缺参 / 错类型 / 越界」这句话的判据是：**声明在这个子集下判这些输入非法**。

   本文件据此做两件事：
     · `violationsOf(parameters, args)` —— 同一子集的最小解释器，判声明；
     · 真跑执行体 —— 合法参数走 `execute`，落到临时库，回包 ok:true。

   `@deepseek-ai/dsh-tools` 用 `$DSH_HOME` 下的最小替身：`defineTool(spec) => spec`。
   替身不做校验（校验在本文件里显式做），这样做的好处是结论与机器无关 —— 真宿主在不在
   这台机器上，断言都一样。
   */

/** 声明侧支持的关键字（多写一个宿主会忽略的关键字，就等于没有校验）。 */
const DECLARED_KEYWORDS = new Set([
  "type", "required", "enum", "items", "properties", "additionalProperties", "description",
]);

/**
 * 同一子集的最小解释器：返回违规项（空数组 = 通过）。
 *
 * 只看四件事：必填、类型、枚举、嵌套（对象/数组）。`description` 不参与判定。
 */
function violationsOf(parameters, args, path = "") {
  const out = [];
  const spec = parameters && typeof parameters === "object" ? parameters : {};
  const value = args === undefined || args === null ? {} : args;
  for (const [key, decl] of Object.entries(spec)) {
    const at = path === "" ? key : `${path}.${key}`;
    if (!decl || typeof decl !== "object") continue;
    const present = value !== null && typeof value === "object" && Object.hasOwn(value, key);
    if (decl.required === true && (!present || value[key] === undefined || value[key] === null)) {
      out.push(`${at} 缺失（必填）`);
      continue;
    }
    if (!present) continue;
    const actual = value[key];
    if (decl.enum && !decl.enum.includes(actual)) out.push(`${at} 不在 ${JSON.stringify(decl.enum)} 里`);
    if (decl.type === "string" && typeof actual !== "string") out.push(`${at} 不是字符串`);
    if (decl.type === "number" && (typeof actual !== "number" || !Number.isFinite(actual))) out.push(`${at} 不是数字`);
    if (decl.type === "boolean" && typeof actual !== "boolean") out.push(`${at} 不是布尔`);
    if (decl.type === "array") {
      if (!Array.isArray(actual)) {
        out.push(`${at} 不是数组`);
        continue;
      }
      if (decl.items && decl.items.type === "object") {
        actual.forEach((entry, index) => out.push(...violationsOf(decl.items.properties, entry, `${at}[${index}]`)));
      }
    }
    if (decl.type === "object" && decl.properties) {
      if (actual === null || typeof actual !== "object" || Array.isArray(actual)) out.push(`${at} 不是对象`);
      else out.push(...violationsOf(decl.properties, actual, at));
    }
  }
  return out;
}

/** 把 `$DSH_HOME` 指向一份最小替身宿主，再加载 tools.js（它按 DSH_HOME 找 dsh-tools）。 */
async function loadToolSpecs() {
  const home = mkdtempSync(join(tmpdir(), "dsh-purge-wp12-host-"));
  const pkgDir = join(home, "node_modules", "@deepseek-ai", "dsh-tools");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(home, "package.json"), JSON.stringify({ name: "wp12-fixture-host", private: true }), "utf8");
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-tools", version: "0.0.0-fixture", main: "index.js" }),
    "utf8",
  );
  /* 替身：只把 spec 原样返还。参数校验由本文件显式做（见上），所以替身不做任何判定。 */
  writeFileSync(join(pkgDir, "index.js"), "module.exports = { defineTool: (spec) => spec };\n", "utf8");

  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    /* 缓存破坏：同一进程里上一次用别的 DSH_HOME 加载过时，这里必须拿到新的一份。 */
    const mod = await import(`../lib/redteam/tools.js?wp12=${Date.now()}`);
    const specs = new Map();
    const store = new RedteamStore(home);
    const ctx = {
      redteam: store,
      logger: { warn() {}, info() {}, error() {} },
      effect(fn) { try { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; } catch { return () => {}; } },
      on() { return () => {}; },
      get() { return undefined; },
      tools: {
        register(spec) {
          if (spec && typeof spec.name === "string") specs.set(spec.name, spec);
          return spec;
        },
      },
    };
    mod.apply(ctx);
    return { specs, store, home };
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

test("工具参数校验：≥5 个工具的声明拒绝缺参 / 错类型 / 越界（含嵌套对象）", async () => {
  const { specs, store, home } = await loadToolSpecs();
  try {
    const wanted = [
      "redteam_asset_add",
      "redteam_asset_query",
      "redteam_asset_get",
      "redteam_asset_link",
      "redteam_vuln_add",
    ];
    for (const name of wanted) assert.ok(specs.has(name), `工具 ${name} 没有注册：取样点变了，判据已失效`);
    assert.ok(specs.size >= wanted.length + 10, `只抓到 ${specs.size} 个工具，工具集可能没装配完`);

    /* 每个工具：声明里每个 `required: true` 的字段都真的被要求；枚举字段拒绝域外值。
       纯查询类（`redteam_asset_query`）本来就没有必填项，那就只剩枚举这一半 —— 断言
       随声明走，不硬给所有工具套同一个形状。 */
    let withRequired = 0;
    for (const name of wanted) {
      const { parameters } = specs.get(name);
      const required = Object.entries(parameters || {}).filter(([, decl]) => decl && decl.required === true).map(([key]) => key);
      if (required.length > 0) withRequired += 1;
      for (const key of required) {
        const violations = violationsOf(parameters, {});
        assert.ok(
          violations.some((line) => line.startsWith(`${key} 缺失`)),
          `${name} 的声明没有拒绝缺参 ${key}（实得 ${JSON.stringify(violations)}）`,
        );
      }
      const enumField = Object.entries(parameters || {}).find(([, decl]) => decl && Array.isArray(decl.enum));
      if (enumField) {
        const [key, decl] = enumField;
        const violations = violationsOf(parameters, { [key]: "definitely-not-in-enum" });
        assert.ok(
          violations.some((line) => line.includes(`${key} 不在`)),
          `${name}.${key} 的 enum 没有拒绝域外值（可选值 ${JSON.stringify(decl.enum)}）`,
        );
      }
    }
    assert.ok(withRequired >= 4, `只有 ${withRequired} 个工具声明了必填字段：覆盖面不够，判据形同虚设`);

    /* 错类型：`redteam_asset_get` 的 id 是 number，传字符串要被拒。 */
    assert.ok(
      violationsOf(specs.get("redteam_asset_get").parameters, { id: "12" }).some((line) => line.includes("id 不是数字")),
      "id 传字符串没有被拒：类型校验形同虚设",
    );

    /* 嵌套对象：`ports[]` 里的 `port` 是必填 number —— 空对象数组必须被拒。 */
    const nested = violationsOf(specs.get("redteam_asset_add").parameters, {
      ip: "203.0.113.10", provenance: "passive", ports: [{}],
    });
    assert.ok(
      nested.some((line) => line.startsWith("ports[0].port 缺失")),
      `嵌套数组的必填没有生效（实得 ${JSON.stringify(nested)}）`,
    );
    const nestedType = violationsOf(specs.get("redteam_asset_add").parameters, {
      ip: "203.0.113.10", provenance: "passive", ports: [{ port: "443" }],
    });
    assert.ok(nestedType.some((line) => line.includes("ports[0].port 不是数字")), "嵌套数组里传了字符串端口，没有被拒");

    /* 声明里不许出现宿主不认识的关键字：`min` / `max` / `pattern` 这类会被静默忽略。
       注意形状 —— 顶层的键是**属性名**（每个工具自己的参数），关键字在属性声明里面；
       把顶层键也当关键字扫，会把每个工具的参数名都报成「不认识的关键字」。 */
    const unknown = [];
    const walkProps = (props, path) => {
      for (const [prop, decl] of Object.entries(props || {})) {
        for (const [key, value] of Object.entries(decl || {})) {
          if (!DECLARED_KEYWORDS.has(key)) unknown.push(`${path}.${prop}.${key}`);
          if (key === "properties" && value && typeof value === "object") walkProps(value, `${path}.${prop}.properties`);
          if (key === "items" && value && value.properties) walkProps(value.properties, `${path}.${prop}.items`);
        }
      }
    };
    for (const [name, spec] of specs) walkProps(spec.parameters, name);
    assert.deepEqual(unknown, [], `声明用了宿主不认的关键字（会被静默忽略，等于没校验）：${unknown.join("、")}`);

    /* 合法参数真的走到执行体：资产落库，回包 ok:true。 */
    const engagement = store.openEngagement("wp12-tools", ["203.0.113.0/24"], { bindCurrent: false }).id;
    const valid = {
      engagement,
      ip: "203.0.113.10",
      provenance: "passive",
      tool: "wp12-fixture",
      ports: [{ port: 443, service: "https" }],
      names: [{ name: "demo-a.test" }],
    };
    assert.deepEqual(violationsOf(specs.get("redteam_asset_add").parameters, valid), [], "合法参数被判非法");
    const result = json(await specs.get("redteam_asset_add").execute(valid, {}));
    assert.equal(result.ok, true, "合法参数没有执行成功：" + JSON.stringify(result).slice(0, 200));
    assert.equal(result.asset.ip, "203.0.113.10");
    assert.equal(
      store.listAssets(engagement, { ip: "203.0.113.10" }).items.length,
      1,
      "合法参数通过了校验，但没有真的落库",
    );
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("工具参数校验：执行期失败是结构化的 { ok:false, error_kind:'bad_input' }", async () => {
  const { specs, store, home } = await loadToolSpecs();
  try {
    /* 显式指向一个不存在的靶标：store 抛 `engagement not found`，捕获层要把它收成
       JSON 形态的结构化失败 —— 而不是抛给模型（抛出去那一次调用通常就放弃了）。 */
    const tool = specs.get("redteam_asset_add");
    const payload = json(await tool.execute({
      engagement: "no-such-engagement",
      ip: "203.0.113.11",
      provenance: "passive",
    }, {}));
    assert.equal(payload.ok, false, "靶标不存在时不该回 ok:true");
    assert.equal(payload.error_kind, "bad_input", "「对象不存在」属于可换参数重试的那一类");
    assert.match(String(payload.error), /not found|不存在/, "错误文案要指出找不到的是什么");
    assert.equal(typeof payload.hint, "string", "结构化失败要带一句下一步提示");
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
