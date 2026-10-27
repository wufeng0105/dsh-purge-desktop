/**
 * test/state-contract.test.mjs — 状态层契约：每块字段唯一声明，消费者只读契约字段。
 *
 * 为什么单独立一份：同一份状态原先有三个消费者各算一遍 —— `/dsh-purge/status` 的
 * `display_* ?? patches_*`、CLI 的 `patch_status[id] || "unknown"`、演练台的
 * `envAdaptStatus` 原样透出。三处各写一份派生，改一处口径会漂三处，而「漂了」本身
 * 没有任何症状：三处都自洽，只是说的不是同一件事。
 *
 * 这份用例守四件事：
 *   一、声明：`STATE_BLOCKS` 里每个字段都有类型、唯一生产者、派生方式（内容 / 痕迹）与
 *      副本数；生产者文件必须真实存在。前五块（patch / audit / skills / env / preset）
 *      由 `statusBlocks()` 合成，`health` 是另一条响应 —— 同一声明处，两条响应。
 *   二、禁止自算：消费者源码里不许再出现派生量的算式。用一个「自算夹具」证明探测器
 *      真的能认出这种写法 —— 否则「仓库里零命中」可能只是探测器坏了。
 *   三、响应形状：`/dsh-purge/status` 的顶层字段必须**恰好**是「五块镜像 + 响应信封 +
 *      契约外 legacy」三张表之和；`/dsh-purge/health` 的顶层键与组内键同理，判据是同一份
 *      `keyDiff` 包出来的 `healthFieldReport`。
 *   四、文档逐行：每块的小节表与 `STATE_BLOCKS` 的字段 / 生产者 / 派生 / 副本数一致。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import * as contract from "../lib/state/contract.js";
import { spreadsIn, topLevelKeysOf } from "./helpers/source-object-keys.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
/** `statusBlocks()` 合成的五块：进 `/dsh-purge/status`。 */
const STATUS_BLOCKS = ["patch", "audit", "skills", "env", "preset"];
/** 声明里的全部块：上面五块 + `/dsh-purge/health` 那一块。 */
const DECLARED_BLOCKS = [...STATUS_BLOCKS, "health"];

