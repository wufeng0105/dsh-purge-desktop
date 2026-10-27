/**
 * 审计日志存储层的行为判据：追加 → 读回 → 轮转 → 清理 → 证据链回溯。
 *
 * 全部用例在系统临时目录里造一个假 DSH_HOME，跑完即删 ——
 * 审计日志是运行期数据，测试绝不碰真实状态目录，否则一次误跑就会污染装机记录。
 *
 * 这一层只验文件行为；事件形状判据在 audit-schema.test.mjs。
 */
import { test } from "node:test";
import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_FILE_BYTES,
  appendEvent,
  fileEvidence,
  localIso,
  makeEvent,
  prune,
  readEvents,
  refEvidence,
  resolveAuditDir,
  tail,
  why,
} from "../lib/audit/index.js";

// 与日志规格一致：必须带时区偏移。
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

const todayLocal = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const probeEvidence = () => fileEvidence({ file: "resources/app/lib/index.js", marker: "ACTIVE", hits: 1, bytes: 2048 });

/** 每个用例一个全新的假 DSH_HOME，结束即删；用例之间互不共享文件。 */
function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "dsh-purge-audit-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("追加两条后读回：ts 带偏移、seq 从 0 起、文件落在 audit 目录里", () => {
  withHome((home) => {
    const first = appendEvent(home, makeEvent({
      event: "code.probe",
      result: "ok",
      layer: "code",
      actor: "host",
      target: "lib/index.js",
      evidence: probeEvidence(),
    }));
    const second = appendEvent(home, makeEvent({
      event: "tool.loaded",
      result: "partial",
      layer: "tool",
      evidence: refEvidence({ refSeq: first.seq, quote: "code.probe" }),
    }));

    assert.equal(first.seq, 0);
    assert.equal(second.seq, 1);
    assert.match(first.ts, TS_RE);
    assert.match(second.ts, TS_RE);

    const auditDir = resolveAuditDir(home);
    assert.equal(auditDir, join(home, "dsh-purge", "audit"));

    const names = readdirSync(auditDir).filter((name) => name.endsWith(".jsonl"));
    assert.deepEqual(names, [`${todayLocal()}.jsonl`]);

    const raw = readFileSync(join(auditDir, names[0]), "utf8");
    assert.ok(raw.endsWith("\n"), "行尾必须是换行：没有换行的话下一次追加会把两条粘成一条");
    const lines = raw.split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), first);

    const back = readEvents(home);
    assert.equal(back.length, 2);
    assert.deepEqual(back[0], first);
    assert.deepEqual(back[1], second);
    assert.equal(back.skipped, 0);
  });
});

test("追加不覆盖已落盘的行：两次追加后第一行字节不变", () => {
  withHome((home) => {
    appendEvent(home, makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: probeEvidence() }));
    const auditDir = resolveAuditDir(home);
    const name = readdirSync(auditDir)[0];
    const before = readFileSync(join(auditDir, name), "utf8");

    appendEvent(home, makeEvent({ event: "code.probe", result: "fail", layer: "code", evidence: probeEvidence() }));
    const after = readFileSync(join(auditDir, name), "utf8");

    assert.ok(after.startsWith(before), "第一行被改写了 —— 日志必须是只追加");
    assert.equal(after.split("\n").filter(Boolean).length, 2);
  });
});

test("入参自带 seq 会被拒，且一个文件都不写", () => {
  withHome((home) => {
    const draft = makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: probeEvidence() });
    assert.throws(() => appendEvent(home, { ...draft, seq: 7 }), /seq/);
    assert.equal(existsSync(join(home, "dsh-purge")), false, "校验失败不该留下目录或文件");
  });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("v2 recordId 由存储层自动分配：形状是小写 uuid、逐行互异、入参自带被拒", () => {
  withHome((home) => {
    const first = appendEvent(home, makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: probeEvidence() }));
    const second = appendEvent(home, makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: probeEvidence() }));
    assert.match(first.recordId, UUID_RE);
    assert.match(second.recordId, UUID_RE);
    assert.notEqual(first.recordId, second.recordId, "recordId 是行级标识，两条不许共享");
    assert.throws(
      () => appendEvent(home, { ...makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: probeEvidence() }), recordId: first.recordId }),
      /recordId/,
    );
  });
});

