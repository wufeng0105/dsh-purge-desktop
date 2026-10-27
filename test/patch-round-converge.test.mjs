/**
 * test/patch-round-converge.test.mjs — 一轮 apply 必须收敛：内容自证按文件判，事实每轮进账本。
 *
 * 现场（远端实测，换宿主版本后的第一轮）：`--apply` 真写下了 6 条补丁，`--status` 却把它们
 * 判成待应用，整轮因此判失败、账本一个字不写；第二轮仍然如此。两条缺陷叠成死结：
 *
 *   一、**判据问错了问题**。内容自证原先按「单条补丁」重放官方原文，而同一文件上后一条补丁
 *       会改写前一条的产物（id 84 在 id 83 插下的那段里又插两行）。单条重放的文本与现场
 *       永远对不上 —— 一条不缺的补丁被判成待应用。判据的单位必须换成**文件**：
 *       「这份文件现在是不是这一版表的产物」。
 *   二、**失败轮不写事实**。pending 让轮次不干净，不干净就不写账本，账本不写下一轮还判
 *       pending。事实（写过哪些字节）必须每轮都写，只把身份（run_id / audit）留给干净轮。
 *
 * 本文件三条用例各钉一件事，且都用**真补丁正文 / 真表条目**，不用自造形状：
 *   一、id 83 / 84 同一文件、后者改写前者产物 → 旧账本下两条都判 applied；
 *   二、反例：现场只到半途 → 不许判 applied（自证不许放宽）；
 *   三、一条 onMiss=fail 真打不上 → 整轮仍失败，但其余文件的事实进了账本，下一轮不自锁。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as core from "../lib/core.js";
import * as reapply from "../lib/reapply.js";
import { fileContentKey } from "../lib/patch/table-fingerprint.js";

const P83 = core.ALL_PATCHES.find((item) => item.id === 83);
const P84 = core.ALL_PATCHES.find((item) => item.id === 84);

/** 夹具的官方原文：把 id 83 的 pattern 当作宿主原文那一段。 */
function officialText() {
  return `// pre\n${P83.replacements[0].pattern}\n// post\n`;
}

/**
 * 一台「官方原文还在旁边、现场已打到目标态」的假宿主。
 *
 * 快照（`.dshpurge.bak` 旁车 + 来源标记）是这条判据的前提：自证只认白名单来源的官方原文，
 * 且不接受「快照就是现场本身」那一份。
 */
function makeProofFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp36-replay-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wp36-home-"));
  const fp = path.join(root, "lib", "main.js");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const official = officialText();
  const afterFirst = core.applyReplacementsToText(official, P83, fp, { markerTrusted: false }).text;
  const live = core.applyReplacementsToText(afterFirst, P84, fp, { markerTrusted: false }).text;
  fs.writeFileSync(fp, live, "utf8");
  fs.writeFileSync(`${fp}.dshpurge.bak`, official, "utf8");
  fs.writeFileSync(
    `${fp}.dshpurge.json`,
    JSON.stringify({ path: fp, at: "2026-01-01T00:00:00.000Z", source: "first-seen-clean" }),
    "utf8",
  );
  return { root, home, fp, official, afterFirst, live };
}

/** 上一代（换表之前）留下的账本：逐条指纹与当前表对不上，写入清单里也没有这两条。 */
function oldLedger() {
  return {
    version: "2.2.0",
    sha: "rev-old-table",
    tableSha: "f".repeat(64),
    patchShas: { "83": "0".repeat(64), "84": "0".repeat(64) },
    patchesWritten: [],
    patchesSettled: [],
    contentSha: {},
    migratedAt: "2026-01-01T00:00:00.000Z",
  };
}

function cleanup(...dirs) {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }
}

test("同一文件两条补丁、后者改写前者产物 → 两条都判 applied（旧账本拦不住）", () => {
  const host = makeProofFixture();
  try {
    // 夹具自检：现场必须真的体现「后一条改写了前一条的产物」，
    // 否则这条用例什么都没测到。
    assert.ok(host.live.includes(P83.markers[0]), "夹具里没有 id 83 的 marker");
    assert.ok(host.live.includes(P84.markers[0]), "夹具里没有 id 84 的 marker");
    assert.notEqual(host.live, host.afterFirst, "id 84 没有改写 id 83 的产物，夹具形状不对");
    const soloReplay = core.applyReplacementsToText(host.official, P83, host.fp, { markerTrusted: false }).text;
    assert.notEqual(
      soloReplay,
      host.live,
      "单条补丁重放竟与现场相同 —— 这条用例就测不到「后一条改写前一条产物」了",
    );

    const opts = { patches: [P83, P84], dshHome: host.home };
    assert.equal(
      core.contentOutcomeOf(host.live, P83, host.fp, oldLedger(), opts),
      "applied",
      "id 83 的产物被 id 84 改写过，文件级自证必须仍然认它",
    );
    assert.equal(
      core.contentOutcomeOf(host.live, P84, host.fp, oldLedger(), opts),
      "applied",
      "id 84 是这份文件的最后一个改写者，同样必须认它",
    );
  } finally {
    cleanup(host.root, host.home);
  }
});

