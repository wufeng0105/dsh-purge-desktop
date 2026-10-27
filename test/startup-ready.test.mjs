/**
 * test/startup-ready.test.mjs — 启动就绪事件：每次宿主启动都留下「读到了什么」。
 *
 * 为什么单独立一份：apply 那一侧只能证明「字节写到磁盘上了」，证明不了「宿主下次启动
 * 真的读到了」。缺这一条时，唯一能反推的东西是「有没有出现失败事件」—— 那是否席证明。
 * 所以这条事件的字段必须与真实文件逐字对得上（对齐戳的 version / sha / at 三样都来自
 * applied.json 的真结构），而且一个进程只许记一条：重载也记的话，「重启了吗」会被刷出
 * 假的启动记录。
 *
 * 真实宿主不参与：全部落在 mkdtemp 造的一次性 home 上，跑完即删。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatAppliedStamp,
  noteStartupReady,
  readAppliedStampForLog,
  startupReadyFields,
} from "../lib/audit/startup.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-startup-"));
  fs.mkdirSync(path.join(home, "dsh-purge"), { recursive: true });
  return home;
}

function diagRows(home) {
  const file = path.join(home, "dsh-purge", "logs", "diag.jsonl");
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("对齐戳按 applied.json 的真结构折成一行：version@sha@at 三样都不许省", () => {
  // 真机那份的长相（顺手也把「戳是占位指纹」这一档覆盖到）。
  const stamp = { version: "1.0.0", sha: "apply:1.0.0", at: "2026-10-24T16:02:38.723Z" };
  assert.equal(formatAppliedStamp(stamp), "1.0.0@apply:1.0.0@2026-10-24T16:02:38.723Z");
  // 缺 at 也要留痕：分不清「这次启动写的」还是「上次留下的」，正是它要回答的问题。
  assert.equal(formatAppliedStamp({ version: "2.0.0", sha: "abc123" }), "2.0.0@abc123");
  // 没有戳是空串，不是「对得上」。
  assert.equal(formatAppliedStamp(null), "");
  assert.equal(formatAppliedStamp(undefined), "");
});

test("字段形状：patchesMatch 是布尔（落盘时由诊断轨统一转成字符串），版本与戳都是字符串", () => {
  const fields = startupReadyFields({
    version: "2.0.0",
    patchesMatch: false,
    appliedStamp: { version: "2.0.0", sha: "rev-1", at: "2026-10-25T00:00:00.000Z" },
  });
  // 明细四项在**没给 alignment / 戳里没 run_id** 时一律空串：空串是「没读到」，
  // 空数组是「一条不缺」—— 这两件事必须能分开，否则缺数据会被读成全对。
  assert.deepEqual(fields, {
    version: "2.0.0",
    patchesMatch: false,
    appliedStamp: "2.0.0@rev-1@2026-10-25T00:00:00.000Z",
    pending: "",
    pendingCount: "",
    pendingDisplay: "",
    pendingDisplayCount: "",
    alignmentReason: "",
    appliedRunId: "",
    // 归因用的两个宿主版本：没给明细时是空串（「没读到」），不是「没变」。
    hostVersion: "",
    stampHostVersion: "",
  });
  // 缺参也不许抛：启动路径上的任何异常都会挡住宿主启动。
  assert.deepEqual(startupReadyFields(), {
    version: "",
    patchesMatch: false,
    appliedStamp: "",
    pending: "",
    pendingCount: "",
    pendingDisplay: "",
    pendingDisplayCount: "",
    alignmentReason: "",
    appliedRunId: "",
    hostVersion: "",
    stampHostVersion: "",
  });
});

test("对齐明细展开：一个布尔说不清「哪几条」，明细要原样写出来", () => {
  const fields = startupReadyFields({
    version: "2.0.0",
    patchesMatch: false,
    appliedStamp: { version: "2.0.0", sha: "rev-1", at: "2026-10-25T00:00:00.000Z", runId: "apply-20261025T171420Z-a88e" },
    alignment: { ok: false, reason: "pending", pending: ["9", "74", "100"], displayPending: ["9", "100"] },
  });
  // 诊断轨的值一律字符串化，所以 pending 是逗号串（与 track 里其他列表同形）。
  // 这一层**原样展开、不排序**：排序是生产侧 `patchAlignment` 的职责（它按补丁号数值排），
  // 在这一层再排一次就等于同一件事有两个实现，改一处漏一处。
  assert.equal(fields.pending, "9,74,100");
  assert.equal(fields.pendingCount, "3");
  // 展示口径的同一批待清洗：两条并成了 [9] 那一行（74 与 9 同组）。两个数都写出来，
  // 「UI 说 1 条、启动说 3 条」不再是一句没头绪的话。
  assert.equal(fields.pendingDisplay, "9,100");
  assert.equal(fields.pendingDisplayCount, "2");
  assert.equal(fields.alignmentReason, "pending");
  // 戳里的 apply 身份要跟着写出来 —— 这是「这次启动对应哪一次 apply」的唯一出处。
  assert.equal(fields.appliedRunId, "apply-20261025T171420Z-a88e");
  // 已对齐时 reason 是空串、pending 是空串（不是 "[]"、也不是 "0"）。
  const okFields = startupReadyFields({
    patchesMatch: true,
    alignment: { ok: true, reason: "", pending: [] },
  });
  assert.equal(okFields.pending, "");
  assert.equal(okFields.pendingCount, "0");
  assert.equal(okFields.alignmentReason, "");
});

test("读不到 applied.json 时给 null —— null 是「没有戳」，不是「戳对得上」", () => {
  const home = makeHome();
  try {
    assert.equal(readAppliedStampForLog(home), null);
    fs.writeFileSync(
      path.join(home, "dsh-purge", "applied.json"),
      JSON.stringify({ version: "1.2.3", sha: "apply:1.2.3", at: "2026-10-25T01:02:03.000Z" }),
      "utf8",
    );
    assert.deepEqual(readAppliedStampForLog(home), {
      version: "1.2.3",
      sha: "apply:1.2.3",
      at: "2026-10-25T01:02:03.000Z",
      // 老戳没有 run_id：空串 = 戳里没这一项（老世代），不是「对不上」。
      runId: "",
      // 老戳也没有宿主版本：空串 = 这一份账本答不了「宿主换过没有」。
      hostVersion: "",
    });
    // 新戳带 run_id：这次启动读的是哪一次 apply，从此是记录而不是推断。
    fs.writeFileSync(
      path.join(home, "dsh-purge", "applied.json"),
      JSON.stringify({
        version: "1.2.3",
        sha: "apply:1.2.3",
        at: "2026-10-25T01:02:03.000Z",
        run_id: "apply-20261025T171420Z-a88e",
      }),
      "utf8",
    );
    assert.equal(readAppliedStampForLog(home).runId, "apply-20261025T171420Z-a88e");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("刷戳时必须沿用旧 run_id —— 否则 apply 的身份在下次启动就被抹掉", () => {
  // 结构判据，不跑真刷写：`writeAppliedStamp` 读的是真实 `applied.json` 路径，
  // 在用例里造它要连 `pluginVersion` / `installedRev` 一起伪造，代价大于收益。
  // 这里锁的是「那段逻辑在不在」—— 它一旦消失，`appliedRunId` 会静默变回空串，
  // 而那正是这个字段存在的理由。账本层在 lib/stamp.js（reapply 只转出 API）。
  const source = fs.readFileSync(path.join(ROOT, "lib", "stamp.js"), "utf8");
  const match = source.match(/function writeAppliedStamp\([\s\S]*?\n\}/);
  assert.ok(match, "找不到 writeAppliedStamp");
  const body = match[0];
  assert.ok(
    body.includes("carried"),
    "刷戳时没有沿用旧 run_id 的逻辑：启动路径每次都会刷戳，apply 写的身份会在下次启动时被抹掉，"
      + "`startup.ready.appliedRunId` 于是永远读到空串",
  );
  assert.ok(
    body.includes("identity"),
    "没有把「本次给的 id」与「沿用的旧值」合成一个身份：空 id 时仍会整段不写",
  );
  assert.equal(
    /\.\.\.\(id === "" \? \{\} : \{ run_id: id \}\)/.test(body),
    false,
    "还留着「空 id 就整个不写 run_id」的老写法 —— 那就是抹掉旧身份的来路",
  );
});

/**
 * 唯一一条会真写盘的用例：模块级「只记一条」的闸不可重置，所以写盘与第二次调用
 * 必须在同一个用例里做完，否则用例顺序一变就互相踩。
 */
