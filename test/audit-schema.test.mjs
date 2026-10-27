/**
 * 审计事件的形状判据：不合规就必须在落盘前抛错。
 *
 * 这里全是纯函数校验（不碰文件系统），因为「哪条规则被违反」比「文件写没写」
 * 更需要被逐条锁住。反面清单来自日志规格本身：自述布尔、裸本地时间、
 * 层与事件名不一致、多写的顶层字段 —— 这四类都能在事后让一条日志失去价值。
 */
import { test } from "node:test";
import assert from "node:assert";

import {
  fileEvidence,
  makeEvent,
  refEvidence,
  validateEvent,
} from "../lib/audit/index.js";

const TS = "2026-10-23T18:15:05+08:00";
const RID = "b41f0c7e-9a52-4f13-8a6e-2d7c1e5b9f04";
const filePart = () => ({ file: "app.js", marker: "ACTIVE", hits: 1, bytes: 48213 });
const stamped = (extra) => ({
  ts: TS,
  seq: 0,
  recordId: RID,
  event: "code.probe",
  result: "ok",
  evidence: filePart(),
  ...extra,
});

test("v2 三字段：recordId 必须是小写 uuid，runId 有长度上限，observedTs 必须带时区偏移", () => {
  assert.throws(() => validateEvent(stamped({ recordId: "NOT-A-UUID" })), /recordId/);
  assert.throws(() => validateEvent(stamped({ recordId: "B41F0C7E-9A52-4F13-8A6E-2D7C1E5B9F04" })), /recordId/);
  assert.doesNotThrow(() => validateEvent(stamped({ runId: "apply-20261023T214012Z-7f1a" })));
  assert.throws(() => validateEvent(stamped({ runId: "x".repeat(65) })), /runId/);
  assert.throws(() => validateEvent(stamped({ runId: "" })), /runId/);
  assert.doesNotThrow(() => validateEvent(stamped({ observedTs: "2026-10-23T18:15:05.401+08:00" })));
  assert.throws(() => validateEvent(stamped({ observedTs: "2026-10-23T18:15:05" })), /observedTs/);
  // 草稿阶段三字段都可缺席（stamped=false），一旦出现就照样校验。
  assert.doesNotThrow(() => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: filePart() }));
});

test("stamped 事件缺 recordId 抛错：行级 uuid 由存储层分配，落盘前必须在", () => {
  const { recordId, ...withoutId } = stamped();
  assert.throws(() => validateEvent(withoutId), /recordId/);
});

test("before / after 摘要：null 或 {sha256, bytes}，其他形状抛错", () => {
  const digest = { sha256: "a".repeat(64), bytes: 4096 };
  assert.doesNotThrow(() => makeEvent({
    event: "code.probe", result: "ok", layer: "code",
    evidence: { ...filePart(), before: digest, after: digest },
  }));
  assert.doesNotThrow(() => makeEvent({
    event: "code.probe", result: "ok", layer: "code",
    evidence: { ...filePart(), before: null, after: null },
  }));
  assert.throws(() => makeEvent({
    event: "code.probe", result: "ok", layer: "code",
    evidence: { ...filePart(), after: { sha256: "zz", bytes: 1 } },
  }), /after.*sha256/);
  assert.throws(() => makeEvent({
    event: "code.probe", result: "ok", layer: "code",
    evidence: { ...filePart(), before: { sha256: "a".repeat(64), bytes: -1 } },
  }), /before.*bytes/);
  assert.throws(() => makeEvent({
    event: "code.probe", result: "ok", layer: "code",
    evidence: { ...filePart(), after: { sha256: "a".repeat(64), bytes: 1, extra: 1 } },
  }), /after.*extra/);
  assert.throws(() => makeEvent({
    event: "code.probe", result: "ok", layer: "code",
    evidence: { ...filePart(), before: 5 },
  }), /before/);
});

test("evidence 里出现 {\"ok\":true} 这类自述直接抛错", () => {
  assert.throws(() => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: { ok: true } }), /自述/);
  assert.throws(
    () => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: { ...filePart(), ok: true } }),
    /自述/,
  );
  assert.throws(
    () => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: { refSeq: 0, success: true } }),
    /自述/,
  );
});

test("detail 里也不许放自述布尔", () => {
  assert.throws(
    () => makeEvent({
      event: "code.probe",
      result: "ok",
      layer: "code",
      evidence: filePart(),
      detail: { worked: true },
    }),
    /自述/,
  );
});

test("ts 不带时区偏移直接抛错", () => {
  assert.throws(() => validateEvent(stamped({ ts: "2026-10-23T18:15:05" })), /偏移/);
  assert.throws(() => validateEvent(stamped({ ts: "2026-10-23 18:15:05" })), /偏移/);
  assert.throws(() => validateEvent(stamped({ ts: 20261023 })), /ts/);
  assert.doesNotThrow(() => validateEvent(stamped({ ts: "2026-10-23T12:00:00.123Z" })));
  assert.doesNotThrow(() => validateEvent(stamped({ ts: "2026-10-23T18:15:05-05:00" })));
});

