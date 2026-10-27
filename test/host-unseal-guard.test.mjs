/**
 * test/host-unseal-guard.test.mjs — 解封是稳态，官方更新器是外部 actor：相撞要在还能启动时留证据。
 *
 * 现场（真实崩溃日志）：官方升级把 `resources/runtime` 清成空目录之后，宿主启动直接 fatal
 * （`dsh-skill-office` 无条件读 `runtime/office-skills/office/SKILL.md`）。而「解封」不是偶发的
 * 手工动作 —— 一轮清洗干净之后插件自己就把 `app.asar` 挪走了，之后宿主长期读解开的目录。
 * 更新器在后台把包下到 `pending/`，下次退出就装。两者相撞的窗口是**每一次官方升级**。
 *
 * 插件拦不住官方更新器，所以这一档的判据只有两条：
 *   一、交换之前把「我把归档挪走了」记下来（否则事后没人答得出 asar 是谁挪的）；
 *   二、盘上有待装包时，把包路径与恢复命令写进诊断轨与返回面 —— 那一刻宿主还活着。
 *
 * 判据落在 `core.scheduleSealedDesktopRestart`：手工 `--unseal` 与面板点「应用」后的自动交换
 * 都走这一条，检查只该有一处。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describeUnsealedRisk, pendingOfficialUpdate } from "../lib/host/install-health.js";
import { scheduleSealedDesktopRestart } from "../lib/core.js";

/** 内存 IO：只回答判据要问的那几项。 */
function fakeIo({ dirs = {}, files = {} } = {}) {
  const norm = (p) => String(p).replace(/\\/g, "/");
  const dirMap = new Map(Object.entries(dirs).map(([k, v]) => [norm(k), v]));
  const fileMap = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    exists: (p) => dirMap.has(norm(p)) || fileMap.has(norm(p)),
    isDir: (p) => dirMap.has(norm(p)),
    stat: (p) => (dirMap.has(norm(p))
      ? { size: 0, isDir: true, mtimeMs: 0 }
      : (fileMap.has(norm(p)) ? { size: fileMap.get(norm(p)).length, isDir: false, mtimeMs: 0 } : null)),
    list: (p) => dirMap.get(norm(p)) || [],
    readText: (p) => {
      if (!fileMap.has(norm(p))) throw new Error(`ENOENT ${p}`);
      return fileMap.get(norm(p));
    },
    env: { LOCALAPPDATA: path.join("C:", "cache") },
  };
}

const RES = path.join("C:", "Harness", "resources");
const EXE = path.join("C:", "Harness", "DeepSeek Harness.exe");
const CACHE = path.join("C:", "cache", "dsh-updater");

function treeWithPending({ unsealed = false } = {}) {
  const dirs = {
    [RES]: unsealed ? ["runtime", "app", "app-update.yml"] : ["app.asar", "runtime", "app-update.yml"],
    [path.join(RES, "runtime")]: ["versions.json", "bin", "cli", "office-skills", "primary-runtime"],
    [path.join(RES, "runtime", "office-skills", "office")]: ["SKILL.md"],
    [CACHE]: ["pending"],
    [path.join(CACHE, "pending")]: ["update-info.json", "harness-0.2.1-rc.3-win-x64.exe"],
  };
  if (unsealed) dirs[path.join(RES, "app")] = ["dsh"];
  const files = {
    [path.join(RES, "app-update.yml")]: "provider: generic\nchannel: nightly\nupdaterCacheDirName: dsh-updater\n",
    [path.join(RES, "runtime", "versions.json")]: "{}",
    [path.join(RES, "runtime", "office-skills", "office", "SKILL.md")]: "# skill",
    [path.join(CACHE, "pending", "update-info.json")]: JSON.stringify({ fileName: "harness-0.2.1-rc.3-win-x64.exe" }),
  };
  if (unsealed) files[path.join(RES, "app.asar.bak")] = "x".repeat(32);
  else files[path.join(RES, "app.asar")] = "x".repeat(64);
  return fakeIo({ dirs, files });
}

