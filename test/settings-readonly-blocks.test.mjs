/**
 * test/settings-readonly-blocks.test.mjs — 设置页那三块只读：数据只从服务端取，页面不再算一遍。
 *
 * ## 为什么要一条「页面不自算」的用例
 *
 * 这一页的历史病根是**同一屏两个数**：摘要行数 `patches_applied`、补丁分节数台账行、
 * 失败数又自己遍历一份状态表数 `unmatched`。三处各自自洽，只是可能不是同一件事，而
 * 「不一样」没有任何症状 —— 用户看到的是两个都像真的数字。
 *
 * 收编之后规矩只有一条：**派生量在服务端算一次，页面只画**。不是风格问题：计数一旦在
 * 客户端再算一遍，改口径就要改两处，而漏掉的那一处不会报错。
 *
 * ## 判据
 *
 *   一、客户端片段（`lib/client-src/**` + 演练台片段 + 产物）里不许出现 `patch_status[`
 *      的再聚合；`layerRows` 只许整串交给渲染（同一行出现 filter / reduce / length /
 *      tally 就算命中）。
 *   二、新三块消费的字段都在服务端：审计读既有 `/dsh-purge/audit` 的 `?tail=` / `?run=` /
 *      `?check`（只 GET，不新增写路径），健康与日志读 `/dsh-purge/health`，预设读
 *      `/dsh-purge/status` 的 `preset` 块。
 *   三、文案键在两份词典里都在：`t("…")` 拼错的键不会报错，只会把键名印到界面上。
 *   四、探测器自身有红灯夹具：认不出「客户端自算」的探测器，等于判据已经失效。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import * as contract from "../lib/state/contract.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** 界面源：片段 + 演练台片段 + 产物（产物由源装配，扫它是为了抓「手改产物」）。 */
function uiSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".js")) out.push(rel);
    }
  };
  walk("lib/client-src");
  out.push("lib/redteam/client.js", "client.js");
  return out;
}

/**
 * 客户端自算的两种形状。
 *
 * 判 `patch_status[` 的全部出现：这一页上没有任何一处**该**读它 —— 状态与计数都走
 * 契约给出的顶层字段。判 `layerRows` 时只抓「同一行既取它又聚合」：把整串交给渲染是
 * 它唯一的正确用法。
 */
