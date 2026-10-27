/**
 * test/host-install-health.test.mjs — 「这棵宿主安装树还能启动吗」的唯一判据。
 *
 * 为什么单独立一份：官方升级把 `resources/runtime` 清成空目录之后，插件当时能说的只有
 * 「补丁没对齐」—— 那是在描述另一件事。现场（崩溃日志原文）：宿主的 `dsh-skill-office`
 * 在启动时无条件读 `runtime/office-skills/office/SKILL.md`，缺一个文件就整进程 fatal。
 *
 * 判据只有一条：**宿主启动时真会读的东西，在不在，且不是空目录**。
 * 这里逐档钉住：健康 / runtime 空 / runtime 缺件 / 归档压住补丁树 / 解封态 / 没有 resources；
 * 以及恢复命令从官方更新器的 `pending/update-info.json` 推出来的那一条。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RUNTIME_KEY_ASSET,
  inspectHostInstall,
  readUnsealedMarker,
  unsealedMarkerPath,
  writeUnsealedMarker,
} from "../lib/host/install-health.js";

const RES = path.join("C:", "Harness", "resources");
const EXE = path.join("C:", "Harness", "DeepSeek Harness.exe");
const CACHE = path.join("C:", "cache", "dsh-updater");

/**
 * 内存文件树。`dirs` 是目录 → 子项名字；`files` 是文件 → 内容。
 * 判据本身不碰真盘，所以夹具只需要回答 exists / isDir / stat / list / readText。
 */
function fakeIo({ dirs = {}, files = {} } = {}) {
  const norm = (p) => String(p).replace(/\\/g, "/");
  const dirMap = new Map(Object.entries(dirs).map(([k, v]) => [norm(k), v]));
  const fileMap = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    exists: (p) => dirMap.has(norm(p)) || fileMap.has(norm(p)),
    isDir: (p) => dirMap.has(norm(p)),
    stat: (p) => {
      if (dirMap.has(norm(p))) return { size: 0, isDir: true, mtimeMs: 0 };
      if (fileMap.has(norm(p))) return { size: fileMap.get(norm(p)).length, isDir: false, mtimeMs: 0 };
      return null;
    },
    list: (p) => dirMap.get(norm(p)) || [],
    readText: (p) => {
      if (!fileMap.has(norm(p))) throw new Error(`ENOENT ${p}`);
      return fileMap.get(norm(p));
    },
    env: { LOCALAPPDATA: path.join("C:", "cache") },
  };
}

/** 健康的安装树：归档在、补丁树不在、runtime 五项齐全且关键资产在。 */
function healthyTree(overrides = {}) {
  return {
    dirs: {
      [RES]: ["app.asar", "runtime", "app-update.yml"],
      [path.join(RES, "runtime")]: ["versions.json", "bin", "cli", "office-skills", "primary-runtime"],
      [path.join(RES, "runtime", ...RUNTIME_KEY_ASSET.slice(0, 2))]: [RUNTIME_KEY_ASSET[2]],
      ...(overrides.dirs || {}),
    },
    files: {
      [path.join(RES, "app.asar")]: "x".repeat(64),
      [path.join(RES, "app-update.yml")]: "provider: generic\nchannel: nightly\nupdaterCacheDirName: dsh-updater\n",
      [path.join(RES, "runtime", ...RUNTIME_KEY_ASSET)]: "# office",
      ...(overrides.files || {}),
    },
  };
}

function inspect(tree, options = {}) {
  return inspectHostInstall(EXE, { io: fakeIo(tree), ...options });
}

test("健康：归档在、runtime 五项齐全 → ok，且记下更新通道", () => {
  const tree = inspect(healthyTree());
  assert.equal(tree.ok, true);
  assert.equal(tree.reason, "ok");
  assert.equal(tree.runtime.missing.length, 0);
  assert.equal(tree.unsealed, false);
  assert.equal(tree.updater.channel, "nightly", "通道要从 app-update.yml 读出来");
});