function sourceOf(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const CONSUMERS = {
  "lib/index.js": sourceOf("lib/index.js"),
  "bin/dsh-purge.js": sourceOf("bin/dsh-purge.js"),
  "lib/redteam/ui.js": sourceOf("lib/redteam/ui.js"),
};

/**
 * 派生量的自算写法。三条都对应一次真实漂移：
 *   · `tallyDisplayPatches(` 自己把分组行再数一遍（与 gatherState 的计数两套口径）；
 *   · `summarizeLayers(` 自己折三层结论（与审计轨的层结论两套口径）；
 *   · `display_x ?? patches_x` 自己写「有界面计数就用它」的回退（面板与 CLI 各写一份）；
 *   · 按 `patch_status` 过滤后再取长度（待应用清单的第三份实现）。
 * 普通 `report.filter(...)` 不算：那是某一轮 apply 的逐条结果，不是宿主状态。
 */
const SELF_COMPUTED = [
  { re: /tallyDisplayPatches\s*\(/g, why: "自己重算分组计数" },
  { re: /summarizeLayers\s*\(/g, why: "自己重算三层结论" },
  { re: /display_(?:applied|pending|skipped|failed|ready|total)\s*\?\?/g, why: "自己写显示计数的回退" },
  { re: /\.filter\([^;\n]*patch_status[^;\n]*\)\.length/g, why: "自己按状态过滤取长度" },
];

/** @param {Array<{name:string, source:string}>} sources */
function selfComputedHits(sources) {
  const hits = [];
  for (const { name, source } of sources) {
    for (const rule of SELF_COMPUTED) {
      for (const match of source.matchAll(rule.re)) {
        const line = source.slice(0, match.index).split("\n").length;
        hits.push(`${name}:${line} ${rule.why}`);
      }
    }
  }
  return hits;
}

/** 状态夹具：两份补丁、一份判成已生效（内容来源）、一份判成待应用（痕迹来源）。 */
function stateFixture() {
  return {
    surface: "desktop",
    dsh_home: "C:/fixture/home",
    ai_base: "C:/fixture/host",
    patch_status: { 1: "applied", 2: "pending" },
    patch_reasons: { 2: "旧账本没有内容指纹，只能按痕迹判" },
    patch_sources: { 1: "content", 2: "marker" },
    patches_applied: 2,
    patches_pending: 0,
    patches_skipped: 0,
    patches_ready: 2,
    patches_na: 0,
    patches_total: 2,
    display_patches: [
      { id: 1, ids: [1], layer: "代码", status: "applied", title: "补丁一" },
      { id: 2, ids: [2], layer: "代码", status: "pending", title: "补丁二" },
    ],
    display_applied: 1,
    display_pending: 1,
    display_skipped: 0,
    display_failed: 0,
    display_ready: 1,
    display_total: 2,
  };
}

const PATCHES = [
  { id: 1, name: "ONE", layer: "代码", layer_en: "Code" },
  { id: 2, name: "TWO", layer: "代码", layer_en: "Code" },
];

test("六块字段声明齐全：类型 / 唯一生产者 / 派生方式 / 副本数", () => {
  assert.deepEqual(Object.keys(contract.STATE_BLOCKS).sort(), [...DECLARED_BLOCKS].sort());
  for (const block of DECLARED_BLOCKS) {
    const fields = contract.STATE_BLOCKS[block];
    assert.ok(fields && Object.keys(fields).length > 0, `${block} 块没有任何字段声明`);
    for (const [field, spec] of Object.entries(fields)) {
      assert.equal(typeof spec.type, "string", `${block}.${field} 缺类型`);
      assert.ok(["content", "trace"].includes(spec.derivation), `${block}.${field} 的派生方式只能是 content / trace`);
      assert.ok(fs.existsSync(path.join(ROOT, spec.producer)), `${block}.${field} 的生产者不存在：${spec.producer}`);
      assert.ok(Number.isInteger(spec.copies) && spec.copies >= 1, `${block}.${field} 的副本数必须是正整数`);
    }
  }
  // 声明是六块，`statusBlocks()` 只合成前五块：health 走自己的响应。两边混了就说明
  // 有人把「同一声明处」读成了「同一条响应」。
  assert.deepEqual(
    Object.keys(contract.STATE_BLOCKS).filter((name) => name !== "health").sort(),
    [...STATUS_BLOCKS].sort(),
    "除 health 之外的块必须正好是 statusBlocks() 合成的那五块",
  );
});

test("patch 块：来源、原因、计数、行数据与待应用清单都从同一份状态算出", () => {
  const blocks = contract.statusBlocks({ state: stateFixture(), patches: PATCHES });
  assert.equal(blocks.patch.source, "content", "有内容指纹的判据要把来源说成 content");
  assert.deepEqual(blocks.patch.sources, { 1: "content", 2: "marker" });
  assert.equal(blocks.patch.reasons[2], "旧账本没有内容指纹，只能按痕迹判");
  // 两种口径各一份：`raw` 按补丁号（两条），`display` 按展示行（夹具里没有分组，也是两行）。
  assert.deepEqual(blocks.patch.counts.raw, {
    applied: 1,
    pending: 1,
    skipped: 0,
    failed: 0,
    other: 0,
    ready: 1,
    na: 0,
    total: 2,
    pendingIds: ["2"],
  });
  assert.deepEqual(blocks.patch.counts.display, {
    applied: 1,
    pending: 1,
    unmatched: 0,
    skipped: 0,
    failed: 0,
    ready: 1,
    total: 2,
  });
  assert.deepEqual(blocks.patch.rows.map((row) => row.id), [1, 2]);
  assert.deepEqual(blocks.patch.pendingIds, ["2"], "待应用清单要把补丁 id 统一成字符串");
  assert.deepEqual(blocks.patch.names, { 1: "ONE", 2: "TWO" });
  assert.ok(blocks.patch.layers && blocks.patch.layers.code, "三层结论没有折出来");
});

test("宿主未定位时 patch 块退回 override：不拿空状态冒充「已生效」", () => {
  const blocks = contract.statusBlocks({ state: { ai_base: "", patch_status: {} }, patches: PATCHES });
  assert.equal(blocks.patch.source, "override");
  assert.equal(blocks.patch.counts.raw.total, 0);
  assert.equal(blocks.patch.counts.raw.na, PATCHES.length, "宿主未定位时全部补丁都算不可用，不是 0 条");
  assert.equal(blocks.patch.counts.display.total, 0, "没有展示行时展示口径是 0，不是「全部已生效」");
  for (const patch of PATCHES) assert.equal(blocks.patch.status[patch.id], "na");
});

test("五块同一次聚合：缺省的 audit / skills / env / preset 只给声明字段", () => {
  const blocks = contract.statusBlocks({ state: stateFixture() });
  for (const name of STATUS_BLOCKS) assert.ok(blocks[name], `聚合结果缺 ${name} 块`);
  assert.equal(blocks.env.ready, false, "没给环境数据时不许默认就绪");
  assert.equal(blocks.skills.total, 0);
  assert.equal(blocks.preset.phase, "");
  assert.equal(blocks.audit.events, 0);
  assert.equal(blocks.audit.recorded, false);
  assert.ok(!("health" in blocks), "health 不在 statusBlocks 里：它是另一条响应，别混进同一个信封");
});

test("skills / env / preset 块的聚合只做字段选择与计数", () => {
  const skills = contract.skillsBlock({
    dir: "$DSH_HOME/skills",
    items: [
      { id: "a", valid: true, fromPlugin: true },
      { id: "b", valid: false },
    ],
  });
  assert.equal(skills.total, 2);
  assert.equal(skills.invalid, 1);
  assert.equal(skills.fromPlugin, 1);
  assert.equal(skills.items.length, 2, "块不许裁剪条目本身（那是各自内部实现的事）");

  const env = contract.envBlock({
    ready: true,
    reason: "configured",
    message: "ok",
    kali: false,
    skipped: false,
    configured: true,
    found: 3,
    missing: 1,
    total: 4,
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "configured", "found", "kali", "message", "missing", "ready", "reason", "skipped", "total",
  ]);
  assert.equal(env.ready, true);

  const preset = contract.presetBlock({ ok: false, phase: "registered-broken", broken: "toolFilter", at: "2026-01-01" });
  assert.equal(preset.phase, "registered-broken");
  assert.equal(preset.ok, false);
  assert.equal(preset.broken, "toolFilter");
});

test("红灯：消费者自算派生量必须能被检出，仓库里的三个消费者必须为零", () => {
  const fixture = [{
    name: "fixture",
    source: [
      "const tally = core.tallyDisplayPatches(rows);",
      "const applied = state.display_applied ?? state.patches_applied;",
      "const pending = core.ALL_PATCHES.filter((p) => state.patch_status[p.id] === \"pending\").length;",
      "const layers = summarizeLayers(core.ALL_PATCHES, state.patch_status);",
    ].join("\n"),
  }];
  assert.equal(selfComputedHits(fixture).length, 4, "探测器认不出自算派生量的夹具，判据本身失效了");
  assert.deepEqual(
    selfComputedHits(Object.entries(CONSUMERS).map(([name, source]) => ({ name, source }))),
    [],
    "消费者仍在自算派生量：挪进 lib/state/contract.js，读契约字段",
  );
});

test("文档与声明逐行一致：字段 / 生产者 / 派生 / 副本数", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "状态层契约.md"), "utf8");
  const titles = {
    patch: "## 3. patch 块",
    audit: "## 4. audit 块",
    skills: "## 5. skills 块",
    env: "## 6. env 块",
    preset: "## 7. preset 块",
    health: "## 8. health 块",
  };
  for (const [block, title] of Object.entries(titles)) {
    const start = doc.indexOf(title);
    assert.ok(start >= 0, `docs/状态层契约.md 缺小节：${title}`);
    const rest = doc.slice(start + title.length);
    const end = rest.indexOf("\n## ");
    const section = end >= 0 ? rest.slice(0, end) : rest;
    const documented = {};
    for (const line of section.split("\n")) {
      if (!line.trimStart().startsWith("|")) continue;
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (cells.length !== 5) continue;
      const field = cells[0].replace(/`/g, "");
      if (!field || /^[-: ]+$/.test(field) || field === "字段") continue;
      documented[field] = {
        producer: cells[2].replace(/`/g, ""),
        derivation: cells[3],
        copies: Number(cells[4]),
      };
    }
    const declared = contract.STATE_BLOCKS[block];
    assert.deepEqual(Object.keys(documented).sort(), Object.keys(declared).sort(), `${block} 块的文档字段与声明不一致`);
    for (const [field, spec] of Object.entries(declared)) {
      assert.deepEqual(
        documented[field],
        { producer: spec.producer, derivation: spec.derivation, copies: spec.copies },
        `${block}.${field} 的文档与 STATE_BLOCKS 不一致`,
      );
    }
  }
});