test("待装包：不看解封态也能判出来，并带上恢复命令", () => {
  const pending = pendingOfficialUpdate(EXE, { io: treeWithPending() });
  assert.ok(pending, "盘上有 pending 安装包时不许判成「没事」");
  assert.match(pending.installer, /harness-0\.2\.1-rc\.3-win-x64\.exe$/);
  assert.match(pending.recovery, /" \/S --updated$/);
  assert.equal(pending.channel, "nightly");
  // 没有待装包时是 null（不是「空字符串字段」）：调用方据此决定写不写日志。
  const clean = fakeIo({ dirs: { [RES]: ["app.asar", "runtime"] }, files: { [path.join(RES, "app.asar")]: "x" } });
  assert.equal(pendingOfficialUpdate(EXE, { io: clean }), null);
});

test("解封态风险：正在解封 + 有待装包才成立；归档还在原位时不算", () => {
  const atRisk = describeUnsealedRisk(EXE, { io: treeWithPending({ unsealed: true }) });
  assert.ok(atRisk, "解封态 + 待装包必须报出来");
  assert.match(atRisk.archiveBak, /app\.asar\.bak$/);
  assert.match(atRisk.recovery, /--updated/);
  assert.equal(describeUnsealedRisk(EXE, { io: treeWithPending({ unsealed: false }) }), null, "归档还在原位时不该报");
});

test("交换归档：先留标记再挪，且把待装包与恢复命令交回调用方", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unseal-guard-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "unseal-guard-home-"));
  const resources = path.join(root, "resources");
  fs.mkdirSync(path.join(resources, "runtime"), { recursive: true });
  const asar = path.join(resources, "app.asar");
  fs.writeFileSync(asar, "x".repeat(128), "utf8");
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const moved = scheduleSealedDesktopRestart({ asar, exe: path.join(root, "DeepSeek Harness.exe") });
    assert.equal(moved.renamed, true, `归档没被挪走：${JSON.stringify(moved)}`);
    assert.equal(fs.existsSync(`${asar}.bak`), true, "挪走之后应留下 .bak");
    // 一、标记：没有它，官方更新删掉 asar 之后没人说得清是谁挪的。
    const marker = JSON.parse(fs.readFileSync(path.join(resources, "dsh-purge-unsealed.json"), "utf8"));
    assert.equal(marker.size, 128, "标记要记下当时那份归档的尺寸");
    assert.match(marker.asar, /app\.asar$/);
    assert.equal(marker.state, "done", "挪成功了才写 done：这一句的强弱就是 state");
    // 二、本机没有配置更新器缓存 ⇒ 没有待装包，返回面也不许编一个出来。
    assert.equal(moved.updatePending, null);
    const diagFile = path.join(home, "dsh-purge", "logs", "diag.jsonl");
    const rows = fs.existsSync(diagFile)
      ? fs.readFileSync(diagFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    assert.equal(rows.some((row) => row.event === "host.update.pending"), false, "没有待装包时不写这一条");
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("挪不动时不许留下「是我挪的」：标记要如实写未确认，或者根本不写", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unseal-guard3-"));
  const resources = path.join(root, "resources");
  fs.mkdirSync(resources, { recursive: true });
  const asar = path.join(resources, "app.asar");
  fs.writeFileSync(asar, "z".repeat(32), "utf8");
  const markerPath = path.join(resources, "dsh-purge-unsealed.json");
  const handoff = { asar, exe: path.join(root, "DeepSeek Harness.exe") };
  try {
    // 一、归档被占用：挪不动，但已经排了「空闲时再挪」。标记要写 scheduled，不许写 done。
    const busy = scheduleSealedDesktopRestart(handoff, {
      rename: () => ({ renamed: false, busy: true, bak: `${asar}.bak` }),
      schedule: () => ({ pending: true }),
    });
    assert.equal(busy.renamed, false);
    assert.equal(busy.markerState, "scheduled");
    const scheduled = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(scheduled.state, "scheduled", "没挪成却写 done，就是留下一句假供词");
    assert.equal(fs.existsSync(asar), true, "这一档归档还在原位");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "unseal-guard4-"));
  const resources2 = path.join(root2, "resources");
  fs.mkdirSync(resources2, { recursive: true });
  const asar2 = path.join(resources2, "app.asar");
  fs.writeFileSync(asar2, "w".repeat(16), "utf8");
  try {
    // 二、归档本就不在（或非占用型失败）：这一轮什么都没发生 —— 一个字节都不许写。
    const nothing = scheduleSealedDesktopRestart(
      { asar: asar2, exe: path.join(root2, "DeepSeek Harness.exe") },
      { rename: () => ({ renamed: false }), schedule: () => { throw new Error("不该被调用"); } },
    );
    assert.equal(nothing.renamed, false);
    assert.equal(nothing.markerState, "");
    assert.equal(fs.existsSync(path.join(resources2, "dsh-purge-unsealed.json")), false,
      "什么都没发生时不许留标记：那是下一次排障时最难拆的一句谎");
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test("交换归档：盘上有待装包时，那一刻就把包与恢复命令写进诊断轨", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unseal-guard2-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "unseal-guard2-home-"));
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "unseal-guard2-cache-"));
  const resources = path.join(root, "resources");
  fs.mkdirSync(path.join(resources, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(resources, "app-update.yml"), "channel: nightly\nupdaterCacheDirName: dsh-updater\n", "utf8");
  const installerDir = path.join(cacheRoot, "dsh-updater", "pending");
  fs.mkdirSync(installerDir, { recursive: true });
  fs.writeFileSync(path.join(installerDir, "update-info.json"), JSON.stringify({ fileName: "harness-0.2.1-rc.3-win-x64.exe" }), "utf8");
  fs.writeFileSync(path.join(installerDir, "harness-0.2.1-rc.3-win-x64.exe"), "x", "utf8");
  const asar = path.join(resources, "app.asar");
  fs.writeFileSync(asar, "y".repeat(64), "utf8");
  const previous = { DSH_HOME: process.env.DSH_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.DSH_HOME = home;
  process.env.LOCALAPPDATA = cacheRoot;
  try {
    const moved = scheduleSealedDesktopRestart({ asar, exe: path.join(root, "DeepSeek Harness.exe") });
    assert.ok(moved.updatePending, "有待装包时返回面必须带上它（CLI 与面板都读这一项）");
    assert.match(moved.updatePending.installer, /harness-0\.2\.1-rc\.3-win-x64\.exe$/);
    assert.match(moved.updatePending.recovery, /--updated/);
    const rows = fs.readFileSync(path.join(home, "dsh-purge", "logs", "diag.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const row = rows.find((item) => item.event === "host.update.pending");
    assert.ok(row, "诊断轨里没有 host.update.pending：那一刻之后宿主可能再也起不来，没有第二次机会");
    assert.match(String(row.recovery), /--updated/);
    // 写的是结果不是意图：这一轮归档真的挪走了，所以是 done。
    assert.equal(String(row.outcome), "done", "诊断轨要写这一轮的结果，别写「正在解封」这种意图");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});
