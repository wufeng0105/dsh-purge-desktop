/**
 * test/audit-vocabulary.test.mjs — 事件词表与写侧必填的判据：旧行仍然读得回来。
 *
 * 为什么这几条要单独锁：词表、layer 必填、schema 镜像三处任何一处漂开，「日志里写了
 * 什么」就重新变回自由发挥区；而写侧的松紧最容易被顺手改到读侧去。所以这里既断言
 * 「新名字落不了盘」，也断言「没有新字段、名字也不在词表里的旧行读回来不抛错」。
 *
 * 夹具全部落在 mkdtempSync 造的临时目录里：不碰真实状态目录，跑完即删。
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fileEvidence,
  readEvents,
  refEvidence,
  resolveAuditDir,
  tail,
  validateEvent,
  why,
} from "../lib/audit/index.js";
import { LAYER_ORDER } from "../lib/audit/layers.js";
import { recordApply } from "../lib/audit/report.js";
import { EVENT_GROUPS, EVENT_NAMES } from "../lib/audit/vocabulary.js";

const TS = "2026-10-24T12:00:00+08:00";
const RID = "b41f0c7e-9a52-4f13-8a6e-2d7c1e5b9f04";
const RUN = "apply-20261024T120000Z-vocab";

// 一条合法的文件证据：四个字段是复核的最小单位，缺任何一个都拼不出「凭什么」。
const filePart = () => fileEvidence({ file: "app.js", marker: "ACTIVE", hits: 1, bytes: 48213 });

/** schema 是判据的镜像，单独抽出来，免得每个用例各读一遍文件。 */
function readSchema() {
  return JSON.parse(
    readFileSync(new URL("../architecture/audit.schema.json", import.meta.url), "utf8"),
  );
}

/** 按名字给出一条该形状下合法的事件：结论层用引用证据，其余用文件证据。 */
function eventFor(name, { seq = 1 } = {}) {
  const layer = LAYER_ORDER.find((candidate) => name.startsWith(`${candidate}.`));
  const base = { ts: TS, seq, recordId: RID, runId: RUN, event: name, result: "ok" };
  if (name.endsWith(".apply-result")) {
    return { ...base, layer, evidence: refEvidence({ refSeq: 0 }) };
  }
  return { ...base, ...(layer === undefined ? {} : { layer }), evidence: filePart() };
}

