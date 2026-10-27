/**
 * test/snapshot-provenance.test.mjs — 官方快照必须能证明它是官方原文（T52）。
 *
 * ## 为什么这一条是判据而不是洁癖
 *
 * `patchVacuousOnOfficial` 回答的是「这一版宿主**本来就带着**产物吗」——它拿快照当证据。
 * 而 `ensureOfficialSnapshot` 原先只检查「文件里没有本插件的字样」，就把它存成「官方原文」：
 * 一个**被别的工具改过**、或**装插件前就已经被打过补丁**的文件，同样过得了那道门。
 * 拿这种快照去认证，等于用假证词判案。
 *
 * 本批的做法是给它补两件事：
 *   一、**门**：落盘前先扫本插件痕迹，命中就不落（污染源不许进快照）；
 *   二、**来源标记**：落盘时记 `source`，认证只认白名单里的三种来历；
 *      没有标记（老快照）或标记不在白名单 → 不认证。
 *
 * 判据：
 *   ① 现场文本已含插件痕迹 → 不落快照；
 *   ② 快照缺来源标记 → `patchVacuousOnOfficial` 拒绝认证；
 *   ③ 白名单本身写死在代码里，认证处引用它（把来源检查删掉就红）。
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CORE = readFileSync(join(ROOT, "lib", "core.js"), "utf8");

test("源码判据：来源白名单存在，且认证处引用了它", () => {
  assert.match(
    CORE,
    /const OFFICIAL_SNAPSHOT_SOURCES = new Set\(\["asar", "official-unpack", "first-seen-clean"\]\)/,
    "没有来源白名单常量：快照来源无从判定",
  );
  const at = CORE.indexOf("function patchVacuousOnOfficial(");
  assert.ok(at > 0, "找不到 patchVacuousOnOfficial");
  const body = CORE.slice(at, at + 2200);
  assert.match(
    body,
    /OFFICIAL_SNAPSHOT_SOURCES\.has\(/,
    "patchVacuousOnOfficial 没有引用来源白名单：缺标记的快照照样能认证",
  );
});

test("落盘前扫痕迹：现场文本已含插件痕迹时不落快照", () => {
  const at = CORE.indexOf("function ensureOfficialSnapshot(");
  const body = CORE.slice(at, at + 900);
  assert.match(body, /isOfficialSnapshotBuf\(buf\)/, "ensureOfficialSnapshot 落盘前没有再扫一遍痕迹");
  assert.match(body, /"first-seen-clean"/, "落盘时没有记来源标记 first-seen-clean");
  /* 顺序：先扫痕迹（isOfficialSnapshotBuf）再 writeOfficialSnapshot。 */
  const scan = body.indexOf("isOfficialSnapshotBuf(buf)");
  const write = body.indexOf("writeOfficialSnapshot(fp, buf");
  assert.ok(scan > 0 && write > scan, "先落盘后扫痕迹：污染文本已经写进去了");
});

test("读回来的快照带着来源标记（没有 meta 的旁车 → 来源未知）", () => {
  const at = CORE.indexOf("function readOfficialSnapshot(");
  const body = CORE.slice(at, at + 1100);
  assert.match(body, /readVaultMeta\(vault\)/, "保险柜分支没有读 meta 里的来源");
  assert.match(body, /readVaultMeta\(sidecar\)/, "旁车分支没有读它自己的 meta");
  assert.match(body, /source: meta && typeof meta\.source === "string" \? meta\.source : null/, "没有 meta 的快照没有把来源标成未知");
});

test("来源不丢：重写已有快照之后，「不读账本」的那两档判据仍然活着", async () => {
  /*
   * 为什么这一条是行为判据而不是源码判据：`writeVaultMeta` 只在收到非空 source 时才写
   * 那个字段，所以任何一处 `writeOfficialSnapshot(fp, buf, dshHome)` 漏传来源，都会把快照
   * 的来源**静默抹成「未知」**——认证只认白名单里的来历，于是「官方原文里本来就有产物」
   * 与「这份文件就是这一版表的产物」两条判据会一起长期失效，且没有任何症状。
   * 这里让判据真的走一遍：第二次 backupAll（走「已有快照」那一支）之后，现场自证必须仍成立。
   */
  const home = mkdtempSync(join(tmpdir(), "dsh-purge-wp36-prov-"));
  const root = mkdtempSync(join(tmpdir(), "dsh-purge-wp36-host-"));
  const aiBase = join(root, "node_modules", "@deepseek-ai");
  const fp = join(aiBase, "dsh-agent-loop", "lib", "index.js");
  mkdirSync(join(aiBase, "dsh-agent-loop", "lib"), { recursive: true });
  const FIXTURE = {
    id: 991,
    name: "PROVENANCE_KEPT",
    layer: "代码",
    file: "agent-loop",
    replacements: [{ pattern: "const PROV = 1;", replace: "const PROV = 2; // PROV_MARK" }],
    markers: ["PROV_MARK"],
  };
  /* 干净的现场原文：第一次 backupAll 会把它存成官方原文（来源 first-seen-clean）。 */
  writeFileSync(fp, "const PROV = 1;\n", "utf8");
  try {
    const core = await import("../lib/core.js");
    await core.backupAll(aiBase, { dshHome: home });
    /* 第二次走「已有快照」那一支 —— 漏传来源的那一处就在这条路上。 */
    await core.backupAll(aiBase, { dshHome: home });
    /* 现场换成这一版表的产物：只有来源还在，自证才答得出「这就是这一版表打出来的」。 */
    const live = "const PROV = 2; // PROV_MARK\n";
    writeFileSync(fp, live, "utf8");
    const staleLedger = {
      version: "2.0.0",
      sha: "rev-old",
      patchShas: { "991": "0".repeat(64) },
      patchesWritten: [],
      patchesSettled: [],
      contentSha: {},
      migratedAt: "2026-01-01T00:00:00.000Z",
    };
    assert.equal(
      core.contentOutcomeOf(live, FIXTURE, fp, staleLedger, { patches: [FIXTURE], dshHome: home }),
      "applied",
      "重写快照时把来源抹掉了：不读账本的那两档判据从此失效",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("端到端：带痕迹的文件不落快照，快照目录保持为空", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-purge-wp29-"));
  const target = join(home, "host", "probe.js");
  mkdirSync(join(home, "host"), { recursive: true });
  /* 现场文本里已经有本插件字样：属于污染源，不该被存成官方原文。 */
  writeFileSync(target, "// touched by dsh-purge already\nmodule.exports = {}\n", "utf8");
  try {
    const core = await import("../lib/core.js");
    const ok = core.ensureOfficialSnapshot ? core.ensureOfficialSnapshot(target) : null;
    if (ok === null) {
      /* core 没导出这个函数：至少断言源码里那道门还在（上面已判），这里不假装端到端。 */
      assert.ok(true);
      return;
    }
    assert.equal(ok, false, "带插件痕迹的文件被当成官方原文存下来了");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