test("读侧容忍 v1 旧行：无 recordId/runId/observedTs 的行照样读回、tail、why", () => {
  withHome((home) => {
    const auditDir = resolveAuditDir(home);
    mkdirSync(auditDir, { recursive: true });
    // 手工摆一条 v1 形状的旧日志：refSeq 指向下面 appendEvent 写出的 v2 行之前不可行（refSeq 必须更早），
    // 所以顺序是先写 v1 行（seq 0，文件证据），再写 v2 行引用它。
    const legacy = {
      ts: localIso(new Date()),
      seq: 0,
      event: "code.patch-applied",
      result: "ok",
      layer: "code",
      actor: "host",
      evidence: { file: "a.js", marker: "M", hits: 1, bytes: 10 },
    };
    writeFileSync(join(auditDir, `${todayLocal()}.jsonl`), `${JSON.stringify(legacy)}\n`, "utf8");
    const modern = appendEvent(home, makeEvent({
      event: "code.apply-result",
      result: "ok",
      layer: "code",
      evidence: refEvidence({ refSeq: 0, quote: "code.patch-applied" }),
      runId: "apply-20261023T214012Z-7f1a",
    }));

    const back = readEvents(home);
    assert.equal(back.length, 2);
    assert.equal(back[0].recordId, undefined, "v1 旧行没有 recordId，读侧不补造");
    assert.equal(back.skipped, 0, "缺新字段的旧行不是坏行");

    assert.deepEqual(tail(home, { n: 10 }).map((e) => e.seq), [1, 0]);
    const trace = why(home, modern.seq);
    assert.equal(trace.complete, true, "v2 行引用 v1 行的链照样回溯到底");
    assert.equal(trace.chain.length, 2);

    // 按 runId 过滤时 v1 行自然排除 —— 它们本就不属于那次运行。
    assert.deepEqual(tail(home, { n: 10, runId: "apply-20261023T214012Z-7f1a" }).map((e) => e.seq), [1]);
  });
});

test("校验失败的事件不落盘，也不留下空文件", () => {
  withHome((home) => {
    assert.throws(
      () => appendEvent(home, makeEvent({
        event: "code.probe",
        result: "ok",
        layer: "code",
        evidence: { file: "a.js", marker: "M", hits: 1 },
      })),
      /bytes/,
    );
    const auditDir = resolveAuditDir(home);
    assert.deepEqual(existsSync(auditDir) ? readdirSync(auditDir) : [], []);
  });
});

test("坏行被跳过并计数，不影响同文件里的好行", () => {
  withHome((home) => {
    const good = appendEvent(home, makeEvent({
      event: "code.probe",
      result: "ok",
      layer: "code",
      evidence: probeEvidence(),
    }));
    const auditDir = resolveAuditDir(home);
    const name = readdirSync(auditDir)[0];
    appendFileSync(join(auditDir, name), "{ 这不是 JSON\n", "utf8");

    const back = readEvents(home);
    assert.equal(back.length, 1);
    assert.deepEqual(back[0], good);
    assert.equal(back.skipped, 1);
  });
});

test("tail 倒序返回最新 N 条，并按 layer / event 前缀过滤", () => {
  withHome((home) => {
    appendEvent(home, makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: probeEvidence() }));
    appendEvent(home, makeEvent({ event: "tool.loaded", result: "ok", layer: "tool", evidence: probeEvidence() }));
    appendEvent(home, makeEvent({ event: "route.reject", result: "skip", evidence: probeEvidence() }));

    assert.deepEqual(tail(home, { n: 10 }).map((event) => event.seq), [2, 1, 0]);
    assert.deepEqual(tail(home, { n: 10, layer: "code" }).map((event) => event.event), ["code.probe"]);
    assert.deepEqual(tail(home, { n: 10, event: "route." }).map((event) => event.event), ["route.reject"]);

    const newest = tail(home, { n: 1 });
    assert.equal(newest.length, 1);
    assert.equal(newest[0].seq, 2);
  });
});

test("why 串出 本条 → refSeq → 被引事件 的完整链", () => {
  withHome((home) => {
    const probe = appendEvent(home, makeEvent({
      event: "code.probe",
      result: "ok",
      layer: "code",
      evidence: probeEvidence(),
    }));
    const follow = appendEvent(home, makeEvent({
      event: "tool.loaded",
      result: "partial",
      layer: "tool",
      evidence: refEvidence({ refSeq: probe.seq, quote: "code.probe" }),
    }));

    const trace = why(home, follow.seq);
    assert.equal(trace.complete, true);
    assert.equal(trace.brokenAt, null);
    assert.deepEqual(trace.chain.map((node) => node.seq), [1, 0]);
    assert.equal(trace.chain[0].event, "tool.loaded");
    assert.equal(trace.chain[1].event, "code.probe");
    assert.equal(trace.file, `${todayLocal()}.jsonl`);
  });
});

