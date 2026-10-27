/**
 * test/apply-empty-selection.test.mjs — 「一条补丁都没得打」不许写盘。
 *
 * 为什么单独立一份：一次空探测（`applyPatchesAllHosts([])`）曾经在本机真宿主树上
 * 留下 66 份 `.dshpurge.bak` 与 69 条 vault 条目 —— 门禁放行、备份照跑、补丁一条不落，
 * 而这一轮连一条判定都没产生。判据因此分两层：
 *   一、返回空结果，并在诊断轨里说清「为什么没打」（`apply.end.reason`）；
 *   二、`.bak`、vault 目录与安装指纹一个都不出现 —— 空探测不是一轮 apply。
 *
 * 夹具刻意做成「门禁会放行」的宿主：版本对齐、目标文件真实存在且是官方原文。
 * 这样 `.bak` 会不会出现只取决于短路有没有生效，而不取决于门禁有没有挡住。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { diagLogPath } from "../lib/diag-log.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DSH_TARGET = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).dshTarget;

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 一个版本对齐、目标文件是官方原文的假宿主：门禁会放行，backupAll 会动真格。 */
function makeAlignedHost(root) {
  const aiBase = path.join(root, "node_modules", "@deepseek-ai");
  const pkgDir = path.join(aiBase, "dsh-agent-instructions");
  fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-agent-instructions", version: DSH_TARGET }),
  );
  fs.writeFileSync(path.join(pkgDir, "lib", "index.js"), "export const x = 1;\n");
  return aiBase;
}

function readDiag(home) {
  try {
    return fs.readFileSync(diagLogPath(home), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function walkFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

test("空补丁数组：不备份、不写 vault、不记安装指纹，只留一条说明", async () => {
  const core = await import("../lib/core.js");
  const root = makeTemp("dsh-purge-empty-host-");
  const home = makeTemp("dsh-purge-empty-home-");
  const aiBase = makeAlignedHost(root);
  const previousBase = process.env.DSH_BASE;
  const previousSurface = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "desktop";
  process.env.DSH_BASE = aiBase;
  try {
    const result = await core.applyPatchesAllHosts([], { dshHome: home });
    assert.deepEqual(result.hosts, [], "空补丁不该产生任何宿主轮次");
    assert.deepEqual(result.report, [], "空补丁不该产生逐条报告");

    const backups = walkFiles(root).filter((file) => file.endsWith(".dshpurge.bak"));
    assert.deepEqual(backups, [], `空补丁留下了备份文件：${backups.join(", ")}`);

    const vault = path.join(home, "dsh-purge", "host-backups");
    const vaultEntries = fs.existsSync(vault) ? fs.readdirSync(vault) : [];
    assert.deepEqual(vaultEntries, [], `空补丁写进了 vault：${vaultEntries.join(", ")}`);

    const installState = path.join(home, "dsh-purge", "install-state.json");
    assert.equal(fs.existsSync(installState), false, "空补丁不该写安装指纹");

    const rows = readDiag(home);
    const end = rows.find((row) => row.event === "apply.end");
    assert.ok(end, `诊断轨里没有 apply.end：${rows.map((row) => row.event).join(", ")}`);
    assert.equal(String(end.total), "0");
    assert.equal(String(end.reason), "no_patches_given", "没说清为什么一条补丁都没打");
    assert.equal(rows.some((row) => row.event === "install.record"), false, "空补丁记了安装指纹");
  } finally {
    if (previousBase === undefined) delete process.env.DSH_BASE;
    else process.env.DSH_BASE = previousBase;
    if (previousSurface === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previousSurface;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("全部补丁被 hooks-deny 过滤掉时同样短路（reason=all_patches_filtered）", async () => {
  const core = await import("../lib/core.js");
  const root = makeTemp("dsh-purge-filtered-host-");
  const home = makeTemp("dsh-purge-filtered-home-");
  const aiBase = makeAlignedHost(root);
  const previousBase = process.env.DSH_BASE;
  const previousSurface = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "desktop";
  process.env.DSH_BASE = aiBase;
  try {
    // selectPatches 一个都不收：与「补丁表是空的」区分开，短路要能说出是哪一种。
    const result = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      dshHome: home,
      hooksDeny: { selectPatches: () => [] },
    });
    assert.deepEqual(result.hosts, []);
    const end = readDiag(home).find((row) => row.event === "apply.end");
    assert.equal(String(end.reason), "all_patches_filtered");
  } finally {
    if (previousBase === undefined) delete process.env.DSH_BASE;
    else process.env.DSH_BASE = previousBase;
    if (previousSurface === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previousSurface;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("保险柜跟着注入的 dshHome 走：临时 home 里出现备份，真 home 不被写", async () => {
  // 事故根因：`backupAll` 原先固定用 `findDshHome()` 定保险柜，于是「临时 dshHome 的测试」
  // 仍会把备份写进开发机真实 `~/.dsh/dsh-purge/host-backups`。判据落在「备份落在谁家」。
  const core = await import("../lib/core.js");
  const root = makeTemp("dsh-purge-vault-host-");
  const home = makeTemp("dsh-purge-vault-home-");
  const aiBase = makeAlignedHost(root);
  try {
    const result = await core.backupAll(aiBase, { dshHome: home });
    assert.ok(result.made.length > 0, "夹具上一条备份都没造出来，判据跑空了");
    const vault = path.join(home, "dsh-purge", "host-backups");
    const entries = fs.existsSync(vault) ? fs.readdirSync(vault).filter((name) => name.endsWith(".json")) : [];
    assert.ok(entries.length > 0, "注入的 dshHome 下没有保险柜条目：备份又写到别处去了");
    for (const name of entries) {
      const meta = JSON.parse(fs.readFileSync(path.join(vault, name), "utf8"));
      assert.ok(
        String(meta.path).toLowerCase().startsWith(root.toLowerCase()),
        `保险柜条目指向了夹具之外：${meta.path}`,
      );
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