/** 本地日期段，与存储层给文件起名用的同一口径。 */
function localDay(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function withTemporaryHome(body) {
  const home = mkdtempSync(join(tmpdir(), "dsh-purge-vocabulary-"));
  try {
    return body(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("词表里的每个名字都能通过 validateEvent", () => {
  assert.ok(EVENT_NAMES.length > 0, "词表不许是空的：空词表等于什么都没锁");
  for (const name of EVENT_NAMES) {
    assert.doesNotThrow(() => validateEvent(eventFor(name)), `词表内的名字必须能落盘：${name}`);
  }
});

test("词表外的名字落不了盘，报错带词表位置与最接近的合法名", () => {
  assert.throws(() => validateEvent(eventFor("foo.bar")), /词表/);
  assert.throws(() => validateEvent(eventFor("code.patch-aplyed")), (error) => {
    assert.match(error.message, /lib\/audit\/vocabulary\.js/, "要指出词表在哪个文件");
    assert.match(error.message, /code\.patch-applied/, "要给出最接近的合法名");
    return true;
  });
});

test("结论层事件缺 layer 落不了盘", () => {
  const missingLayer = {
    ts: TS,
    seq: 1,
    recordId: RID,
    event: "code.apply-result",
    result: "ok",
    evidence: refEvidence({ refSeq: 0 }),
  };
  assert.throws(() => validateEvent(missingLayer), /layer/);
});

test("结论层的 layer 不在三层之列落不了盘", () => {
  assert.throws(() => validateEvent({ ...eventFor("code.apply-result"), layer: "host" }), /layer/);
});

test("旧行容忍：没有 recordId / runId / observedTs / layer，名字也不在词表里，读回来不抛错", () => {
  withTemporaryHome((home) => {
    const auditDir = resolveAuditDir(home);
    mkdirSync(auditDir, { recursive: true });
    const day = localDay(new Date());
    // 按 v1 的形状手写一行：名字早于词表，四个字段一个都没有。读侧不许因此抛错。
    const legacy = {
      ts: "2026-10-20T10:00:00+08:00",
      seq: 0,
      event: "legacy.probe",
      result: "ok",
      evidence: { file: "app.js", marker: "ACTIVE", hits: 1, bytes: 12 },
    };
    writeFileSync(join(auditDir, `${day}.jsonl`), `${JSON.stringify(legacy)}\n`, "utf8");

    const events = readEvents(home, { date: day });
    assert.equal(events.length, 1, "旧行必须被读回来，不许被静默丢掉");
    assert.equal(events[0].event, "legacy.probe");
    assert.equal(events[0].recordId, undefined);
    assert.equal(events[0].runId, undefined);
    assert.equal(events[0].observedTs, undefined);
    assert.equal(events[0].layer, undefined);
    assert.doesNotThrow(() => tail(home, { n: 10 }), "tail 读旧行不许抛错");
    assert.doesNotThrow(() => why(home, 0), "why 读旧行不许抛错");
  });
});

test("schema 的 event 枚举与词表集合相等：缺一个 / 多一个 / 重复都红", () => {
  const schema = readSchema();
  const enums = schema.properties.event.enum;
  assert.ok(Array.isArray(enums), "schema 的 event.enum 不是数组");
  assert.equal(new Set(enums).size, enums.length, "schema 的 event.enum 有重复项");
  // 分开报缺与多：只说「不相等」的话，改的人要自己逐项对两遍。
  const missingInSchema = EVENT_NAMES.filter((name) => !enums.includes(name));
  const extraInSchema = enums.filter((name) => !EVENT_NAMES.includes(name));
  assert.deepEqual(
    { missingInSchema, extraInSchema },
    { missingInSchema: [], extraInSchema: [] },
    "schema 的 event 枚举与 lib/audit/vocabulary.js 的 EVENT_NAMES 不是同一个集合",
  );
});

test("schema 里「结论层必带 layer」有载体", () => {
  const schema = readSchema();
  const rule = (schema.allOf ?? []).find((entry) => {
    const pattern = entry?.if?.properties?.event?.pattern;
    if (typeof pattern !== "string" || !pattern.includes("apply-result")) return false;
    return Array.isArray(entry?.then?.required) && entry.then.required.includes("layer");
  });
  assert.ok(rule, "schema 的 allOf 里要有一条「event 是层结论 → 必须带 layer」的规则");
});

test("词表自洽：每个名字都是点分形状，分组之间不重名", () => {
  const shape = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
  const flat = Object.values(EVENT_GROUPS).flat();
  for (const name of EVENT_NAMES) {
    assert.match(name, shape, `词表里的名字必须是点分事件名：${name}`);
  }
  assert.equal(new Set(flat).size, flat.length, "同一个名字不许出现在两个分组里");
  assert.deepEqual([...new Set(flat)].sort(), [...EVENT_NAMES]);
});

test("文件层事件缺 layer 落不了盘：一条探针必须说明替哪一层取证", () => {
  // 这一条就是验收判据里给出的那条命令的形状：不带 layer、不带 runId 的 code.patch-applied。
  const bare = {
    ts: TS,
    seq: 0,
    recordId: RID,
    event: "code.patch-applied",
    result: "ok",
    evidence: filePart(),
  };
  assert.throws(() => validateEvent(bare), /layer/);
  assert.throws(() => validateEvent({ ...bare, runId: RUN }), /layer/);
  assert.throws(() => validateEvent({ ...bare, runId: RUN, layer: "foo" }), /layer/);
  assert.throws(() => validateEvent({ ...bare, runId: RUN, layer: "host" }), /layer/);
});

test("文件层事件缺 runId 落不了盘：同一轮的文件探针与层结论靠它拼成一批", () => {
  const withoutRun = {
    ts: TS,
    seq: 0,
    recordId: RID,
    layer: "code",
    event: "code.patch-applied",
    result: "ok",
    evidence: filePart(),
  };
  assert.throws(() => validateEvent(withoutRun), /runId/);
  assert.doesNotThrow(() => validateEvent({ ...withoutRun, runId: RUN }));
});

test("schema 里「文件层必带 layer」有载体", () => {
  const schema = readSchema();
  const rule = (schema.allOf ?? []).find((entry) => {
    const pattern = entry?.if?.properties?.event?.pattern;
    if (typeof pattern !== "string" || !pattern.includes("patch-")) return false;
    return Array.isArray(entry?.then?.required) && entry.then.required.includes("layer");
  });
  assert.ok(rule, "schema 的 allOf 里要有一条「event 是文件层 → 必须带 layer」的规则");
});

test("文件证据的每个属性都有写入方：schema 定义与落账产出的并集逐字相同", () => {
  withTemporaryHome((home) => {
    const hit = join(home, "hit.js");
    const absent = join(home, "absent.js");
    writeFileSync(hit, "中文前缀\nMARKER\n", "utf8");
    recordApply({
      dshHome: home,
      rows: [
        { id: 1, name: "P1", layer: "code", status: "applied", files: [hit], marker: "MARKER" },
        { id: 2, name: "P2", layer: "code", status: "applied", files: [absent], marker: "MARKER" },
      ],
      // 一侧给摘要、一侧给 null：before 的两种取值都要真出现过，才谈得上「有写入方」。
      before: { [hit]: { sha256: "a".repeat(64), bytes: 1 }, [absent]: null },
      now: new Date("2026-10-24T12:00:00+08:00"),
    });

    const events = readEvents(home);
    const fileEvents = events.filter((event) => event.evidence && typeof event.evidence.file === "string");
    assert.equal(fileEvents.length, 2, "一行补丁落两个文件就是两条文件事件");
    const writtenFileKeys = [...new Set(fileEvents.flatMap((event) => Object.keys(event.evidence)))].sort();
    const schema = readSchema();
    assert.deepEqual(
      writtenFileKeys,
      Object.keys(schema.$defs.fileEvidence.properties).sort(),
      "schema 里的文件证据属性必须都与落账产出对齐：没有写入方的属性不许留，写出来的属性不许没有定义",
    );

    const conclusions = events.filter((event) => String(event.event).endsWith(".apply-result"));
    const writtenRefKeys = [...new Set(conclusions.flatMap((event) => Object.keys(event.evidence)))].sort();
    assert.deepEqual(
      writtenRefKeys,
      Object.keys(schema.$defs.refEvidence.properties).sort(),
      "引用证据的属性必须都与落账产出对齐",
    );
  });
});

test("文件证据的 offset 是首个命中的 UTF-8 字节偏移；没命中就不写 offset", () => {
  withTemporaryHome((home) => {
    const prefix = "中文前缀\n";
    const hit = join(home, "hit.js");
    const noHit = join(home, "no-hit.js");
    writeFileSync(hit, `${prefix}MARKER\nMARKER\n`, "utf8");
    writeFileSync(noHit, "别的内容\n", "utf8");
    recordApply({
      dshHome: home,
      rows: [
        { id: 1, name: "P1", layer: "code", status: "applied", files: [hit], marker: "MARKER" },
        { id: 2, name: "P2", layer: "code", status: "applied", files: [noHit], marker: "MARKER" },
      ],
      now: new Date("2026-10-24T12:00:00+08:00"),
    });

    const events = readEvents(home);
    const byFile = (file) => events.find((event) => event.evidence && event.evidence.file === file);
    const hitEvent = byFile(hit);
    assert.equal(hitEvent.evidence.hits, 2);
    assert.equal(hitEvent.evidence.offset, Buffer.byteLength(prefix, "utf8"), "偏移按字节算，不按字符下标");
    assert.equal(hitEvent.evidence.offset, 13, "四个汉字 12 字节 + 换行 1 字节");

    const noHitEvent = byFile(noHit);
    assert.equal(noHitEvent.evidence.hits, 0);
    assert.equal(
      Object.prototype.hasOwnProperty.call(noHitEvent.evidence, "offset"),
      false,
      "没有命中就没有「第几个字节」可言，写 0 等于说它命中了第 0 字节",
    );
  });
});

test("session 已从 schema 删除：没有写入方的字段不留期权", () => {
  const schema = readSchema();
  assert.equal(
    schema.properties.session,
    undefined,
    "落账方拿不到会话上下文，schema 里留着 session 就是「将来可能用」的期权",
  );
});

test("历史行里的 session 读侧仍容忍：删字段不影响旧日志", () => {
  withTemporaryHome((home) => {
    const auditDir = resolveAuditDir(home);
    mkdirSync(auditDir, { recursive: true });
    const day = localDay(new Date());
    const legacy = {
      ts: "2026-10-20T10:00:00+08:00",
      seq: 0,
      runId: "apply-legacy",
      event: "code.patch-applied",
      result: "ok",
      layer: "code",
      session: "sess-legacy",
      evidence: { file: "app.js", marker: "ACTIVE", hits: 1, bytes: 12 },
    };
    writeFileSync(join(auditDir, `${day}.jsonl`), `${JSON.stringify(legacy)}\n`, "utf8");

    const events = readEvents(home, { date: day });
    assert.equal(events.length, 1);
    assert.equal(events[0].session, "sess-legacy", "旧行里的 session 原样读回，不许被静默丢掉");
    assert.doesNotThrow(() => tail(home, { n: 5 }), "tail 读带 session 的旧行不许抛错");
    assert.doesNotThrow(() => why(home, 0), "why 读带 session 的旧行不许抛错");
  });
});

test("completeness 有假项却记 ok / skip 落不了盘：绿结论不许盖住记录缺口", () => {
  const conclusion = (result, completeness) => ({
    ts: TS,
    seq: 1,
    recordId: RID,
    runId: RUN,
    event: "code.apply-result",
    result,
    layer: "code",
    evidence: refEvidence({ refSeq: 0 }),
    detail: { completeness },
  });
  assert.throws(
    () => validateEvent(conclusion("ok", { patches: false, files: true, layers: true })),
    /completeness/,
  );
  assert.throws(
    () => validateEvent(conclusion("skip", { patches: true, files: false, layers: true })),
    /completeness/,
  );
  assert.doesNotThrow(
    () => validateEvent(conclusion("partial", { patches: false, files: true, layers: true })),
    "记不全时 partial 正是该记的结论",
  );
  assert.doesNotThrow(
    () => validateEvent(conclusion("fail", { patches: true, files: true, layers: false })),
    "失败比记不全更严重，记不全不许把 fail 压成 partial",
  );
  assert.doesNotThrow(
    () => validateEvent(conclusion("ok", { patches: true, files: true, layers: true })),
    "三项全真时 ok 是正常结论",
  );
});

// 这里原来锁「docs/rebuild/07 的现行事件词表与 vocabulary.js 逐字一致」，防的是提案稿里
// 那串 `patch-missed` / `patch-already` 漂进文档。那份文档随 `docs/rebuild/**` 于
// 2026-10-27 整组删除，锁的对象不存在了，判据随之退役。`EVENT_NAMES` 仍是写侧唯一权威，
// schema 枚举与夹具两侧的一致性由上面的用例继续守。

test("夹具与实现自洽：test/fixtures 里每个 .jsonl 的每一行都过写侧校验", () => {
  // 夹具是文档示例与 CLI 判据的共同输入。它只要有一行不合规格，就同时污染三处：
  // 读法里的示例输出、`audit check` 的判据、以及「照这份样本能复现」这句话。
  // 所以夹具不是「随手写的样例」，它是被校验的数据。
  const dir = new URL("../test/fixtures/", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  assert.ok(files.length >= 1, "test/fixtures 里没有 .jsonl 夹具，判据跑空了");
  const failures = [];
  let rows = 0;
  for (const name of files) {
    const lines = readFileSync(new URL(name, dir), "utf8").split("\n").filter((line) => line.trim() !== "");
    lines.forEach((line, index) => {
      rows += 1;
      let event = null;
      try {
        event = JSON.parse(line);
      } catch (error) {
        failures.push(`${name}:${index + 1} 解析失败：${error.message}`);
        return;
      }
      try {
        validateEvent(event);
      } catch (error) {
        failures.push(`${name}:${index + 1} seq=${event.seq} ${error.message}`);
      }
    });
  }
  assert.ok(rows > 0, "夹具里一行数据都没有");
  assert.deepEqual(failures, [], "夹具里有不合规格的行（实现改了而夹具没跟上）");
});
