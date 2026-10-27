/**
 * test/audit-remedy.test.mjs — 症候卡的数据完整性、判定行为，以及「命令真能跑」。
 *
 * 为什么存在：读法文档只能教人「看哪个字段」，教不会「下一步跑哪条」。卡片表如果
 * 只是散文的分类版，它和文档没有区别；所以这里锁三件能机判的事：
 *   一、每张卡四段齐全（字段 / 命令 / 动作 / 判定），且命令是可执行的形态；
 *   二、卡片由现场触发，而不是「查什么症候都给你一堆建议」；
 *   三、`audit why` 的输出里真的带上了「下一步」，`--json` 里有同一份数据。
 *
 * 命令能不能跑用真跑判：不需要宿主的那些命令在临时夹具上跑一遍，退出码 2（环境错误）
 * 就算失败 —— 「跑不起来」的补救方案等于没有。
 */
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REMEDY_CARDS,
  matchRemedies,
  remedyCard,
  renderRemedies,
} from "../lib/audit/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = "apply-20261025T180000Z-c0de";
const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-remedy-home-"));

test.after(() => {
  fs.rmSync(EMPTY_HOME, { recursive: true, force: true });
});

function auditRow(over = {}) {
  return {
    ts: "2026-10-25T18:00:00.000+08:00",
    seq: 0,
    recordId: "b41f0c7e-9a52-4f13-8a6e-2d7c1e5b9f04",
    runId: RUN,
    observedTs: "2026-10-25T18:00:00.000+08:00",
    event: "code.patch-applied",
    result: "ok",
    layer: "code",
    actor: "host",
    target: "补丁46",
    evidence: { file: "app.js", marker: "M", hits: 1, bytes: 10 },
    detail: { patchId: 46, status: "applied" },
    ...over,
  };
}

function diagRow(over = {}) {
  return { ts: "2026-10-25T10:00:00.000Z", event: "apply.start", runId: RUN, entry: "http", ...over };
}