test("三个消费者都经契约取字段，不再直接 import 派生实现", () => {
  assert.ok(CONSUMERS["lib/index.js"].includes("contract.statusBlocks("), "status 端点没走契约聚合");
  assert.ok(CONSUMERS["bin/dsh-purge.js"].includes("contract.patchBlock("), "CLI 没走 patch 块");
  assert.ok(CONSUMERS["lib/redteam/ui.js"].includes("contract.envBlock("), "演练台的环境闸门没走 env 块");
  assert.ok(CONSUMERS["lib/redteam/ui.js"].includes("contract.skillsBlock("), "演练台的技能目录没走 skills 块");
  assert.ok(
    !CONSUMERS["lib/index.js"].includes('from "./layer-rows.js"'),
    "lib/index.js 仍直接 import 分节行实现：分组与过滤只许在契约里做一次",
  );
});

/** status 端点响应对象的取样点：`const payload = {` 之后那个对象字面量。 */
const STATUS_PAYLOAD_MARKER = "const payload = {";

test("status 端点：顶层字段恰好是「五块镜像 + 响应信封 + 契约外 legacy」三张表", () => {
  const source = CONSUMERS["lib/index.js"];
  const keys = topLevelKeysOf(source, STATUS_PAYLOAD_MARKER);
  assert.ok(keys.length > 10, `从 lib/index.js 抽不到 status 响应字段（实得 ${keys.length} 个）：取样点变了，判据已失效`);
  // 展开行在源码文本里读不到键名：留着它，「多返回了什么」就永远查不出来。
  assert.deepEqual(
    spreadsIn(source, STATUS_PAYLOAD_MARKER),
    [],
    "status 响应里有 ... 展开行：展开的键名静态读不到，改成显式键再登记到契约",
  );

  const report = contract.statusFieldReport(keys);
  assert.deepEqual(
    report.undeclared,
    [],
    `这些字段在 /dsh-purge/status 里返回，却没在契约三张表里登记：${report.undeclared.join("、")}`
      + "—— 要么进 STATE_BLOCKS，要么进 STATUS_LEGACY_FIELDS 并写明「下一轮收编」",
  );
  assert.deepEqual(
    report.missing,
    [],
    `这些字段登记了、端点却不再返回：${report.missing.join("、")}——声明表过时了，删掉或补回响应`,
  );

  // 红灯夹具：探测器认不出未登记字段，就不能拿「零差额」当结论。
  const bogus = contract.statusFieldReport(["shim_cmd", "definitely_not_declared"]);
  assert.deepEqual(bogus.undeclared, ["definitely_not_declared"], "探测器认不出未登记字段，判据本身失效了");
});