test("变砖现场：runtime 是空目录 → ok 为假、点名空目录、给出可执行恢复命令", () => {
  const tree = healthyTree();
  tree.dirs[path.join(RES, "runtime")] = [];
  // 更新器的待装包：恢复命令就是从这两样推出来的。
  tree.dirs[CACHE] = ["pending"];
  tree.dirs[path.join(CACHE, "pending")] = ["update-info.json", "harness-0.2.1-rc.3-win-x64.exe"];
  tree.files[path.join(CACHE, "pending", "update-info.json")] = JSON.stringify({
    fileName: "harness-0.2.1-rc.3-win-x64.exe",
    sha512: "AA==",
  });
  const report = inspect(tree);
  assert.equal(report.ok, false);
  assert.equal(report.reason, "runtime-empty");
  assert.match(report.detail, /空目录/);
  assert.match(report.remedy, /harness-0\.2\.1-rc\.3-win-x64\.exe" \/S --updated/, "恢复命令要指到那个包");
});

test("runtime 缺关键资产 → 点名缺的那个文件（崩溃日志里那一行）", () => {
  const tree = healthyTree();
  tree.dirs[path.join(RES, "runtime", "office-skills")] = ["office"];
  tree.dirs[path.join(RES, "runtime", "office-skills", "office")] = [];
  delete tree.files[path.join(RES, "runtime", ...RUNTIME_KEY_ASSET)];
  const report = inspect(tree);
  assert.equal(report.ok, false);
  assert.equal(report.reason, "runtime-incomplete");
  assert.match(report.detail, /office-skills\/office\/SKILL\.md/, "缺的是哪一个必须说得出");
  assert.match(report.remedy, /重新运行官方安装包/, "没有待装包时只能说「重跑安装包」");
});

test("归档与解开的目录同时在 → 归档压住补丁树（不是坏了，是白写）", () => {
  const tree = healthyTree();
  tree.dirs[path.join(RES, "app")] = ["dsh"];
  const report = inspect(tree);
  assert.equal(report.ok, false);
  assert.equal(report.reason, "archive-shadows-app");
  assert.match(report.remedy, /app\.asar\.bak/);
});

test("解封态：归档不在、.bak 在、补丁树在 → 仍算健康，但标明「升级前要先恢复归档」", () => {
  const tree = healthyTree();
  tree.dirs[RES] = ["runtime", "app", "app-update.yml"];
  tree.dirs[path.join(RES, "app")] = ["dsh"];
  delete tree.files[path.join(RES, "app.asar")];
  tree.files[path.join(RES, "app.asar.bak")] = "y".repeat(64);
  const report = inspect(tree);
  assert.equal(report.ok, true, "解封态本身不是故障：补丁树在、runtime 齐");
  assert.equal(report.reason, "unsealed");
  assert.equal(report.unsealed, true);
  assert.match(report.remedy, /app\.asar\.bak 改回 app\.asar/);
});

test("没有 resources 目录 → 不是「没事」，是「没判」", () => {
  const report = inspect({ dirs: {}, files: {} });
  assert.equal(report.ok, false);
  assert.equal(report.reason, "no-resources");
  assert.equal(report.remedy, "", "连树都没有时不许编一条恢复命令出来");
});

test("unseal 标记：写进去能读回来，坏数据读成 null（不是「没标记」）", () => {
  // 这一条走真实文件系统：标记的读写本来就是磁盘行为，用假 io 测不出往返。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp13-marker-"));
  try {
    assert.equal(writeUnsealedMarker(dir, { asar: path.join(dir, "app.asar"), size: 7 }), true);
    const marker = readUnsealedMarker(dir);
    assert.equal(marker.size, 7);
    assert.match(marker.asar, /app\.asar$/);
    assert.equal(unsealedMarkerPath(dir), path.join(dir, "dsh-purge-unsealed.json"), "落点固定在 resources 下");
    fs.writeFileSync(unsealedMarkerPath(dir), "{not json", "utf8");
    assert.equal(readUnsealedMarker(dir), null, "坏标记读成 null —— 它与「没标记」不是同一件事，但在归因上等价");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
