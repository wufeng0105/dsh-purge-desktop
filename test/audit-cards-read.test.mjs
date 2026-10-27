/**
 * test/audit-cards-read.test.mjs — 三处只写字段各自的读侧：失败卡、readme、prune.capped。
 *
 * 为什么单独立一份：这三样写侧都在（`cards/*.md`、`audit.recorded.readme`、`prune.capped`），
 * 读侧原先一处都没有 —— 只写不读等于没有取证：卡落盘了没人知道去哪找，读法投递失败
 * 只能靠人翻目录，日志顶到代数上限时看到的是「有些行不见了」。
 *
 * 三条判据都用真入口判，不调内部函数：
 *   · `audit why <runId>` —— 有卡给路径，没卡说「本轮无卡」；
 *   · `audit check --diag` —— readme 与现场对账，默认只作信息项，`--strict` 才进退出码；
 *   · `audit tail` —— 这批行落在被顶到上限的那一天时多打一行提示。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recordApplyRun } from "../lib/audit/index.js";
import { runAuditCli } from "../lib/audit/check.js";
import { runAuditQuery } from "../lib/audit/query.js";

/** 收输出的一对函数：与 CLI 的 io 形状一致，不打印到终端。 */
function collector() {
  const out = [];
  const err = [];
  return {
    io: { out: (line) => out.push(String(line)), err: (line) => err.push(String(line)) },
    out,
    err,
    text: () => [...out, ...err].join("\n"),
  };
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const RUN_ID = "apply-20260103T000000Z-99cc";

/**
 * 一轮「有问题」的 apply：一个补丁写失败，于是层结论是 fail、落一张卡、投递一次读法。
 *
 * 卡与读法都只在这条路径上产生 —— 夹具必须走到真实写侧，否则读侧测的是自己编的文件。
 * 诊断轨那三行是补的：`recordApplyRun` 只写 `audit.recorded` 一条，而 `check --diag`
 * 要对的是「两轨都有这一轮」，缺了它们会先撞在跨轨对账上，测不到 readme。
 */
function fixture() {
  const home = makeTemp("dsh-purge-cards-home-");
  const host = makeTemp("dsh-purge-cards-host-");
  const target = path.join(host, "a.js");
  fs.writeFileSync(target, "MK_A\n");
  const patches = [{ id: 1, name: "CODE", layer: "代码", marker: "MK_A", file: "ka" }];
  recordApplyRun({
    dshHome: home,
    report: [{ patch_id: 1, status: "write_error:EPERM: operation not permitted" }],
    patches,
    targets: { ka: target },
    before: { [target]: null },
    runId: RUN_ID,
  });
  const auditDir = path.join(home, "dsh-purge", "audit");
  const diagFile = path.join(home, "dsh-purge", "logs", "diag.jsonl");
  const recorded = fs.readFileSync(diagFile, "utf8").split("\n").filter((line) => line.trim() !== "");
  const stamp = "2026-01-03T00:00:00.000Z";
  const rounds = [
    { ts: stamp, event: "apply.start", patches: "1", selected: "1", entry: "cli", runId: RUN_ID },
    { ts: stamp, event: "apply.patch", id: "1", status: "write_error:EPERM: operation not permitted", entry: "cli", runId: RUN_ID },
    { ts: stamp, event: "apply.end", applied: "0", failed: "1", entry: "cli", runId: RUN_ID },
    ...recorded.map((line) => JSON.parse(line)),
  ];
  fs.writeFileSync(diagFile, `${rounds.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return {
    home,
    host,
    auditDir,
    cardsDir: path.join(auditDir, "cards"),
    diagFile,
    readmePath: path.join(auditDir, "README-for-ai.md"),
  };
}

function cleanup(fx) {
  fs.rmSync(fx.home, { recursive: true, force: true });
  fs.rmSync(fx.host, { recursive: true, force: true });
}

test("audit why：该轮有失败卡就给出路径，没卡就说「本轮无卡」", () => {
  const fx = fixture();
  try {
    const c = collector();
    assert.equal(runAuditQuery(["why", RUN_ID], c.io, { dshHome: fx.home }), 0);
    const cardNames = fs.readdirSync(fx.cardsDir);
    assert.equal(cardNames.length, 1, `这一轮应落一张卡，实得 ${JSON.stringify(cardNames)}`);
    const cardPath = path.join(fx.cardsDir, cardNames[0]);
    assert.ok(c.text().includes("失败卡："), `why 的输出里没有失败卡那一段：\n${c.text()}`);
    assert.ok(c.text().includes(cardPath), `why 没给出卡的路径（${cardPath}）：\n${c.text()}`);

    // --json 里也要有：读侧不只是给人眼看的。
    const j = collector();
    assert.equal(runAuditQuery(["why", RUN_ID, "--json"], j.io, { dshHome: fx.home }), 0);
    const parsed = JSON.parse(j.out.join("\n"));
    assert.deepEqual(parsed.cards, [cardPath], "--json 的 cards 与现场不一致");

    // 删掉卡之后必须说「本轮无卡」，不能静默少一段 —— 那会让人以为输出被截断了。
    fs.rmSync(cardPath);
    const gone = collector();
    assert.equal(runAuditQuery(["why", RUN_ID], gone.io, { dshHome: fx.home }), 0);
    assert.ok(gone.text().includes("本轮无卡"), `卡删掉之后应报「本轮无卡」：\n${gone.text()}`);

    // 目录整个不在也一样：读侧不许因此抛错（「卡没落盘」是边界，不是查询失败）。
    fs.rmSync(fx.cardsDir, { recursive: true, force: true });
    const noDir = collector();
    assert.equal(runAuditQuery(["why", RUN_ID], noDir.io, { dshHome: fx.home }), 0);
    assert.ok(noDir.text().includes("本轮无卡"));
  } finally {
    cleanup(fx);
  }
});

test("audit check：readme 字段与现场对账，默认不改退出码，--strict 才红", () => {
  const fx = fixture();
  try {
    assert.ok(fs.existsSync(fx.readmePath), "夹具的前置没成立：这一轮应当投递过读法");
    const ok = collector();
    assert.equal(
      runAuditCli(["check", "--dir", fx.auditDir, "--diag", fx.diagFile], ok.io),
      0,
      `对账一致时应通过：\n${ok.text()}`,
    );
    assert.ok(ok.text().includes("readme: 记"), `check 没打印 readme 对账那一行：\n${ok.text()}`);

    // 现场读法被删：账本说 installed，现场没有 —— 信息项要出现，但退出码不动。
    fs.rmSync(fx.readmePath);
    const mismatch = collector();
    assert.equal(
      runAuditCli(["check", "--dir", fx.auditDir, "--diag", fx.diagFile], mismatch.io),
      0,
      `readme 差异默认只作信息项，不该改退出码：\n${mismatch.text()}`,
    );
    assert.ok(mismatch.text().includes("readme 对账："), `差异没有被点名：\n${mismatch.text()}`);

    const strict = collector();
    assert.equal(
      runAuditCli(["check", "--dir", fx.auditDir, "--diag", fx.diagFile, "--strict"], strict.io),
      1,
      `--strict 下 readme 差异必须进退出码：\n${strict.text()}`,
    );

    // --json：差异结构化，且 recorded 数得出这一轮。
    const json = collector();
    runAuditCli(["check", "--dir", fx.auditDir, "--diag", fx.diagFile, "--json"], json.io);
    const parsed = JSON.parse(json.out.join("\n"));
    assert.equal(parsed.readme.recorded, 1, "--json 的 readme.recorded 与现场不一致");
    assert.equal(parsed.readme.present, false);
    assert.equal(parsed.readme.mismatches.length, 1);
  } finally {
    cleanup(fx);
  }
});

test("audit check：没给 --diag 时不猜 readme（没有输入就没有结论）", () => {
  const fx = fixture();
  try {
    const c = collector();
    runAuditCli(["check", "--dir", fx.auditDir, "--json"], c.io);
    const parsed = JSON.parse(c.out.join("\n"));
    assert.equal(parsed.readme.recorded, 0, "没有诊断轨却报出了 readme 记录数");
    assert.deepEqual(parsed.readme.mismatches, []);
  } finally {
    cleanup(fx);
  }
});

test("audit tail：这一批行落在被顶到代数上限的那一天时，多打一行提示", () => {
  const fx = fixture();
  try {
    const day = path.basename(fs.readdirSync(fx.auditDir).find((name) => name.endsWith(".jsonl")), ".jsonl");
    fs.appendFileSync(
      fx.diagFile,
      `${JSON.stringify({ ts: new Date().toISOString(), event: "prune.capped", day, generations: "24", file: `${day}.23.jsonl` })}\n`,
      "utf8",
    );
    const c = collector();
    assert.equal(runAuditQuery(["tail", "--n", "50"], c.io, { dshHome: fx.home }), 0);
    assert.ok(c.text().includes("prune.capped"), `tail 没打 prune.capped 提示：\n${c.text()}`);
    assert.ok(c.text().includes(day), "提示里没有那一天的日期，读者无法定位");

    // 换个不同的日期就不该打：这个提示说的是「这一天顶到上限」，不是「曾经顶过」。
    fs.writeFileSync(
      fx.diagFile,
      `${JSON.stringify({ ts: new Date().toISOString(), event: "prune.capped", day: "1999-01-01", generations: "24", file: "1999-01-01.23.jsonl" })}\n`,
      "utf8",
    );
    const other = collector();
    assert.equal(runAuditQuery(["tail", "--n", "50"], other.io, { dshHome: fx.home }), 0);
    assert.equal(other.text().includes("1999-01-01"), false, "别的日子的上限不该出现在这一轮的输出里");
  } finally {
    cleanup(fx);
  }
});