test("契约外状态：每个 legacy 字段都写了「下一轮收编」，文档里也逐条在册", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "状态层契约.md"), "utf8");
  const legacy = Object.entries(contract.STATUS_LEGACY_FIELDS);
  assert.ok(legacy.length > 0, "legacy 表空了：要么全收编了，要么这一层被删了 —— 两种都要显式记账");
  for (const [field, note] of legacy) {
    assert.ok(note.includes("下一轮收编"), `legacy.${field} 没写「下一轮收编」：不收编也要说得出口`);
    assert.ok(doc.includes(`\`${field}\``), `docs/状态层契约.md 没登记 legacy 字段 ${field}`);
  }
  // 三张表不许重叠：同一个字段既是块镜像又是 legacy，就等于有两份归属。
  const blocks = new Set(Object.keys(contract.STATUS_BLOCK_FIELDS));
  const envelope = new Set(Object.keys(contract.STATUS_ENVELOPE_FIELDS));
  const overlap = legacy.map(([field]) => field).filter((field) => blocks.has(field) || envelope.has(field));
  assert.deepEqual(overlap, [], `这些字段同时属于 legacy 与块 / 信封：${overlap.join("、")}`);
  // 块镜像只能挂在真的存在的块上：写错块名会让「值来自哪一块」变成一句空话。
  const badBlocks = [...new Set(Object.values(contract.STATUS_BLOCK_FIELDS))].filter((block) => !DECLARED_BLOCKS.includes(block));
  assert.deepEqual(badBlocks, [], `STATUS_BLOCK_FIELDS 指向不存在的块：${badBlocks.join("、")}`);
  // health 的信封表与状态那三张表不许重叠：同一个键挂两处，判据就会各判各的。
  // 两个例外是同一件事实：`ok`（这次查询成不成）与 `dsh_home`（落点解析），两条响应
  // 里说的是同一件事，各写一份反而会漂。
  const healthKeys = new Set(contract.healthDeclaredFields());
  const crossOverlap = [...healthKeys].filter((key) => blocks.has(key) || envelope.has(key) || key in contract.STATUS_LEGACY_FIELDS);
  assert.deepEqual(
    crossOverlap,
    ["ok", "dsh_home"],
    `health 顶层键与状态端点的表重叠：${crossOverlap.join("、")}（只允许 ok 与 dsh_home —— 同一件事实，两处各写一份就会漂）`,
  );
});