test("反例：现场只到半途 → 不许判 applied（自证不放宽）", () => {
  const host = makeProofFixture();
  try {
    const opts = { patches: [P83, P84], dshHome: host.home };
    // 现场只有 id 83 的产物：这份字节不是**这一版表**的产物（84 还没落地），不许判 applied。
    assert.notEqual(
      core.contentOutcomeOf(host.afterFirst, P83, host.fp, oldLedger(), opts),
      "applied",
      "现场不是这一版表的产物，内容自证不许放行",
    );
  } finally {
    cleanup(host.root, host.home);
  }
});

test("一条 onMiss=fail 真打不上：整轮仍失败，其余文件的事实进账本，下一轮不自锁", async () => {
  const aiBase = fs.mkdtempSync(path.join(os.tmpdir(), "wp36-ai-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wp36-ledger-"));
  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_SURFACE: process.env.DSH_SURFACE };
  process.env.DSH_HOME = home;
  process.env.DSH_SURFACE = "desktop";
  try {
    // 两条真补丁，各自独占一个目标文件（表里已核：这两个 key 只被一条补丁用）。
    const GOOD = core.ALL_PATCHES.find((item) => item.id === 18);
    const BAD = core.ALL_PATCHES.find((item) => item.id === 19);
    assert.ok(GOOD && BAD, "表里找不到 id 18 / 19");
    assert.equal(BAD.onMiss, undefined, "id 19 的 onMiss 变了：这条用例的前提是「真打不上就判失败」");

    const goodPath = path.join(aiBase, "dsh-repeat-tool-reminder", "lib", "index.js");
    const badPath = path.join(aiBase, "dsh-compaction-tool-result-pruner", "lib", "index.js");
    fs.mkdirSync(path.dirname(goodPath), { recursive: true });
    fs.mkdirSync(path.dirname(badPath), { recursive: true });
    // 好的那条：官方原文就位，这一轮会被真写进去。
    fs.writeFileSync(goodPath, `${GOOD.replacements[0].pattern}\n`, "utf8");
    // 坏的那条：文件在、锚点不在 —— onMiss=fail 的那一档。
    fs.writeFileSync(badPath, "// 这里没有 id 19 的锚点\n", "utf8");

    const report = await core.applyPatches(aiBase, core.ALL_PATCHES, { dshHome: home });
    const summary = core.summarizeApplyReport(report);
    assert.ok(summary.failed.length > 0, "onMiss=fail 真打不上，整轮必须判失败");
    const goodRow = report.find((row) => row.patch_id === GOOD.id);
    assert.equal(goodRow.status, "applied", "能打上的那条这一轮必须真写进去");

    // 收尾记账：这一轮不干净，但事实要落账。
    const evidence = core.collectApplyEvidence([{ report }]);
    const round = reapply.recordApplyRound({
      entry: "cli",
      runId: "apply-20260101T000000Z-fa11",
      report,
      evidence,
      hostWritten: true,
      roundFailed: true,
    });
    assert.equal(round.clean, false, "有一条真打不上，这一轮不许算干净轮");
    assert.equal(round.error, "", "写失败轮事实时报错了");

    const stamp = JSON.parse(fs.readFileSync(path.join(home, "dsh-purge", "applied.json"), "utf8"));
    assert.ok(
      stamp.patchesWritten.includes(String(GOOD.id)),
      "其余文件真写过的补丁必须进账本 —— 不然下一轮仍然认证不了它",
    );
    assert.ok(
      Object.hasOwn(stamp.contentSha || {}, fileContentKey(goodPath)),
      "本轮写过的文件要留下字节指纹，下一轮靠它分辨文件有没有被动过",
    );
    assert.ok(!stamp.run_id, "失败轮不许占住「最后一次成功 apply」的身份");

    // 下一轮：真写过的那条不许再挂 pending（这就是自锁的判据）。
    const status = await core.patchStatus(aiBase, core.ALL_PATCHES, { dshHome: home });
    assert.equal(status[GOOD.id], "applied", "本轮真写过的补丁下一轮又挂 pending —— 自锁没解开");
    const pending = Object.entries(status)
      .filter(([, value]) => value === "pending")
      .map(([id]) => id);
    assert.deepEqual(pending, [], `下一轮不该剩下任何待应用，实测 ${pending.join(",") || "（空）"}`);
  } finally {
    if (previous.DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous.DSH_HOME;
    if (previous.DSH_SURFACE === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previous.DSH_SURFACE;
    cleanup(aiBase, home);
  }
});