test("why 在引用断了的时候说明断在哪", () => {
  withHome((home) => {
    const auditDir = resolveAuditDir(home);
    mkdirSync(auditDir, { recursive: true });
    const ghost = {
      ts: localIso(new Date()),
      seq: 0,
      event: "tool.loaded",
      result: "partial",
      layer: "tool",
      evidence: { refSeq: 9 },
    };
    writeFileSync(join(auditDir, `${todayLocal()}.jsonl`), `${JSON.stringify(ghost)}\n`, "utf8");

    const trace = why(home, 0);
    assert.equal(trace.complete, false);
    assert.equal(trace.chain.length, 1);
    assert.equal(trace.brokenAt.refSeq, 9);
    assert.equal(trace.brokenAt.fromSeq, 0);
    assert.match(trace.brokenAt.reason, /9/);
  });
});

test("why 找不到起点时给出空链而不是抛错", () => {
  withHome((home) => {
    const trace = why(home, 42);
    assert.equal(trace.complete, false);
    assert.deepEqual(trace.chain, []);
    assert.equal(trace.event, null);
    assert.equal(trace.ambiguous, false);
    assert.match(trace.brokenAt.reason, /42/);
  });
});

test("why(seq) 跨文件同名序号：点名全部候选，可用 file 消歧", () => {
  // seq 只在文件内唯一：两天的文件各有一条 seq=0，按 seq 查必然撞车。
  // 旧实现静默取「新文件优先」那一个，读的人不知道还有另一个同号事件。
  withHome((home) => {
    const auditDir = resolveAuditDir(home);
    mkdirSync(auditDir, { recursive: true });
    const row = (event) => JSON.stringify({
      ts: localIso(new Date()),
      seq: 0,
      event,
      result: "ok",
      layer: "code",
      evidence: { file: "a.js", marker: "M", hits: 1, bytes: 10 },
    });
    writeFileSync(join(auditDir, "2026-10-24.jsonl"), `${row("code.probe")}\n`, "utf8");
    writeFileSync(join(auditDir, "2026-10-25.jsonl"), `${row("tool.loaded")}\n`, "utf8");

    const trace = why(home, 0);
    assert.equal(trace.ambiguous, true, "两个文件都有 seq=0 时必须报歧义");
    assert.deepEqual(trace.candidates, ["2026-10-25.jsonl", "2026-10-24.jsonl"], "候选按新文件在前");
    assert.equal(trace.file, "2026-10-25.jsonl");
    assert.equal(trace.event, "tool.loaded");

    const pinned = why(home, 0, { file: "2026-10-24.jsonl" });
    assert.equal(pinned.ambiguous, false);
    assert.equal(pinned.file, "2026-10-24.jsonl");
    assert.equal(pinned.event, "code.probe");
  });
});

test(`单日文件超过 ${MAX_FILE_BYTES} 字节时轮转到同日序号文件，seq 在新文件里重新从 0 起`, () => {
  withHome((home) => {
    const auditDir = resolveAuditDir(home);
    mkdirSync(auditDir, { recursive: true });
    const day = todayLocal();
    const filler = {
      ts: localIso(new Date()),
      seq: 5,
      event: "code.probe",
      result: "ok",
      layer: "code",
      evidence: { file: "a.js", marker: "M", hits: 1, bytes: 1 },
    };
    // 用行尾空白把文件撑到上限之上：解析器忽略尾部空白，这一行仍是合法事件。
    writeFileSync(join(auditDir, `${day}.jsonl`), `${JSON.stringify(filler)}${" ".repeat(MAX_FILE_BYTES)}`, "utf8");

    const appended = appendEvent(home, makeEvent({
      event: "code.probe",
      result: "ok",
      layer: "code",
      evidence: probeEvidence(),
    }));

    assert.equal(appended.seq, 0, "新文件里的序号从 0 起");
    assert.deepEqual(
      readdirSync(auditDir).filter((name) => name.endsWith(".jsonl")).sort(),
      [`${day}.1.jsonl`, `${day}.jsonl`],
    );

    const back = readEvents(home);
    assert.equal(back.length, 2, "同一天的主文件与轮转文件要一起读回");
  });
});

