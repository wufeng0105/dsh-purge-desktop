/**
 * 契约：web CLI 宿主面已移除，只剩 desktop。
 *
 * DELETE-3 删了三个文件（260 行）：
 *   lib/web.js              （重启适配器：探测端口、spawn 重启、开浏览器）
 *   lib/restart-web.js      （重启 helper）
 *   lib/uninstall-restart.js（卸载后重启 helper）
 *
 * ⚠️ 删的是 **`dsh web` CLI 宿主面**，不是 Web UI 层。下面这些必须还在（SURFACE-4）：
 *   - client.js（浏览器 bundle，桌面端 Electron 也加载）
 *   - package.json 的 dsh.client.platform: "web"
 *   - webServer 注入（index.js / redteam/ui.js）
 *   - identity.js 的 "web GUI" 提示词文案
 *
 * 本文件同时锁「删干净了」与「没删错」两件事 —— 后者比前者更容易出事。
 */
import { test } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DELETED = ["lib/web.js", "lib/restart-web.js", "lib/uninstall-restart.js"];

/**
 * DELETE-3 之后的 `lib/**\/*.js` 基线文件集合（2026-10-22，50 个）。
 *
 * ## 为什么是「集合超集」而不是「数量上限」
 *
 * 这里原来的断言是 `files.length <= 50`，而实际正好 50 —— **零余量**。
 * 补丁表外置成 `lib/patch/table.js` 与 `patch/constants.js` 时第一步就撞上。
 * 那不是本测试的意图：
 * 数量上限既拦不住「删了又加回来」的回归，又会把合理的新增误判成退化。
 *
 * 本测试的原始意图是 **DELETE-3 的删除成果不许被加回来**。所以改成集合语义：
 *   - 删文件 → 不再是超集 → 红（这正是要拦的）
 *   - 加文件 → 仍是超集 → 绿（这是正常开发）
 *
 * ## 维护约定
 *
 * **真要删文件时，必须同步把这里对应的一行删掉。** 会红是设计意图，
 * 不是误报 —— 让你在删掉一个 lib 文件时被迫确认「这不是 DELETE-3 的成果」。
 * 加文件不用改这里。
 */
const BASELINE_FILES = [
  "lib/asset-table.js",
  "lib/atomic-fs.js",
  "lib/capability-protocol.js",
  "lib/continue-retry.js",
  "lib/core.js",
  "lib/desktop.js",
  "lib/drill-grant.js",
  "lib/extract-asar.js",
  "lib/hide-console.js",
  "lib/hooks-deny.js",
  "lib/host-clean.js",
  "lib/host-version.js",
  "lib/host.js",
  // 路径层 + 目标文件表（host/），提示词文本清洗（prompt/）。
  "lib/host/paths.js",
  "lib/host/targets.js",
  "lib/prompt/text.js",
  "lib/identity.js",
  "lib/index.js",
  "lib/mnemon-settings.js",
  "lib/net-scope.js",
  "lib/official-update.js",
  "lib/phase1-keep.js",
  "lib/preset-default.js",
  "lib/reapply-cli.js",
  "lib/reapply.js",
  "lib/redteam/client.js",
  "lib/redteam/index.js",
  "lib/redteam/ip-utils.js",
  "lib/redteam/platform-config.js",
  "lib/redteam/preset-composition.js",
  "lib/redteam/report-replay.js",
  "lib/redteam/role-section.js",
  "lib/redteam/schema.js",
  "lib/redteam/score-rules.js",
  "lib/redteam/settings.js",
  "lib/redteam/skill-availability.js",
  "lib/redteam/skill-fixes.js",
  "lib/redteam/store-core.js",
  "lib/redteam/store.js",
  "lib/redteam/tools.js",
  "lib/redteam/ui.js",
  "lib/redteam/validate.js",
  "lib/restart-desktop.js",
  "lib/rewind.js",
  "lib/rules.js",
  "lib/settle-policy.js",
  "lib/skills.js",
  "lib/surface.js",
  "lib/table-key.js",
  "lib/table-read.js",
  "lib/uninstall.js",
  "lib/update.js",
  "lib/zip-extract.js",
];

/** SURFACE-4 反向红线：这些必须存在，删了桌面端会一起死。 */
const MUST_KEEP = [
  "client.js",
  "lib/desktop.js",
  "lib/restart-desktop.js",
];

test("DELETE-3：三个 web 适配器文件已删除", () => {
  for (const rel of DELETED) {
    assert.equal(existsSync(join(ROOT, rel)), false, `${rel} 还在，DELETE-3 没删干净`);
  }
});

test("DELETE-3：SURFACE-4 反向红线 —— 这些文件不许删", () => {
  for (const rel of MUST_KEEP) {
    assert.equal(existsSync(join(ROOT, rel)), true, `${rel} 被误删了，桌面端会挂`);
  }
});

test("DELETE-3：package.json 的 dsh.client.platform 仍是 web（桌面端也在用）", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(
    pkg.dsh?.client?.platform,
    "web",
    "platform 改成别的会让桌面端加载不到 UI —— 它指的是浏览器 bundle，不是宿主面",
  );
  // client 注入列表也必须在
  assert.ok(Array.isArray(pkg.dsh.client.inject));
  assert.ok(pkg.dsh.client.inject.length > 0, "client.inject 空了，UI 加载会断");
});