/** 一个闭环的临时 dshHome：一份审计文件 + 一份诊断轨。 */
function makeHome({ audit = [], diag = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-remedy-"));
  const auditDir = path.join(home, "dsh-purge", "audit");
  const logDir = path.join(home, "dsh-purge", "logs");
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}${rows.length > 0 ? "\n" : ""}`;
  fs.writeFileSync(path.join(auditDir, "2026-10-25.jsonl"), jsonl(audit), "utf8");
  fs.writeFileSync(path.join(logDir, "diag.jsonl"), jsonl(diag), "utf8");
  return home;
}

/** 完整收尾的三层：文件行 + 层结论，末行是 tool.apply-result。 */
function closedRun(runId = RUN) {
  const rows = [];
  let seq = 0;
  for (const [layer, id] of [["prompt", 1], ["code", 46], ["tool", 29]]) {
    rows.push(auditRow({
      seq: seq++,
      runId,
      layer,
      event: `${layer}.patch-applied`,
      detail: { patchId: id, status: "applied" },
    }));
    rows.push(auditRow({
      seq: seq++,
      runId,
      layer,
      event: `${layer}.apply-result`,
      result: "ok",
      evidence: { refSeq: seq - 2, quote: `${layer}.patch-applied` },
      detail: {
        applied: 1, failed: 0, skipped: 0, unresolved: [], exempt: [],
        completeness: { patches: true, files: true, layers: true },
      },
    }));
  }
  return rows;
}

/** 诊断轨：与审计行集合相同，但次序按补丁表来（真机上审计与诊断的排序规则不同）。 */
function diagWindow(extra = []) {
  return [
    diagRow(),
    diagRow({ event: "apply.patch", id: "46", status: "applied" }),
    diagRow({ event: "apply.patch", id: "29", status: "applied" }),
    diagRow({ event: "apply.patch", id: "1", status: "applied" }),
    diagRow({ event: "apply.end", pendingRestart: "false", asarSealed: "false" }),
    ...extra,
  ];
}

function runCli(argv, home = EMPTY_HOME) {
  const out = [];
  const err = [];
  const result = spawnSync(
    process.execPath,
    ["bin/dsh-purge.js", ...argv],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, DSH_HOME: home } },
  );
  out.push(result.stdout || "");
  err.push(result.stderr || "");
  return { code: result.status, out: out.join(""), err: err.join("") };
}

test("每张卡四段齐全：字段 / 命令 / 动作 / 判定，且 id 唯一", () => {
  assert.ok(REMEDY_CARDS.length >= 8, `卡片只有 ${REMEDY_CARDS.length} 张，覆盖不到主要症候`);
  const ids = new Set();
  for (const card of REMEDY_CARDS) {
    assert.match(card.id, /^[a-z][a-z0-9-]+$/, `id 形态不对：${card.id}`);
    assert.ok(!ids.has(card.id), `id 重复：${card.id}`);
    ids.add(card.id);
    assert.ok(card.symptom && card.symptom.length >= 4, `${card.id} 没有症状描述`);
    assert.ok(Array.isArray(card.fields) && card.fields.length > 0, `${card.id} 没写证据字段`);
    assert.ok(typeof card.check === "string" && card.check.length > 0, `${card.id} 没有可跑的命令`);
    assert.ok(typeof card.action === "string" && card.action.length > 0, `${card.id} 没有动作`);
    assert.ok(typeof card.decision === "string" && card.decision.length > 0, `${card.id} 没有判定`);
    // 命令必须是能粘进终端的形态：只认这几种起手，别写成「去看某某文档」。
    assert.match(card.check, /^(?:node |node_modules\/\.bin\/|Select-String )/, `${card.id} 的 check 不是可执行命令：${card.check}`);
    assert.equal(remedyCard(card.id)?.id, card.id);
  }
  assert.equal(remedyCard("no-such-card"), null, "不认识的 id 要返回 null，不许猜近似名");
});

test("不需要宿主的卡片命令在夹具上真能跑（退出码不是 2）", () => {
  const home = makeHome({
    audit: closedRun(),
    diag: diagWindow(),
  });
  for (const card of REMEDY_CARDS) {
    if (card.needsHost) continue;
    let command = card.check
      .split("<审计目录>").join(path.join(home, "dsh-purge", "audit"))
      .split("<审计文件>").join(path.join(home, "dsh-purge", "audit", "2026-10-25.jsonl"))
      .split("<DSH_HOME>").join(home)
      .split("<某一天的审计文件>").join(path.join(home, "dsh-purge", "audit", "2026-10-25.jsonl"))
      .split("<revert 的 runId>").join("apply-revert-placeholder")
      .split("<runId>").join(RUN);
    if (!/^node bin\/dsh-purge\.js /.test(command)) continue;
    command = command.replace(/^node /, "");
    // Select-String 那条在 Windows 上要 PowerShell：这里用其中的 --jsonl 变体判，别把
    // 「shell 不同」当成命令不可跑。
    if (command.startsWith("Select-String")) continue;
    const argv = command.split(/\s+/).filter(Boolean);
    const result = spawnSync(process.execPath, argv, {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, DSH_HOME: home },
    });
    assert.notEqual(result.status, 2, `${card.id} 的命令跑不起来（退出码 2）：${card.check}\n${result.stderr}`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("卡片由现场触发：没症状不给卡，有症状点名到具体那张", () => {
  const clean = matchRemedies({ run: { closed: true }, auditRows: [], diagRows: [], cross: { problems: [] } });
  assert.deepEqual(clean, [], "没有现场就不该给任何卡");

  const rejected = matchRemedies({
    diagRows: [diagRow({ event: "apply.gate.reject", hostVersion: "0.1.0", dshTarget: "0.2.1-rc.2" })],
  });
  assert.deepEqual(rejected.map((card) => card.id), ["version-gate-reject"]);

  const truncated = matchRemedies({ run: { closed: false, lastEvent: "code.patch-applied" } });
  assert.deepEqual(truncated.map((card) => card.id), ["run-truncated"]);

  const miss = matchRemedies({
    auditRows: [auditRow({ result: "fail", event: "code.patch-miss", detail: { patchId: 46, status: "pattern_not_found" } })],
  });
  assert.deepEqual(miss.map((card) => card.id), ["patch-hard-miss"]);

  const notAudited = matchRemedies({
    diagRows: [diagRow({ entry: "reapply" })],
    auditRows: [],
  });
  assert.ok(notAudited.some((card) => card.id === "audit-not-written"));
  assert.match(notAudited[0].because, /reapply/, "要点名是哪个入口不写审计");

  const ineffective = matchRemedies({
    diagRows: [diagRow({ event: "apply.end", pendingRestart: "true", asarSealed: "true" })],
    allDiagRows: [diagRow({ event: "apply.end", pendingRestart: "true", asarSealed: "true" })],
  });
  const ids = ineffective.map((card) => card.id);
  assert.ok(ids.includes("restart-not-effective"), "pendingRestart 之后没有 startup.ready，必须提示重启");
  assert.ok(ids.includes("asar-still-sealed"), "密封归档时同一条还要提示先换归档");
  const ineffectiveCard = ineffective.find((card) => card.id === "restart-not-effective");
  assert.match(ineffectiveCard.because, /没有任何 startup\.ready/);

  const reverted = matchRemedies({ diagRows: [diagRow({ event: "revert.start" })] });
  assert.ok(reverted.some((card) => card.id === "revert-not-audited"));
});

test("renderRemedies：零命中时也给一句下一步，不许留空", () => {
  const line = renderRemedies([]);
  assert.equal(line.length, 1);
  assert.match(line[0], /^下一步：/);
  const many = renderRemedies([
    { symptom: "甲", fields: ["f1"], check: "node bin/dsh-purge.js audit tail", action: "做甲", decision: "判甲", because: "因为甲" },
  ]);
  assert.ok(many.join("\n").includes("因为甲"));
  assert.ok(many.join("\n").includes("判定：判甲"));
});

test("audit why：真机形态（两轨次序不同、审计是子集）判一致 true，并带出下一步", () => {
  const home = makeHome({ audit: closedRun(), diag: diagWindow() });
  try {
    const cli = runCli(["audit", "why", RUN], home);
    assert.equal(cli.code, 0, `why 应退出 0：${cli.err}`);
    assert.match(cli.out, /cross: 对上 1 \/ 共 1 轮；一致 true/, cli.out);
    assert.ok(cli.out.includes("次序"), "次序差异要作为信息项出现在输出里");
    assert.match(cli.out, /下一步：/, "why 的输出没有「下一步」段");

    const structured = runCli(["audit", "why", RUN, "--json"], home);
    const report = JSON.parse(structured.out);
    assert.equal(report.cross.consistent, true);
    assert.ok(Array.isArray(report.remedies), "--json 里没有 remedies");
    assert.ok(Array.isArray(report.cross.orderNotes), "--json 里没有次序信息项");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("audit why：门禁拒绝那一轮把「下一步」指向版本对照", () => {
  const home = makeHome({
    audit: [],
    diag: [
      diagRow({ event: "apply.start", hostVersion: "0.1.0", dshTarget: "0.2.1-rc.2" }),
      diagRow({ event: "apply.gate.reject", hostVersion: "0.1.0", dshTarget: "0.2.1-rc.2", rejected: "C:\\host" }),
    ],
  });
  try {
    const cli = runCli(["audit", "why", RUN], home);
    assert.equal(cli.code, 0, cli.err);
    assert.match(cli.out, /版本门禁拒绝/);
    assert.match(cli.out, /--diagnose/);
    assert.match(cli.out, /审计轨只记 apply|不写审计轨/, "要说明审计轨这一侧为空是设计边界");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
