/**
 * scripts/audit-smoke.mjs — 审计日志的落盘形状没有别的用例覆盖，用它造一次真写读回。
 * 审计日志冒烟：在系统临时目录造一个假 DSH_HOME，追加两条事件、读回、逐条断言。
 *
 * 为什么除了单元测试还要一条命令：审计日志是运行期产物，收货时要能一眼看到
 * 「写进去的字节长这样」以及「读回来的形状合不合规格」。这个脚本只写系统临时目录，
 * 跑完删干净，不碰真实状态目录；任何一条断言不过就退出码 1。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendEvent,
  fileEvidence,
  makeEvent,
  readEvents,
  refEvidence,
  resolveAuditDir,
} from "../lib/audit/index.js";

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOP_LEVEL = ["ts", "seq", "recordId", "runId", "observedTs", "event", "result", "layer", "evidence", "actor", "target", "detail"];

const HOME = mkdtempSync(join(tmpdir(), "dsh-purge-audit-smoke-"));
let failed = 0;

function check(label, ok, detail = "") {
  if (ok) {
    console.log(`PASS ${label}`);
    return;
  }
  failed += 1;
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

/** 证据只允许两种形状：文件证据（file+marker+hits+bytes）或引用证据（refSeq）。 */
function classifyEvidence(evidence) {
  const keys = Object.keys(evidence).sort();
  const hasRef = keys.includes("refSeq");
  const fileKeys = ["bytes", "file", "hits", "marker"].filter((key) => keys.includes(key));
  if (hasRef) return { shape: fileKeys.length === 0 ? "ref" : "mixed", keys };
  return { shape: fileKeys.length === 4 ? "file" : "unknown", keys };
}

let logPath = null;

try {
  const probe = appendEvent(HOME, makeEvent({
    event: "code.probe",
    result: "ok",
    layer: "code",
    actor: "cli",
    target: "lib/index.js",
    evidence: fileEvidence({
      file: "resources/app/lib/index.js",
      marker: "ACTIVE",
      hits: 1,
      bytes: 48213,
      offset: 12094,
    }),
  }));
  const follow = appendEvent(HOME, makeEvent({
    event: "tool.loaded",
    result: "partial",
    layer: "tool",
    actor: "cli",
    target: "app.asar#lib",
    evidence: refEvidence({ refSeq: probe.seq, quote: "code.probe" }),
    detail: { note: "改写侧命中在解包目录，加载侧读的是 asar 内同一路径。" },
  }));

  const auditDir = resolveAuditDir(HOME);
  const names = readdirSync(auditDir).filter((name) => name.endsWith(".jsonl"));
  logPath = names.length === 1 ? join(auditDir, names[0]) : null;
  const events = readEvents(HOME);

  check("日志目录是 <DSH_HOME>/dsh-purge/audit", auditDir === join(HOME, "dsh-purge", "audit"), auditDir);
  check("当日只有一份日志文件", names.length === 1, names.join(", ") || "(空)");
  check("文件名是本地日期 YYYY-MM-DD.jsonl", /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(names[0] || ""), names[0] || "");
  check("读回两条事件", events.length === 2, `实得 ${events.length}`);
  check("ts 都匹配带偏移的时刻格式", events.every((event) => TS_RE.test(event.ts)), events.map((event) => event.ts).join(", "));
  check("seq 为 0 和 1", events.map((event) => event.seq).join(",") === "0,1", events.map((event) => event.seq).join(","));
  check(
    "顶层字段都在规格内",
    events.every((event) => Object.keys(event).every((key) => TOP_LEVEL.includes(key))),
    events.map((event) => Object.keys(event).join("|")).join(" ; "),
  );
  check(
    "v2 recordId 由存储层自动分配且互不相同",
    events.every((event) => UUID_RE.test(event.recordId || "")) && events[0].recordId !== events[1].recordId,
    events.map((event) => event.recordId).join(", "),
  );

  const shapes = events.map((event) => classifyEvidence(event.evidence).shape);
  check("evidence 只在 fileEvidence / refEvidence 两种形状内", shapes[0] === "file" && shapes[1] === "ref", shapes.join(", "));
  check("引用事件的 refSeq 指向第一条", events[1] && events[1].evidence.refSeq === events[0].seq);
  // result 与计数是「读回来的行还能不能当证据用」的最小单位：只数行数会漏掉
  // 「行在、判定被改写」这种残缺 —— 那比丢一行更难发现。
  check(
    "result 原样读回（ok / partial）",
    events[0]?.result === "ok" && events[1]?.result === "partial",
    events.map((event) => `${event.event}:${event.result}`).join(", "),
  );
  const byLayer = events.reduce((acc, event) => {
    acc[event.layer] = (acc[event.layer] ?? 0) + 1;
    return acc;
  }, {});
  check(
    "按层计数与写入时一致（code 1 / tool 1）",
    byLayer.code === 1 && byLayer.tool === 1 && Object.keys(byLayer).length === 2,
    JSON.stringify(byLayer),
  );
  check(
    "evidence.hits 与 bytes 是数字且原样读回",
    events[0]?.evidence?.hits === 1 && events[0]?.evidence?.bytes === 48213,
    JSON.stringify(events[0]?.evidence ?? {}),
  );
  check(
    "结论层事件的 event 首段与 layer 一致",
    events.every((event) => event.layer === undefined || event.event.split(".")[0] === event.layer),
    events.map((event) => `${event.layer}:${event.event}`).join(", "),
  );

  const raw = logPath ? readFileSync(logPath, "utf8") : "";
  const lines = raw.split("\n").filter((line) => line !== "");
  check("逐行 JSONL：一行一条且行尾有换行", lines.length === 2 && raw.endsWith("\n"), `行数 ${lines.length}`);
  check(
    "每一行都能独立解析",
    lines.every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    }),
  );

  if (failed === 0) console.log(`SMOKE OK: 2 events, file ${logPath}`);
} catch (error) {
  failed += 1;
  console.error(`FAIL 冒烟执行中断 — ${error && error.message ? error.message : error}`);
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`SMOKE FAILED: ${failed} 条断言未通过`);
  process.exit(1);
}