function selfComputedHits(files) {
  const hits = [];
  for (const { name, source } of files) {
    source.split("\n").forEach((line, index) => {
      if (line.includes("patch_status[")) hits.push(`${name}:${index + 1} 客户端自己按状态表聚合`);
      if (/layerRows/.test(line) && /\.(filter|reduce|map|forEach|sort)\(|\.length\b|tally/.test(line)) {
        hits.push(`${name}:${index + 1} 客户端对 layerRows 再聚合`);
      }
    });
  }
  return hits;
}

test("红灯夹具：客户端自算必须能被检出（否则「零命中」只是探测器坏了）", () => {
  const fixture = [{
    name: "fixture",
    source: [
      "const failed = Object.keys(s.patch_status).filter((id) => s.patch_status[id] === \"unmatched\").length;",
      "const rows = state.layerRows.reduce((acc, row) => acc + row.total, 0);",
    ].join("\n"),
  }];
  assert.equal(selfComputedHits(fixture).length, 2, "探测器认不出自算夹具，本条用例的判据本身失效了");
});

test("客户端片段与产物里零自算：patch_status[ 与 layerRows 的聚合都不出现", () => {
  const files = uiSources().map((rel) => ({ name: rel, source: read(rel) }));
  assert.deepEqual(
    selfComputedHits(files),
    [],
    "页面在自算派生量：计数与分组由服务端算一次（契约字段），页面只画",
  );
});

test("三块只读的数据来源：审计走既有端点，健康/日志走只读端点，预设读 status 的 preset 块", () => {
  const audit = read("lib/client-src/settings/diagnostics-tab.js");
  assert.ok(audit.includes("/dsh-purge/audit?tail=20"), "审计块的「最近 N 条」没走既有端点的 tail 查询");
  assert.ok(audit.includes("/dsh-purge/audit?run="), "审计块的「查某一轮」没走既有端点的 run 查询");
  assert.ok(audit.includes("/dsh-purge/audit?check"), "审计块没有对账 `audit check` 的结论");
  assert.ok(!/method:\s*"(POST|PUT|PATCH|DELETE)"/.test(audit), "审计块出现了写请求：这一块是只读的");

  const health = read("lib/client-src/settings/diagnostics-tab.js");
  assert.ok(health.includes("/dsh-purge/health"), "健康/日志块没有读只读端点");
  assert.ok(!/method:\s*"(POST|PUT|PATCH|DELETE)"/.test(health), "健康/日志块出现了写请求：这一块是只读的");
  assert.ok(health.includes("state.preset") || health.includes("state && state.preset"), "预设注册没读 status 返回的 preset 块");

  // 服务端那一侧：只读路由存在。
  const index = read("lib/index.js");
  assert.ok(index.includes('path: "/dsh-purge/health"'), "只读端点没注册");
});

/**
 * 页面读了哪些字段，逐项对契约。
 *
 * 这条是本批返工的核心：上一版这里是一张硬编码的字段表（`["drifted", "missing", …]` 配
 * `index.includes(field)`），等于「用测试代替声明」—— 加字段只要改这一个数组就过。现在
 * 字段表只从契约取，页面读到的每个 `install.*` / `logs.*` 都必须是 `STATE_BLOCKS.health`
 * 里声明过的那一个。
 *
 * 只认「标识符后跟点」的写法，并跳过字符串里的同名片段（`t("logs.absent")` 是文案键，
 * 不是字段）：否则空态文案会被当成一个未登记字段。
 */
test("健康/日志块只读声明过的字段：页面读的每个键都能在契约里找到", () => {
  const fragment = read("lib/client-src/settings/diagnostics-tab.js");
  const declared = new Set(Object.keys(contract.STATE_BLOCKS.health));
  assert.ok(declared.size > 0, "契约里没有 health 块：先声明再谈页面读什么");
  const readKeys = new Set();
  for (const m of fragment.matchAll(/(?:^|[^"'\w.])(install|presetCopy|logs)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    readKeys.add(`${m[1]}.${m[2]}`);
  }
  assert.ok(readKeys.size > 0, "抽取不到页面读的字段：取样点可能变了，判据已失效");
  const undeclared = [...readKeys].filter((key) => !declared.has(key));
  assert.deepEqual(undeclared, [], `页面读了契约里没有的字段：${undeclared.join("、")}——先在 STATE_BLOCKS.health 登记`);
});

test("文案键在两份词典里都在：拼错的键只会把键名印到界面上", () => {
  const i18n = read("lib/client-src/i18n.js");
  const zhStart = i18n.indexOf("const zh = {");
  const enStart = i18n.indexOf("const en = {");
  assert.ok(zhStart >= 0 && enStart > zhStart, "i18n.js 的两份词典结构变了");
  const zhText = i18n.slice(zhStart, enStart);
  const enText = i18n.slice(enStart);
  const keysOf = (text) => new Set([...text.matchAll(/^\t{3}"?([\w.]+)"?:\s/gm)].map((m) => m[1]));
  const zh = keysOf(zhText);
  const en = keysOf(enText);

  const blocks = ["lib/client-src/settings/diagnostics-tab.js", "lib/client-src/settings/diagnostics-tab.js"];
  const used = new Set();
  for (const rel of blocks) {
    for (const m of read(rel).matchAll(/\bt\("([\w.]+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 20, `只从两块里取到 ${used.size} 个键，取样点可能变了`);
  const missing = [...used].filter((key) => !zh.has(key) || !en.has(key));
  assert.deepEqual(missing, [], `这些键在词典里缺：${missing.join("、")}`);
});

/**
 * 空态要有话说：三块在没有数据时都不许渲染成一片空白。
 *
 * 判据是「每一块都至少有一条空态文案」：`t("….empty")` / `t("….missing")` /
 * `t("….none")` / `t("….unavailable")` 任一形状。空白页不是「没有数据」，是「没有话说」。
 */
test("三块都有空态文案：空白不是空态", () => {
  for (const rel of ["lib/client-src/settings/diagnostics-tab.js", "lib/client-src/settings/diagnostics-tab.js"]) {
    const source = read(rel);
    const emptyKeys = [...source.matchAll(/\bt\("([\w.]+\.(?:empty|missing|none|unavailable))"/g)].map((m) => m[1]);
    assert.ok(emptyKeys.length > 0, `${rel} 没有空态文案：没有数据时用户只会看到空白`);
  }
});
