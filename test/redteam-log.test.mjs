/**
 * test/redteam-log.test.mjs — 演练台两个高杠杆动作在诊断轨上留下可定位的最小事实。
 *
 * 为什么选这两个点：一次事实库写入（`addVuln`）与一次报告生成（`report`）是演练台里
 * 最贵、也最容易被问「这条是什么时候进库的 / 这份报告按什么口径生成的」的两件事。
 * 判据只有一条：事件带得住定位对象的最小标识，且**不搬内容** —— 标题、证据、报告正文
 * 都不进日志。
 *
 * `DSH_PURGE_LOG_FILE` 指向临时文件，真实 DSH_HOME 一个字节都不写。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RedteamStore } from "../lib/redteam/store-core.js";

function readRows(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("事实库写入与报告生成各留一条事件，只带定位标识不带内容", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-redteam-"));
  const logFile = path.join(root, "diag.jsonl");
  const previous = process.env.DSH_PURGE_LOG_FILE;
  let store = null;
  try {
    process.env.DSH_PURGE_LOG_FILE = logFile;
    store = new RedteamStore(root);
    const opened = store.openEngagement("Demo Target", ["10.0.0.0/24"]);
    const id = store.activeEngagementId();
    assert.equal(id, opened.id);

    const vuln = store.addVuln(id, {
      title: "SENSITIVE-TITLE-SHOULD-NOT-APPEAR",
      severity: "high",
      status: "confirmed",
      evidence: "SENSITIVE-EVIDENCE-SHOULD-NOT-APPEAR",
    });
    const report = store.report(id);
    assert.ok(report.markdown.length > 0);

    const rows = readRows(logFile);
    const write = rows.find((row) => row.event === "vuln.record");
    const generated = rows.find((row) => row.event === "report.generate");
    assert.ok(write, `诊断轨里没有 vuln.record：${rows.map((row) => row.event).join(", ")}`);
    assert.ok(generated, "诊断轨里没有 report.generate");

    assert.equal(write.engagement, id);
    assert.equal(write.vuln, String(vuln.id));
    assert.equal(write.severity, "high");
    assert.equal(write.status, "confirmed");
    assert.equal(write.updated, "false");
    assert.equal(generated.engagement, id);
    assert.equal(generated.bytes, String(Buffer.byteLength(report.markdown, "utf8")));

    const text = JSON.stringify(rows);
    assert.ok(!text.includes("SENSITIVE-TITLE-SHOULD-NOT-APPEAR"), "日志搬了漏洞标题");
    assert.ok(!text.includes("SENSITIVE-EVIDENCE-SHOULD-NOT-APPEAR"), "日志搬了证据正文");
    assert.ok(!text.includes("攻防演练成果报告"), "日志搬了报告正文");
  } finally {
    if (store) store.close();
    if (previous === undefined) delete process.env.DSH_PURGE_LOG_FILE;
    else process.env.DSH_PURGE_LOG_FILE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