test("prune 删掉超过保留期的日志文件并返回文件名，不动别的文件", () => {
  withHome((home) => {
    const auditDir = resolveAuditDir(home);
    mkdirSync(auditDir, { recursive: true });
    for (const day of ["2026-08-01", "2026-09-22", "2026-09-23", "2026-10-23"]) {
      writeFileSync(join(auditDir, `${day}.jsonl`), "", "utf8");
    }
    writeFileSync(join(auditDir, "2026-09-22.1.jsonl"), "", "utf8");
    writeFileSync(join(auditDir, "notes.txt"), "不是本模块写的文件\n", "utf8");

    // 以 2026-10-23 为「现在」、保留 30 天：2026-09-22 之前（含）清掉，09-23 留下。
    const removed = prune(home, { retainDays: 30, now: new Date(2026, 9, 23, 12, 0, 0) });

    assert.deepEqual(
      removed.slice().sort(),
      ["2026-08-01.jsonl", "2026-09-22.1.jsonl", "2026-09-22.jsonl"],
    );
    assert.ok(existsSync(join(auditDir, "2026-09-23.jsonl")), "保留期边界当天要留下");
    assert.ok(existsSync(join(auditDir, "2026-10-23.jsonl")));
    assert.ok(existsSync(join(auditDir, "notes.txt")), "不认识的形状不代替别人删");
  });
});

test("resolveAuditDir 要求显式 dshHome：空值不回退到默认目录", () => {
  assert.throws(() => resolveAuditDir(""), /DSH_HOME/);
  assert.throws(() => resolveAuditDir(undefined), /DSH_HOME/);
});

/**
 * 保留策略的调用点判据：写入路径上真的会清，但不是每次都清。
 *
 * 三条用例共用同一个手法 —— 在「现在」之前造一个超过保留期的文件，看它活不活：
 *   一、写入一次 → 它被清掉：证明 prune 有了生产调用点，而不只是被测试直接调。
 *   二、同一天再写一次、且中途又放了一个过期文件 → 它还活着：证明不是每次 append 都扫目录。
 *   三、换成第二天写入 → 它被清掉：证明「按天首次」的边界是日期跨越，不是进程重启。
 * 第二条是这组用例的关键：只有第一条时，「每次 append 都清」与「按天清一次」都能过。
 */
const OLD_DAY = "2026-08-01";
const DAY_ONE = new Date(2026, 9, 23, 12, 0, 0);
const DAY_TWO = new Date(2026, 9, 24, 12, 0, 0);

/** 在审计目录里摆一个超过保留期的空日志文件，返回它的绝对路径。 */
function plantExpired(home) {
  const auditDir = resolveAuditDir(home);
  mkdirSync(auditDir, { recursive: true });
  const file = join(auditDir, `${OLD_DAY}.jsonl`);
  writeFileSync(file, "", "utf8");
  return file;
}

test("写入路径会调 prune：一次 append 之后超过保留期的日志文件被清掉", () => {
  withHome((home) => {
    const expired = plantExpired(home);
    appendEvent(home, makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: probeEvidence() }), { now: DAY_ONE });
    assert.equal(existsSync(expired), false, "写入之后过期日志还在 —— prune 没有接进写入路径");
  });
});

test("prune 是低频的：同一天第二次 append 不再扫目录，中途摆进去的过期文件留着", () => {
  withHome((home) => {
    appendEvent(home, makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: probeEvidence() }), { now: DAY_ONE });
    // 第一次 append 已经把当天的清理额度用掉了，此刻摆进来的过期文件只可能被下一次清理删掉。
    const planted = plantExpired(home);
    appendEvent(home, makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: probeEvidence() }), { now: DAY_ONE });
    assert.equal(existsSync(planted), true, "同一天第二次 append 又清了一遍 —— 每次写入都扫目录，成本随事件数放大");
  });
});

test("prune 的额度按本地日期重置：跨到第二天再写，过期文件被清掉", () => {
  withHome((home) => {
    appendEvent(home, makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: probeEvidence() }), { now: DAY_ONE });
    const planted = plantExpired(home);
    appendEvent(home, makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: probeEvidence() }), { now: DAY_TWO });
    assert.equal(existsSync(planted), false, "换了日期仍不清 —— 清理额度没有跟着日期重置");
  });
});

test("清理失败不阻断写入：过期文件删不掉时事件照样落盘", () => {
  withHome((home) => {
    const auditDir = resolveAuditDir(home);
    mkdirSync(auditDir, { recursive: true });
    // 用「名字像日志文件的目录」制造一次删除失败：unlinkSync 对目录抛 EPERM / EISDIR，
    // 这正是生产里「日志文件被别的进程占住」的同构情形。
    mkdirSync(join(auditDir, `${OLD_DAY}.jsonl`), { recursive: true });
    const written = appendEvent(
      home,
      makeEvent({ event: "code.probe", result: "ok", layer: "code", evidence: probeEvidence() }),
      { now: DAY_ONE },
    );
    assert.equal(written.seq, 0, "清理失败把事件写入一起拖垮了");
    assert.equal(readEvents(home, { date: "2026-10-23" }).length, 1, "事件没有落盘");
  });
});