test("DELETE-3：exports 里 ./client 仍在（桌面端 Electron 加载它）", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.exports["./client"], "./client.js");
});

test("DELETE-3：webServer 注入仍在（桌面端也跑 webServer，端口常见 43120）", () => {
  const indexSrc = readFileSync(join(ROOT, "lib/index.js"), "utf8");
  assert.match(indexSrc, /inject\(\["webServer"\]/, "index.js 的 webServer 注入没了");
  const uiSrc = readFileSync(join(ROOT, "lib/redteam/ui.js"), "utf8");
  assert.match(uiSrc, /inject\s*=\s*\[[^\]]*'webServer'/, "redteam/ui.js 的 webServer 注入没了");
});

test("DELETE-3：identity.js 的 web GUI 提示词文案仍在（那是宿主文本，不是宿主面判定）", () => {
  const src = readFileSync(join(ROOT, "lib/identity.js"), "utf8");
  assert.match(src, /web GUI/i, "identity.js 的 web GUI 文案被误删 —— 它会改变注入内容");
});

test("DELETE-3：lib/ 里不再 import 已删除的三个文件", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const rel = full.slice(ROOT.length + 1).replace(/\\/g, "/");
      const code = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (/from\s+["']\.{1,2}\/(web|restart-web|uninstall-restart)\.js["']/.test(code)) {
        offenders.push(rel);
      }
    }
  };
  walk(join(ROOT, "lib"));
  assert.deepEqual(offenders, [], `这些文件还在 import 已删除的模块：${offenders.join(", ")}`);
});

test("DELETE-3：lib/ 里不再主动发现 profiles/web 的补丁目标", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const rel = full.slice(ROOT.length + 1).replace(/\\/g, "/");
      const code = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      // 字面量 "profiles", "web" 是主动发现；pathZone 的正则是防护，不算
      if (/"profiles"\s*,\s*"web"/.test(code)) offenders.push(rel);
      if (/of\s+\[\s*"web"\s*,\s*"desktop"\s*\]/.test(code)) offenders.push(rel);
    }
  };
  walk(join(ROOT, "lib"));
  assert.deepEqual(
    [...new Set(offenders)],
    [],
 `这些文件还在主动发现 web profile 的补丁目标（会制造僵尸状态，DELETE-4）：${[...new Set(offenders)].join(", ")}`,
  );
});

test("DELETE-3：pathZone 仍拒绝写 web 侧路径（保护遗留数据，不是主动发现）", async () => {
  const core = await import("../lib/core.js");
  // profiles/web 仍被判成 web-profile —— 这是护栏，保证遗留数据不被误改
  assert.equal(core.pathZone("C:/Users/a/.dsh/profiles/web/package.json"), "web-profile");
  assert.equal(core.pathZone("/usr/lib/npm-global/x"), "web-install");
  // 桌面宿主拒绝写它们
  assert.equal(core.allowTargetPath("C:/Users/a/.dsh/profiles/web/package.json", "desktop"), false);
  assert.equal(core.allowTargetPath("/usr/lib/npm-global/x", "desktop"), false);
});

test("DELETE-3：host.js 只剩 desktop 适配器，非桌面面显式抛错", async () => {
  const host = await import("../lib/host.js");
  // 桌面面能拿到三个方法
  assert.equal(typeof host.isDesktop, "function");
  const adapter = host.hostAdapter("desktop");
  assert.equal(typeof adapter.scheduleRestart, "function");
  assert.equal(typeof adapter.scheduleCleanupRestart, "function");
  assert.equal(typeof adapter.restartNote, "function");
  // 非桌面面必须抛错，不许静默降级到 desktop
  for (const surface of ["web", "gui", "tui"]) {
    assert.throws(
      () => host.hostAdapter(surface),
      /不支持的宿主面/,
      `hostAdapter("${surface}") 应显式抛错，而不是静默降级`,
    );
  }
});

test("DELETE-3：lib/ 仍包含基线文件集合（删文件才红，加文件不红）", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(join(ROOT, "lib"));

  // 统一成 posix 相对路径再比，避免 Windows 反斜杠造成假红。
  const actual = new Set(files.map((f) => f.slice(ROOT.length + 1).replace(/\\/g, "/")));

  // 基线里必须有、实际却没有的 → 删除成果被加回来，或又被删了
  const missing = BASELINE_FILES.filter((f) => !actual.has(f));
  assert.deepEqual(
    missing,
    [],
    "这些基线文件不见了（DELETE-3 删过的不许回来，新增过的不许消失；"
    + "如果确实要删，同步改 BASELINE_FILES）：\n  " + missing.join("\n  "),
  );

  // 关键：三个 web 文件必须真的不在里面（超集断言不替代这一条）
  const names = files.map((f) => f.split(/[\\/]/).pop());
  for (const gone of ["web.js", "restart-web.js", "uninstall-restart.js"]) {
    assert.equal(names.includes(gone), false, `${gone} 还在 lib/ 里`);
  }
});
