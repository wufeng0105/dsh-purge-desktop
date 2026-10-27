/**
 * test/apply-ledger-entries.test.mjs — 四个 apply 入口收尾同形：记账只走一处，事实每轮都写。
 *
 * 为什么单独立一份：审计轨的四个入口早已统一落账，版本账本却没有 —— `/purge apply`
 * （命令）与 `purge_apply`（工具）只写审计，账本仍指旧字节。后果不是显示问题：
 * 这两个入口打完补丁，下一次启动仍会按「账本与现场不符」整轮重打，而且那一轮
 * 会把刚写入的证据覆盖成启动轮的空证据。
 *
 * 这里按源码结构钉住四件事，四条都对应一次真实事故：
 *   一、四个入口都走同一处 `reapply.recordApplyRound`，不再各写一遍 `markPatchesApplied`；
 *   二、三个宿主入口的干净轮门槛是 `reapply.isCleanApplyRound`，输入三档齐全；
 *   三、**事实每轮都写、身份只给干净轮** —— 失败轮真写过的字节必须进账本，
 *      否则「pending → 不干净 → 不写账本 → 下一轮还判 pending」这条循环永远闭合不了；
 *   四、面板那条路的门槛由 0014 单独定（`complete` + `flash.ok`），证据形状与另外三处一致。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const INDEX = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
const BIN = fs.readFileSync(path.join(ROOT, "bin", "dsh-purge.js"), "utf8");

/** 取两段锚点之间的源码；锚点找不到就让断言直接红，不静默返回空串。 */
function slice(source, from, to, label) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${label}：找不到起点 ${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `${label}：找不到终点 ${to}`);
  return source.slice(start, end);
}

const RECORD = "reapply.recordApplyRound({";

test("命令入口（/purge apply）走共用记账，干净轮判据三档齐全", () => {
  const block = slice(INDEX, 'case "apply":', 'case "revert":', "命令入口");
  assert.ok(block.includes(RECORD), "命令入口没有写版本账本 —— 打完补丁账本还指旧字节");
  assert.ok(
    block.includes("reapply.isCleanApplyRound({"),
    "命令入口没有「干净收尾」判定 —— 失败轮会占住身份",
  );
  assert.match(
    block,
    /runId: commandRunId/,
    "命令入口记账没有带 runId",
  );
  assert.match(
    block,
    /evidence: applyMulti\.evidence/,
    "命令入口记账没有带本轮写入证据",
  );
  // 记账要落在审计落账之后：干净轮那条路要把摘要并回刚写好的戳。
  const audit = block.indexOf("auditApplyEntry({");
  const ledger = block.indexOf(RECORD);
  assert.ok(audit >= 0 && audit < ledger, "记账要落在审计落账之后");
});

test("工具入口（purge_apply）与命令入口同形", () => {
  const block = slice(INDEX, 'name: "purge_apply",', 'name: "purge_revert",', "工具入口");
  assert.ok(block.includes(RECORD), "工具入口没有写版本账本");
  assert.ok(block.includes("reapply.isCleanApplyRound({"), "工具入口没有「干净收尾」判定");
  assert.match(block, /runId: toolRunId/, "工具入口记账没有带 runId");
  assert.match(block, /evidence: toolMulti\.evidence/, "工具入口记账没有带本轮写入证据");
  const audit = block.indexOf("auditApplyEntry({");
  assert.ok(audit >= 0 && audit < block.indexOf(RECORD), "记账要落在审计落账之后");
});

test("面板入口（HTTP）带本轮证据，门槛由 0014 单独定", () => {
  const start = INDEX.indexOf('path: "/dsh-purge/apply"');
  assert.ok(start > 0, "找不到 HTTP apply 路由");
  const end = INDEX.indexOf("registerPluginRoute({", start);
  const block = INDEX.slice(start, end);
  assert.ok(block.includes(RECORD), "HTTP 入口没有写版本账本");
  assert.match(block, /runId: httpRunId/, "HTTP 入口记账没有带 runId");
  assert.match(block, /evidence: httpMulti\.evidence/, "HTTP 入口记账没有带本轮写入证据");
  assert.ok(block.includes("const complete ="), "HTTP 入口的成功口径（complete）不见了");
  assert.ok(block.includes("flash.ok === true"), "HTTP 入口的 flash 门槛不见了（0014 明写它是门槛）");
});

test("四个入口都带 evidence：这一条是「同形」的硬判据", () => {
  const indexCalls = INDEX.match(/reapply\.recordApplyRound\(/g) || [];
  const binCalls = BIN.match(/reapply\.recordApplyRound\(/g) || [];
  assert.equal(indexCalls.length, 3, `宿主内入口的记账调用应为 3 处，实测 ${indexCalls.length}`);
  assert.equal(binCalls.length, 1, `CLI 的记账调用应为 1 处，实测 ${binCalls.length}`);
  const evidence = [
    ...(INDEX.match(/evidence: (?:applyMulti|toolMulti|httpMulti)\.evidence/g) || []),
    ...new Set(BIN.match(/evidence: ev/g) || []),
  ];
  assert.deepEqual(
    evidence.sort(),
    ["evidence: applyMulti.evidence", "evidence: ev", "evidence: httpMulti.evidence", "evidence: toolMulti.evidence"],
    "四个入口没有全部带上本轮写入证据",
  );
  // 旧形状不许回来：各入口不再自己调「带选项的那一版」markPatchesApplied
  // （那正是四份实现漂开的起点）。启动路径的 `markPatchesApplied()` 是刷戳，不是记轮次，
  // 不带选项，所以这一条只拦带选项的调用。
  assert.equal(
    (INDEX.match(/reapply\.markPatchesApplied\(undefined, \{/g) || []).length,
    0,
    "宿主侧又出现了自己记账的入口 —— 记账实现分叉了",
  );
  assert.equal(
    (BIN.match(/reapply\.markPatchesApplied\(undefined, \{/g) || []).length,
    0,
    "CLI 又出现了自己记账的调用 —— 记账实现分叉了",
  );
});

test("CLI 的门槛与证据没被这批改动退回去", () => {
  const block = slice(BIN, 'if (mode === "--apply")', 'mode === "--unseal"', "CLI apply");
  assert.match(block, /reapply\.recordApplyRound\(\{/, "CLI 没有走共用记账");
  assert.match(block, /evidence: ev/, "CLI 记账没有带本轮写入证据");
  assert.match(block, /hookDenyRestoreFailed: hookFailed/, "CLI 记账缺「安全阀还原」这一档");
  assert.match(block, /roundFailed/, "CLI 没能把「这一轮入口自己知道没成」传给记账");
});

