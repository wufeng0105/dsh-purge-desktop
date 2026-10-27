/**
 * 一次 apply 的落账判据：每条结论事件都带得出去、查得回来。
 *
 * 这里跑的是**真实的写盘路径**（临时 dshHome + 真实文件 + 真实 marker 计数），
 * 不是桩：审计日志的价值全在「照着它还能复现」，用假 store 测等于没测。
 *
 * 为什么不对宿主安装目录跑一次真 apply 来验收：apply 会写宿主文件，
 * 而本项目对宿主目录只许读。所以验收落在同一条代码路径上，输入换成夹具行。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readEvents } from "../lib/audit/store.js";
import { auditCounts, auditRowsFromReport, fileDigest, recordApply } from "../lib/audit/report.js";
import { isPatchResultSoftOk } from "../lib/core.js";

const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_EVIDENCE_KEYS = ["bytes", "file", "hits", "marker"];

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-audit-apply-"));
}

function makeHostFile(dir, name, marker, times) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${Array.from({ length: times }, () => marker).join("\n")}\n`, "utf8");
  return file;
}

test("recordApply：三层各落一条结论，证据是文件探针而不是自述", () => {
  const home = makeHome();
  const hostDir = makeHostFile(home, "host-a.js", "MARKER_A", 2);
  const hostDirB = makeHostFile(home, "host-b.js", "MARKER_B", 1);
  fs.mkdirSync(home, { recursive: true });
  try {
    const result = recordApply({
      dshHome: home,
      rows: [
        { id: 1, name: "PROMPT_ONE", layer: "prompt", status: "applied", files: [hostDir], marker: "MARKER_A" },
        // 这里要的是一条 miss：用 pattern_not_found（文件在、marker 不在）。
        // missing_file 自本轮起不再算失败（缺件=这一版不需要），拿它造 miss 会造出
        // 一条 patch-skipped，与本用例「三层各一条结论、code 是 fail」的意图无关。
        { id: 3, name: "CODE_ONE", layer: "code", status: "pattern_not_found", files: [hostDirB], marker: "MARKER_MISSING" },
        { id: 4, name: "TOOL_ONE", layer: "tool", status: "applied", files: [hostDirB], marker: "MARKER_B" },
      ],
      before: { [hostDir]: fileDigest(hostDir), [hostDirB]: fileDigest(hostDirB) },
    });
    assert.equal(result.events, 6, "三条补丁事件 + 三条层结论");
    assert.equal(result.layers.prompt.result, "ok");
    assert.equal(result.layers.code.result, "fail");
    assert.equal(result.layers.tool.result, "ok");

    const events = readEvents(home);
    assert.equal(events.length, 6);
    events.forEach((event, index) => {
      assert.equal(event.seq, index, "seq 必须从 0 起严格递增");
      assert.match(event.ts, TS_PATTERN, "ts 必须带时区偏移");
      assert.ok(["ok", "fail", "skip", "partial"].includes(event.result));
      assert.ok(event.evidence && typeof event.evidence === "object");
      assert.ok(!JSON.stringify(event.evidence).includes('"ok"'), "证据里不许出现自述");
    });

    const patchEvents = events.filter((e) => e.event.startsWith("prompt.") || e.event.startsWith("code.") || e.event.startsWith("tool."));
    for (const event of patchEvents) {
      assert.equal(event.event.split(".")[0], event.layer, "事件名首段必须与 layer 一致");
    }
    const first = events[0];
    assert.equal(first.event, "prompt.patch-applied");
    assert.deepEqual(Object.keys(first.evidence).filter((k) => FILE_EVIDENCE_KEYS.includes(k)).sort(), FILE_EVIDENCE_KEYS);
    assert.equal(first.evidence.hits, 2);
    assert.ok(first.evidence.bytes > 0);

    const codeMiss = events.find((e) => e.event === "code.patch-miss");
    assert.equal(codeMiss.result, "fail");
    assert.equal(codeMiss.evidence.hits, 0, "未命中记 0，不编造命中数");
    assert.ok(codeMiss.evidence.bytes > 0, "文件在但不命中时 bytes 非 0");

    const layerEvents = events.filter((e) => e.event.endsWith(".apply-result"));
    assert.equal(layerEvents.length, 3);
    for (const event of layerEvents) {
      assert.equal(typeof event.evidence.refSeq, "number");
      assert.ok(event.evidence.refSeq < event.seq, "引用必须指向更早的事件");
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("recordApply：没有落点或 marker 的行不写事件，只计入 skipped", () => {
  const home = makeHome();
  try {
    const result = recordApply({
      dshHome: home,
      rows: [
        { id: 7, name: "NO_PATH", layer: "code", status: "applied", files: [], marker: "X" },
        { id: 8, name: "NO_MARKER", layer: "code", status: "applied", files: [path.join(home, "x.js")], marker: "" },
      ],
    });
    assert.equal(result.events, 0);
    assert.equal(result.skipped, 2);
    assert.equal(readEvents(home).length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("recordApply：文件读不到时记 bytes=0，仍留一条可核对的记录", () => {
  const home = makeHome();
  try {
    const missing = path.join(home, "not-here.js");
    const result = recordApply({
      dshHome: home,
      rows: [{ id: 9, name: "GONE", layer: "tool", status: "missing_file", files: [missing], marker: "M" }],
    });
    assert.equal(result.events, 2);
    const [patchEvent] = readEvents(home);
    assert.equal(patchEvent.evidence.bytes, 0);
    assert.equal(patchEvent.evidence.hits, 0);
    // 口径修正（本轮）：缺件不再算失败 —— 那一批补丁在当前宿主本来就不适用。
    // 所以这一层是「没有失败、但记录不全」→ partial，而不是 fail。
    assert.equal(result.layers.tool.failed, 0, "缺件不许再计进 failed");
    assert.equal(result.layers.tool.result, "partial", "层里没有失败，但 before 没采到 → 记录缺口压成 partial");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test("读写失败的行落成 patch-miss + fail，真原因留在 detail.status", () => {
  const home = makeHome();
  const a = makeHostFile(home, "io-a.js", "MK", 1);
  try {
    const result = recordApply({
      dshHome: home,
      rows: [
        { id: 11, name: "READ_FAIL", layer: "code", status: "read_error", files: [a], marker: "MK" },
        { id: 12, name: "WRITE_FAIL", layer: "code", status: "write_error:EACCES", files: [a], marker: "MK" },
      ],
      before: { [a]: fileDigest(a) },
    });
    const events = readEvents(home);
    const probes = events.filter((e) => e.event === "code.patch-miss");
    assert.equal(probes.length, 2, "两条读写失败都落 miss 事件，不许落成 patch-skipped");
    assert.deepEqual(probes.map((e) => e.result), ["fail", "fail"]);
    assert.deepEqual(
      probes.map((e) => e.detail.status),
      ["read_error", "write_error:EACCES"],
      "事件名只有三种后缀，真原因必须能在 detail.status 里查到",
    );
    const conclusion = events.find((e) => e.event === "code.apply-result");
    assert.equal(conclusion.detail.failed, 2);
    assert.equal(conclusion.detail.skipped, 0, "读写失败不许同时计进 skipped");
    assert.equal(conclusion.result, "fail");
    assert.equal(result.layers.code.result, "fail");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test("recordApply：一条补丁落在两个文件上就落两条事件，各自带自己的命中数", () => {
  const home = makeHome();
  try {
    const a = makeHostFile(home, "multi-a.js", "MK", 1);
    const b = makeHostFile(home, "multi-b.js", "MK", 3);
    const result = recordApply({
      dshHome: home,
      rows: [{ id: 42, name: "MULTI", layer: "code", status: "applied", files: [a, b], marker: "MK" }],
    });
    assert.equal(result.events, 3, "两条探针事件 + 一条层结论（code.apply-result）");
    const events = readEvents(home).filter((e) => e.event.endsWith(".patch-applied"));
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.evidence.hits), [1, 3]);
    assert.deepEqual(
      events.map((e) => e.evidence.file).sort(),
      [a, b].sort(),
      "两个落点必须是同一个补丁的两个文件，不能压成一条",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("recordApply：dshHome 缺失就抛错，不猜默认目录", () => {
  assert.throws(() => recordApply({ rows: [] }), /dshHome/);
  assert.throws(() => recordApply({ dshHome: "  " }), /dshHome/);
});

const threeLayerRows = (home, hostA, hostB) => [
  { id: 1, name: "PROMPT_ONE", layer: "prompt", status: "applied", files: [hostA], marker: "MARKER_A" },
  { id: 2, name: "CODE_ONE", layer: "code", status: "applied", files: [hostB], marker: "MARKER_B" },
  { id: 3, name: "TOOL_ONE", layer: "tool", status: "applied", files: [hostB], marker: "MARKER_B" },
];

test("schema:2 三字段：同一次 run 共享 runId 与 observedTs，recordId 逐行互异", () => {
  const home = makeHome();
  const a = makeHostFile(home, "v2-a.js", "MK", 1);
  const b = makeHostFile(home, "v2-b.js", "MK", 1);
  try {
    recordApply({
      dshHome: home,
      rows: threeLayerRows(home, a, b),
      before: { [a]: fileDigest(a), [b]: fileDigest(b) },
    });
    const events = readEvents(home);
    assert.ok(events.length > 0);
    const runIds = new Set(events.map((e) => e.runId));
    assert.equal(runIds.size, 1, "一次落账是一次运行，runId 必须全批共享");
    assert.match([...runIds][0], /^apply-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
    const observed = new Set(events.map((e) => e.observedTs));
    assert.equal(observed.size, 1, "observedTs 固定为观测起点，全批一致");
    assert.match([...observed][0], TS_PATTERN, "observedTs 与 ts 一样必须带时区偏移");
    const recordIds = new Set(events.map((e) => e.recordId));
    assert.equal(recordIds.size, events.length, "recordId 是行级标识，不许重复");
    events.forEach((e) => assert.match(e.recordId, UUID_PATTERN));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("evidence 带 before/after 摘要：after 与磁盘实际字节一致，before 回声采集表", () => {
  const home = makeHome();
  const a = makeHostFile(home, "digest-a.js", "MK", 1);
  const before = fileDigest(a);
  try {
    recordApply({
      dshHome: home,
      rows: [{ id: 1, name: "D", layer: "code", status: "applied", files: [a], marker: "MK" }],
      before: { [a]: before },
    });
    const [probeEvent] = readEvents(home);
    assert.deepEqual(probeEvent.evidence.after, fileDigest(a), "after 是探针当场算出的摘要");
    assert.deepEqual(probeEvent.evidence.before, before, "before 回声 apply 前的采集表");
    assert.equal(probeEvent.evidence.after.bytes, fs.statSync(a).size);
    // 表里那一项是 null（采过但读不到）时，键仍在、值为 null —— 缺口留痕而不是消失。
    const home2 = makeHome();
    try {
      recordApply({
        dshHome: home2,
        rows: [{ id: 1, name: "D", layer: "code", status: "applied", files: [a], marker: "MK" }],
        before: { [a]: null },
      });
      const [event2] = readEvents(home2);
      assert.equal(event2.evidence.before, null);
    } finally {
      fs.rmSync(home2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("completeness：健康三层 + 齐全 before 表 → 三项全真，ok 不被改写", () => {
  const home = makeHome();
  const a = makeHostFile(home, "full-a.js", "MK_A", 1);
  const b = makeHostFile(home, "full-b.js", "MK_B", 1);
  try {
    recordApply({
      dshHome: home,
      rows: threeLayerRows(home, a, b),
      before: { [a]: fileDigest(a), [b]: fileDigest(b) },
    });
    const conclusions = readEvents(home).filter((e) => e.event.endsWith(".apply-result"));
    assert.equal(conclusions.length, 3);
    for (const event of conclusions) {
      assert.deepEqual(event.detail.completeness, { patches: true, files: true, layers: true });
      assert.equal(event.result, "ok");
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("completeness：该层有无落点的行 → patches=false，ok 被压成 partial", () => {
  const home = makeHome();
  const a = makeHostFile(home, "gap-a.js", "MK_A", 1);
  try {
    const result = recordApply({
      dshHome: home,
      rows: [
        { id: 1, name: "GOOD", layer: "prompt", status: "applied", files: [a], marker: "MK_A" },
        { id: 2, name: "NO_TARGET", layer: "prompt", status: "applied", files: [], marker: "MK_A" },
      ],
      before: { [a]: fileDigest(a) },
    });
    const [conclusion] = readEvents(home).filter((e) => e.event === "prompt.apply-result");
    assert.equal(conclusion.detail.completeness.patches, false);
    assert.equal(conclusion.detail.completeness.files, true, "落了的行摘要齐全，files 不受连坐");
    assert.equal(conclusion.result, "partial", "记不全就不许 ok");
    assert.deepEqual(conclusion.detail.unresolved, [2], "层结论只报本层的缺口");
    assert.equal(result.layers.prompt.result, "partial");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("completeness：只有一层有补丁 → layers=false，各层结论不许 ok/skip", () => {
  const home = makeHome();
  const a = makeHostFile(home, "one-a.js", "MK", 1);
  try {
    recordApply({
      dshHome: home,
      rows: [{ id: 1, name: "ONLY_CODE", layer: "code", status: "applied", files: [a], marker: "MK" }],
      before: { [a]: fileDigest(a) },
    });
    const [conclusion] = readEvents(home).filter((e) => e.event === "code.apply-result");
    assert.equal(conclusion.detail.completeness.layers, false, "prompt / tool 两层没有结论");
    assert.equal(conclusion.result, "partial", "三层不齐本身就是记录缺口，不许 ok");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("completeness：before 表缺席或那一项为 null → files=false（before 没采到就是没记全）", () => {
  const home = makeHome();
  const a = makeHostFile(home, "nob-a.js", "MK", 1);
  try {
    // 不给 before 表（旧调用方路径）
    recordApply({
      dshHome: home,
      rows: [{ id: 1, name: "NO_BEFORE", layer: "code", status: "applied", files: [a], marker: "MK" }],
    });
    const [noTable] = readEvents(home).filter((e) => e.event === "code.apply-result");
    assert.equal(noTable.detail.completeness.files, false);
    assert.equal(noTable.result, "partial");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("completeness：fail 比 partial 更严重 —— 记不全但层内有 miss 时保持 fail", () => {
  const home = makeHome();
  const a = makeHostFile(home, "mix-a.js", "MK", 1);
  try {
    recordApply({
      dshHome: home,
      rows: [
        // 要造「层内有 miss」用 pattern_not_found：缺件（missing_file）本轮起不算
        // 失败，拿它当 miss 会让层结论落成 skip，测不到 fail 与 partial 的优先级。
        { id: 1, name: "MISS", layer: "code", status: "pattern_not_found", files: [a], marker: "GONE" },
      ],
      before: { [a]: fileDigest(a) },
    });
    const [conclusion] = readEvents(home).filter((e) => e.event === "code.apply-result");
    assert.equal(conclusion.result, "fail");
    assert.equal(conclusion.detail.completeness.layers, false, "只有 code 一层");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("auditExempt（PATCH-9）：不落事件、不进分母与 unresolved，detail.exempt 单独列示", () => {
  const home = makeHome();
  const a = makeHostFile(home, "exempt-a.js", "MK_A", 1);
  const b = makeHostFile(home, "exempt-b.js", "MK_B", 1);
  try {
    const result = recordApply({
      dshHome: home,
      rows: [
        { id: 1, name: "PROMPT_ONE", layer: "prompt", status: "applied", files: [a], marker: "MK_A" },
        // migration-only：无 marker，auditExempt 标记——无证据是设计使然，不算缺口
        { id: 21, name: "BASH_TIMEOUT_RESTORE", layer: "code", status: "applied", files: [a, b, a, b], marker: "", exempt: true },
        { id: 2, name: "CODE_ONE", layer: "code", status: "applied", files: [b], marker: "MK_B" },
        { id: 3, name: "TOOL_ONE", layer: "tool", status: "applied", files: [b], marker: "MK_B" },
      ],
      before: { [a]: fileDigest(a), [b]: fileDigest(b) },
    });
    assert.equal(result.events, 6, "exempt 行不写事件：3 条探针 + 3 条层结论");
    assert.equal(result.skipped, 0, "exempt 不是「跳过」，是「不适用」");
    assert.deepEqual(result.unresolved, [], "exempt 不进 unresolved");

    const events = readEvents(home);
    assert.ok(events.every((e) => e.detail?.patchId !== 21), "id 21 不产生任何事件");
    const conclusions = events.filter((e) => e.event.endsWith(".apply-result"));
    for (const c of conclusions) {
      assert.deepEqual(c.detail.completeness, { patches: true, files: true, layers: true }, "豁免不算缺口，三项全真");
      assert.deepEqual(c.detail.exempt, c.layer === "code" ? [21] : [], "豁免在该层的结论里单独列示");
    }
    const codeConclusion = conclusions.find((c) => c.layer === "code");
    assert.equal(codeConclusion.result, "ok", "正常 apply 不再被 migration-only 污染成 partial");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("auditRowsFromReport 传播 auditExempt，auditCounts 不把豁免行计入 rows / files / represented", () => {
  const patches = [
    { id: 1, name: "NORMAL", layer: "代码", marker: "M1", file: "k1" },
    { id: 21, name: "MIGRATION_ONLY", layer: "代码", file: "k2", auditExempt: true },
  ];
  const resolve = (patch) => (patch.id === 1 ? ["C:/a.js", "C:/shared.js"] : ["C:/shared.js", "C:/only-exempt.js"]);
  const rows = auditRowsFromReport(
    [
      { patch_id: 1, status: "applied" },
      { patch_id: 21, status: "applied" },
    ],
    patches,
    resolve,
  );
  assert.equal(rows[0].exempt, false);
  assert.equal(rows[1].exempt, true, "补丁表的 auditExempt 传到审计行");
  const counts = auditCounts(rows, patches);
  assert.equal(counts.patches, 2, "patches 分母仍是全表长度");
  assert.equal(counts.rows, 2, "rows 只数正常行（exempt 的 2 个落点不计）");
  assert.equal(counts.files, 2, "only-exempt.js 不进 files（shared.js 由正常行贡献）");
  assert.equal(counts.represented, 1);
});

test("过滤 apply：detail.table.selected 记下这一轮 report 里的补丁号（含 unresolved）", () => {
  const home = makeHome();
  const a = makeHostFile(home, "selected-a.js", "MK", 1);
  try {
    const result = recordApply({
      dshHome: home,
      rows: [
        { id: 1, name: "SELECTED", layer: "prompt", status: "applied", files: [a], marker: "MK" },
        // 写不出证据的那条也在 report 里：selected 必须包含它，denominator 才解释得清 recorded 的差。
        { id: 2, name: "NO_TARGET", layer: "code", status: "applied", files: [], marker: "" },
      ],
      patches: [
        { id: 1, name: "SELECTED", layer: "提示词" },
        { id: 2, name: "NO_TARGET", layer: "代码" },
        { id: 3, name: "NOT_SELECTED", layer: "工具" },
      ],
      before: { [a]: fileDigest(a) },
    });
    assert.deepEqual(result.unresolved, [2]);
    const [conclusion] = readEvents(home).filter((event) => event.detail && event.detail.table);
    assert.deepEqual(
      conclusion.detail.table.selected,
      [1, 2],
      "selected 是这一轮 report 的补丁号，不是补丁表全量：没选中的 3 不许出现",
    );
    assert.equal(conclusion.detail.table.recorded, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("auditCounts 与 recordApply 咬同一口径：兼容类行（层折空串）两边都不落账", () => {
  const patches = [
    { id: 1, name: "NORMAL", layer: "代码", marker: "M1", file: "k1" },
    { id: 40, name: "COMPAT", layer: "0.2.0 兼容", marker: "M2", file: "k2" },
  ];
  const rows = auditRowsFromReport(
    [
      { patch_id: 1, status: "applied" },
      { patch_id: 40, status: "applied" },
    ],
    patches,
    () => ["C:/a.js"],
  );
  assert.equal(rows[1].layer, "", "兼容类行折不出三档层");
  const counts = auditCounts(rows, patches);
  assert.equal(counts.patches, 2, "分母仍是全表长度");
  assert.equal(counts.rows, 1, "兼容类行不落事件，也不进 rows——对账才闭合");
  assert.equal(counts.represented, 1);
});

test("auditRowsFromReport：报告行折成审计行，layer 与 marker 从补丁表取", () => {
  const patches = [
    { id: 1, name: "P", layer: "提示词", marker: "MP" },
    { id: 3, name: "C", layer: "代码", marker: "MC" },
    { id: 5, name: "X", layer: "0.1.5 兼容", marker: "MX" },
  ];
  const resolve = (patch) => (patch.id === 3 ? ["C:/resolved-b.js"] : []);
  const rows = auditRowsFromReport(
    [
      { patch_id: 1, name: "P", status: "applied", path: "C:/a.js" },
      { patch_id: 3, name: "C", status: "already", path: "C:/b.js" },
      { patch_id: 5, name: "X", status: "applied", path: "C:/c.js" },
      { patch_id: 999, status: "applied", path: "C:/d.js" },
    ],
    patches,
    resolve,
  );
  assert.equal(rows.length, 3, "补丁表里找不到的 id 直接丢掉，不编名字");
  assert.deepEqual(rows.map((r) => r.layer), ["prompt", "code", ""]);
  assert.equal(rows[1].marker, "MC");
  // 落点来自解析器而不是报告行的 path：给了解析器就只认解析器
  assert.deepEqual(rows[1].files, ["C:/resolved-b.js"]);
  assert.equal(rows[1].status, "already");
  // 不给解析器时退回 path（旧调用方兼容路径）
  const legacy = auditRowsFromReport([{ patch_id: 3, status: "already", path: "C:/b.js" }], patches);
  assert.deepEqual(legacy[0].files, ["C:/b.js"]);
});

test("auditRowsFromReport：plural schema 的 markers 也能当证据字面量", () => {
  const patches = [
    { id: 1, name: "PLURAL", layer: "代码", markers: ["x".repeat(260), "const A = 1"], markersAny: [] },
    { id: 2, name: "EMPTY", layer: "代码", markers: [], markersAny: [] },
  ];
  const rows = auditRowsFromReport(
    [{ patch_id: 1, status: "applied" }, { patch_id: 2, status: "applied" }],
    patches,
    () => ["C:/p.js"],
  );
  // 优先挑不超 schema 200 字符上限的那条
  assert.equal(rows[0].marker, "const A = 1");
  assert.equal(rows[1].marker, "", "一个 marker 都没有时留空，由 recordApply 计入 unresolved");
});

test("口径对账：一行 = 一条补丁的一个目标文件，去重后 target 数 = 补丁数 − unresolved 数", () => {
  // 三条补丁：分别落在 1 / 2 / 0 个文件上（第三条没有落点 → 计入 unresolved）
  const patches = [
    { id: 1, name: "ONE", layer: "代码", marker: "M1", file: "k1" },
    { id: 2, name: "TWO", layer: "代码", marker: "M2", file: ["k2", "k3"] },
    { id: 3, name: "NONE", layer: "代码", marker: "M3", file: "k4" },
  ];
  const resolve = (patch) => {
    if (patch.id === 1) return ["C:/a.js"];
    if (patch.id === 2) return ["C:/b.js", "C:/c.js"];
    return [];
  };
  const report = [
    { patch_id: 1, status: "applied" },
    { patch_id: 2, status: "applied" },
    { patch_id: 3, status: "applied" },
  ];
  const rows = auditRowsFromReport(report, patches, resolve);
  const counts = auditCounts(rows, patches);
  assert.equal(counts.patches, 3, "分母是补丁表长度");
  assert.equal(counts.rows, 3, "行数 = 各补丁目标文件数之和（1 + 2 + 0）");
  assert.equal(counts.files, 3, "去重后的目标文件数");
  // 每条补丁的行数必须恰好等于它解析出的目标文件数
  for (const patch of patches) {
    const own = rows.find((r) => r.id === patch.id);
    assert.equal(own.files.length, resolve(patch).length, `补丁 ${patch.id} 的行数与目标数不一致`);
  }
  const unresolved = rows.filter((r) => r.files.length === 0).map((r) => r.id);
  assert.equal(unresolved.length, 1);
  assert.equal(counts.represented, counts.patches - unresolved.length, "有落点的补丁数 = 补丁数 − unresolved 数");
});

test("软硬 miss 两轨同结论：onMiss 决定审计轨折成 skip 还是 fail", () => {
  // 同一条 `pattern_not_found`，诊断轨按补丁声明判软硬，审计轨也必须同一个结论 ——
  // 否则同一份日志里会同时出现「诊断 0 硬失败」与「审计某层 fail」。
  // 判据落在两处：折行时 softOk 由 isPatchResultSoftOk 算，落盘后事件后缀跟着它走。
  const home = makeHome();
  try {
    const softFile = makeHostFile(home, "soft.js", "SOMETHING_ELSE", 1);
    const hardFile = makeHostFile(home, "hard.js", "SOMETHING_ELSE", 1);
    const patches = [
      { id: 11, name: "WARN_PATCH", layer: "代码", marker: "MW", onMiss: "warn" },
      { id: 12, name: "FAIL_PATCH", layer: "代码", marker: "MH", onMiss: "fail" },
    ];
    const rows = auditRowsFromReport(
      [
        { patch_id: 11, status: "pattern_not_found" },
        { patch_id: 12, status: "pattern_not_found" },
      ],
      patches,
      (patch) => [patch.id === 11 ? softFile : hardFile],
    );
    assert.equal(rows[0].softOk, true, "onMiss=warn 的 miss 在审计轨必须是软放过");
    assert.equal(rows[1].softOk, false, "onMiss=fail 的 miss 在审计轨必须是硬失败");
    // 与诊断轨的判定函数逐条对齐：同一个补丁、同一个 status，两边结论相同。
    assert.equal(isPatchResultSoftOk({ status: "pattern_not_found", patch_id: 11 }, patches[0]), rows[0].softOk);
    assert.equal(isPatchResultSoftOk({ status: "pattern_not_found", patch_id: 12 }, patches[1]), rows[1].softOk);

    recordApply({ dshHome: home, rows, before: {} });
    const events = readEvents(home).filter((row) => row.layer === "code" && row.event !== "code.apply-result");
    const soft = events.find((row) => row.detail.patchId === 11);
    const hard = events.find((row) => row.detail.patchId === 12);
    assert.equal(soft.event, "code.patch-skipped", "软 miss 落成 patch-skipped");
    assert.equal(soft.result, "skip");
    assert.equal(soft.detail.status, "pattern_not_found", "软放过不掩盖真实判定");
    assert.equal(hard.event, "code.patch-miss", "硬 miss 落成 patch-miss");
    assert.equal(hard.result, "fail");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