test("layer 存在时 event 首段必须是 prompt / code / tool 且与 layer 一致", () => {
  assert.throws(
    () => makeEvent({ event: "apply.result", result: "ok", layer: "code", evidence: filePart() }),
    /首段/,
  );
  assert.throws(
    () => makeEvent({ event: "tool.loaded", result: "ok", layer: "code", evidence: filePart() }),
    /首段|不一致/,
  );
  assert.throws(
    () => makeEvent({ event: "code.probe", result: "ok", layer: "host", evidence: filePart() }),
    /layer/,
  );
  assert.doesNotThrow(() => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: filePart() }));
});

test("事件层事件（不带 layer）合法：route.reject / cli.invoke", () => {
  assert.doesNotThrow(() => makeEvent({ event: "route.reject", result: "skip", evidence: filePart() }));
  assert.doesNotThrow(() => makeEvent({ event: "cli.invoke", result: "ok", evidence: filePart() }));
});

test("未知顶层字段抛错（事件形状是封闭的）", () => {
  assert.throws(
    () => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: filePart(), note: "补充" }),
    /未知顶层字段/,
  );
  assert.throws(() => validateEvent(stamped({ ok: true })), /未知顶层字段/);
});

test("refEvidence 的 refSeq 必须早于本条 seq", () => {
  assert.throws(
    () => validateEvent({ ts: TS, seq: 0, recordId: RID, event: "tool.loaded", result: "partial", layer: "tool", evidence: { refSeq: 0 } }),
    /早于/,
  );
  assert.throws(
    () => validateEvent({ ts: TS, seq: 2, recordId: RID, event: "tool.loaded", result: "partial", layer: "tool", evidence: { refSeq: 5 } }),
    /早于/,
  );
  assert.doesNotThrow(
    () => validateEvent({ ts: TS, seq: 1, recordId: RID, event: "tool.loaded", result: "partial", layer: "tool", evidence: { refSeq: 0 } }),
  );
});

test("evidence 只允许两种形态：混用、缺字段、多字段都抛错", () => {
  assert.throws(
    () => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: { refSeq: 0, marker: "M" } }),
    /混用/,
  );
  assert.throws(
    () => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: { file: "a.js", marker: "M", hits: 1 } }),
    /bytes/,
  );
  assert.throws(
    () => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: { file: "a.js", marker: "M", hits: -1, bytes: 1 } }),
    /hits/,
  );
  assert.throws(
    () => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: { ...filePart(), regex: "^M+$" } }),
    /regex/,
  );
  assert.throws(
    () => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: { file: "", marker: "M", hits: 1, bytes: 1 } }),
    /file/,
  );
  assert.doesNotThrow(() => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: { refSeq: 0 } }));
});

test("result 只许四态", () => {
  assert.throws(() => makeEvent({ event: "route.reject", result: "done", evidence: filePart() }), /result/);
  for (const result of ["ok", "fail", "skip", "partial"]) {
    assert.doesNotThrow(() => makeEvent({ event: "route.reject", result, evidence: filePart() }));
  }
});

test("必填字段缺失时点名缺的是哪一个", () => {
  assert.throws(() => makeEvent({ event: "code.probe", result: "ok", layer: "code" }), /evidence/);
  assert.throws(() => makeEvent({ result: "ok", layer: "code", evidence: filePart() }), /event/);
  assert.throws(() => makeEvent({ event: "code.probe", layer: "code", evidence: filePart() }), /result/);
  assert.throws(() => validateEvent({ ts: TS, event: "code.probe", result: "ok", evidence: filePart() }), /seq/);
});

test("构造器自己就会拦下不合规的证据", () => {
  assert.throws(() => fileEvidence({ file: "a.js", marker: "M", hits: 1 }), /bytes/);
  assert.throws(() => fileEvidence({ refSeq: 0 }), /refSeq/);
  assert.throws(() => refEvidence({}), /refSeq/);
  assert.throws(() => refEvidence({ refSeq: -1 }), /refSeq/);
});

test("actor / target 的取值与长度按规格校验；session 已收口，写侧不再接受", () => {
  assert.throws(
    () => makeEvent({ event: "code.probe", result: "ok", layer: "code", actor: "nobody", evidence: filePart() }),
    /actor/,
  );
  assert.throws(
    () => makeEvent({
      event: "code.probe",
      result: "ok",
      layer: "code",
      target: "x".repeat(513),
      evidence: filePart(),
    }),
    /target/,
  );
  // session 已从 schema 删除（落账方拿不到会话上下文），白名单必须同步：
  // 写侧还能写出 schema 不承认的字段，就是「日志里有、规格里没有」。
  // 读侧仍容忍旧行里的 session —— 那条承诺由 audit-vocabulary.test.mjs 守着。
  assert.throws(
    () => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: filePart(), session: "sess-123" }),
    /未知顶层字段/,
  );
  assert.throws(
    () => makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: filePart(), session: "x".repeat(65) }),
    /未知顶层字段/,
  );
});