test("每次启动记一条：字段与 applied.json 对得上，且同一进程不许记第二条", () => {
  const home = makeHome();
  const previousLog = process.env.DSH_PURGE_LOG;
  const previousFile = process.env.DSH_PURGE_LOG_FILE;
  delete process.env.DSH_PURGE_LOG;
  delete process.env.DSH_PURGE_LOG_FILE;
  try {
    fs.writeFileSync(
      path.join(home, "dsh-purge", "applied.json"),
      JSON.stringify({ version: "1.0.0", sha: "apply:1.0.0", at: "2026-10-24T16:02:38.723Z" }),
      "utf8",
    );
    const first = noteStartupReady({ patchesMatch: true, version: "2.0.0", dshHome: home });
    assert.equal(first.logged, true);

    const rows = diagRows(home);
    assert.equal(rows.length, 1, `应当只写一行，实际写了 ${rows.length} 行`);
    const row = rows[0];
    assert.equal(row.event, "startup.ready");
    assert.equal(row.version, "2.0.0");
    // 诊断轨的值一律是字符串，布尔也一样 —— 读的人要按字符串比。
    assert.equal(row.patchesMatch, "true");
    assert.equal(row.appliedStamp, "1.0.0@apply:1.0.0@2026-10-24T16:02:38.723Z");
    // 它不是 apply：硬塞 entry / runId 会让「按 runId 捞一轮」捞到无关记录。
    assert.equal(row.entry, undefined, "启动事件不许带 entry");
    assert.equal(row.runId, undefined, "启动事件不许带 runId");

    const second = noteStartupReady({ patchesMatch: false, version: "2.0.0", dshHome: home });
    assert.equal(second.logged, false, "同一进程里的第二次调用不许再记一条");
    assert.equal(diagRows(home).length, 1, "插件被宿主重载不该刷出新的启动记录");
  } finally {
    if (previousLog === undefined) delete process.env.DSH_PURGE_LOG;
    else process.env.DSH_PURGE_LOG = previousLog;
    if (previousFile === undefined) delete process.env.DSH_PURGE_LOG_FILE;
    else process.env.DSH_PURGE_LOG_FILE = previousFile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