test("端点自己会拒答形状不符的响应：判据在运行期也挂着，不只在测试里", () => {
  const source = CONSUMERS["lib/index.js"];
  assert.ok(source.includes("contract.statusFieldReport("), "status 端点没检查响应形状：文档与门禁之外还缺运行期这一道");
  assert.ok(
    /shape\.undeclared\.length > 0 \|\| shape\.missing\.length > 0/.test(source),
    "端点拿到字段差额却没有据此拒答 —— 那就只是把差额算了一遍",
  );
  assert.ok(source.includes("contract.healthFieldReport("), "health 端点没检查响应形状：新读面又没有运行期判据，等于第二个不受管的门");
});

/**
 * health 端点的取样点：`const healthPayload = {` 之后那个对象字面量；组内再用
 * `install: {` / `logs: {` 各取一次。marker 必须带变量名 —— 同一条闭包里 `/status`
 * 也有一个 `payload`，只写 `const payload = {` 会取到另一个对象（而且看起来还像成功）。
 */
const HEALTH_PAYLOAD_MARKER = "const healthPayload = {";

test("health 端点：顶层键恰好是信封表，组内键恰好是 STATE_BLOCKS.health 声明的那些", () => {
  const source = CONSUMERS["lib/index.js"];
  const top = topLevelKeysOf(source, HEALTH_PAYLOAD_MARKER);
  assert.ok(top.length >= 4, `从 lib/index.js 抽不到 health 响应字段（实得 ${top.length} 个）：取样点变了，判据已失效`);
  assert.deepEqual(
    spreadsIn(source, HEALTH_PAYLOAD_MARKER),
    [],
    "health 响应里有 ... 展开行：展开的键名静态读不到，改成显式键再登记到契约",
  );
  const installKeys = topLevelKeysOf(source, "install: {");
  const presetCopyKeys = topLevelKeysOf(source, "presetCopy: {");
  const logsKeys = topLevelKeysOf(source, "logs: {");
  assert.ok(installKeys.length > 0, "抽不到 install 组内的键");
  assert.ok(presetCopyKeys.length > 0, "抽不到 presetCopy 组内的键");
  assert.ok(logsKeys.length > 0, "抽不到 logs 组内的键");

  // 用运行期那份判据核一遍源码里的形状：两侧都空才算登记齐。
  const payload = { ok: true, dsh_home: "x", install: {}, presetCopy: {}, logs: {} };
  for (const key of installKeys) payload.install[key] = 0;
  for (const key of presetCopyKeys) payload.presetCopy[key] = 0;
  for (const key of logsKeys) payload.logs[key] = {};
  for (const key of top) if (!(key in payload)) payload[key] = null;
  const report = contract.healthFieldReport(payload);
  assert.deepEqual(report.undeclared, [], `health 回包里有未登记字段：${report.undeclared.join("、")}——进 STATE_BLOCKS.health 或 HEALTH_RESPONSE_FIELDS`);
  assert.deepEqual(report.missing, [], `这些字段登记了、端点却不返回：${report.missing.join("、")}——声明表过时了，删掉或补回响应`);
});

test("红灯：health 的未登记字段必须被拒答（探测器认不出就说明判据失效）", () => {
  // 齐字段的载荷按声明本身拼：组名与组内键都从 STATE_BLOCKS.health 取，
  // 加一组新字段时这里不用跟着改，漏拼反而会自己红。
  const base = { ok: true, dsh_home: "x" };
  for (const key of Object.keys(contract.STATE_BLOCKS.health)) {
    const [group, leaf] = key.split(".");
    if (!base[group]) base[group] = {};
    base[group][leaf] = 0;
  }
  assert.deepEqual(contract.healthFieldReport(base), { undeclared: [], missing: [] }, "齐字段的载荷不该有差额");
  assert.deepEqual(
    contract.healthFieldReport({ ...base, surprise: 1 }).undeclared,
    ["surprise"],
    "顶层多一个字段没被报出来 —— 运行期就不会拒答",
  );
  const leaked = { ...base, install: { ...base.install, extra: 1 } };
  assert.deepEqual(
    contract.healthFieldReport(leaked).undeclared,
    ["install.extra"],
    "组内多一个字段没被报出来 —— 设置页读的正是组内字段，那才是会出事的地方",
  );
  const dropped = { ...base, logs: { audit: {}, diag: {} } };
  assert.deepEqual(
    contract.healthFieldReport(dropped).missing,
    ["logs.internal"],
    "少返回一个声明过的字段没被报出来 —— 客户端只会画出一个空值",
  );
});
