/**
 * test/revert-parity-outlets.test.mjs — 「已还原」的判据必须出现在用户能看到的出口上。
 *
 * 为什么单独立一份：`revertContentParity` 已经能判「文件与官方快照是否逐字节相同」，
 * 但它原先只进 `revert.end` 诊断字段 —— CLI 打印四个计数、HTTP 回包四个计数，
 * 判据成立而结论没人看得见。这里把三个出口钉住：
 *   1. 跨宿主合成只有一份实现：任一判红 → ok=false；有不可判文件 → complete=false；
 *   2. `dsh-purge --revert` 的 stdout 含 parity 段，有判红文件时退出码非 0；
 *   3. `/dsh-purge/revert` 的回包带 parity 字段（用源码接线断言，路由本身要宿主才能起）。
 *
 * CLI 用 `DSH_PURGE_REVERT_BASES` 把枚举收窄到夹具宿主：本机同时装着真实桌面端，
 * 靠默认枚举跑一遍会真的动到它 —— 判据不能以「测试不许碰现场」为代价。
 */
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeRevertParity } from "../lib/patch/rollup.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 最小宿主：`isAiBase` 要 instructions/lib，判据对象放在 agent-loop 里。 */
function makeHost(text) {
  const aiBase = join(mkdtempSync(join(tmpdir(), "wp3-parity-")), "node_modules", "@deepseek-ai");
  mkdirSync(join(aiBase, "dsh-agent-instructions", "lib"), { recursive: true });
  const fp = join(aiBase, "dsh-agent-loop", "lib", "index.js");
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, text, "utf8");
  return { aiBase, fp };
}

/**
 * 在隔离子进程里跑 CLI。
 *
 * 主目录与 ProgramFiles 一起指到临时目录：`findDesktopAppExecutable` 会按这些环境变量
 * 猜安装位置，只改 DSH_HOME 挡不住它找到本机真实桌面端。
 */
function runCli(mode, aiBase, home) {
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_BASE: aiBase,
    DSH_PURGE_REVERT_BASES: aiBase,
    DSH_SURFACE: "desktop",
    USERPROFILE: join(home, "user"),
    LOCALAPPDATA: join(home, "local"),
    APPDATA: join(home, "roaming"),
    ProgramFiles: join(home, "pf"),
    "ProgramFiles(x86)": join(home, "pf86"),
  };
  delete env.DSH_DESKTOP_INSTALL;
  delete env.DSH_PURGE_DEEP_AIBASE_SCAN;
  return spawnSync(process.execPath, [join(ROOT, "bin", "dsh-purge.js"), mode], {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: 120000,
  });
}

test("判据合成：任一宿主判红 → ok=false；有不可判文件 → complete=false", () => {
  const red = summarizeRevertParity([
    { ok: true, complete: true, mismatched: [], unscanned: [] },
    { ok: false, complete: false, mismatched: [["C:/host/a.js", "differs-from-snapshot"]], unscanned: [] },
  ]);
  assert.equal(red.ok, false, "一台宿主判红时整体不许说已还原");
  assert.deepEqual(red.mismatched, [["C:/host/a.js", "differs-from-snapshot"]], "判红文件要能点名");
  assert.equal(red.complete, false);

  const unscanned = summarizeRevertParity([{ ok: true, complete: false, mismatched: [], unscanned: ["C:/host/b.js"] }]);
  assert.equal(unscanned.ok, true, "不可判不是判红");
  assert.equal(unscanned.complete, false, "不可判不许冒充全量核对通过");
  assert.deepEqual(unscanned.unscanned, ["C:/host/b.js"]);

  const empty = summarizeRevertParity([]);
  assert.equal(empty.ok, true);
  assert.equal(empty.complete, false, "没有宿主时「没东西可判」不等于全量通过");
});

test("红灯：CLI --revert 输出 parity 段，判红文件时退出码非 0", () => {
  const home = mkdtempSync(join(tmpdir(), "wp3-parity-home-"));
  const { aiBase } = makeHost("// [dsh-purge] leftover-without-snapshot\n");
  const run = runCli("--revert", aiBase, home);
  assert.equal(run.error, undefined, `CLI 起不来：${run.error}`);
  const out = `${run.stdout}\n${run.stderr}`;
  assert.match(out, /parity/i, `--revert 的输出里没有 parity 段：\n${out}`);
  assert.match(out, /ok=false/, `判红文件必须体现在 ok=false：\n${out}`);
  assert.match(out, /leftover-purge-marker/, `判红原因没打印：\n${out}`);
  assert.notEqual(run.status, 0, "有判红文件时退出码必须非 0");
});

test("CLI --revert：没有判红文件时退出码仍为 0（完整仍可因不可判为 false）", () => {
  const home = mkdtempSync(join(tmpdir(), "wp3-parity-home-"));
  const { aiBase } = makeHost("const plain = true;\n");
  const run = runCli("--revert", aiBase, home);
  assert.equal(run.error, undefined, `CLI 起不来：${run.error}`);
  const out = `${run.stdout}\n${run.stderr}`;
  assert.match(out, /parity/i, `--revert 的输出里没有 parity 段：\n${out}`);
  assert.match(out, /ok=true/, `没有判红文件时 ok 应为 true：\n${out}`);
  assert.equal(run.status, 0, "没有判红文件时不许把退出码弄成非 0");
});

test("CLI --uninstall：同样打印 parity，判红文件时退出码非 0", () => {
  const home = mkdtempSync(join(tmpdir(), "wp3-parity-home-"));
  const { aiBase } = makeHost("// [dsh-purge] leftover-without-snapshot\n");
  const run = runCli("--uninstall", aiBase, home);
  assert.equal(run.error, undefined, `CLI 起不来：${run.error}`);
  const out = `${run.stdout}\n${run.stderr}`;
  assert.match(out, /parity/i, `--uninstall 的输出里没有 parity 段：\n${out}`);
  assert.match(out, /ok=false/, `判红文件必须体现在 ok=false：\n${out}`);
  assert.notEqual(run.status, 0, "有判红文件时卸载命令也要把退出码带出去");
});

test("HTTP revert 回包接线：响应带 parity 四项", () => {
  const source = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  assert.match(source, /summarizeRevertParity/, "HTTP 还原路由没有走 parity 合成");
  const route = source.slice(source.indexOf('path: "/dsh-purge/revert"'));
  const body = route.slice(0, route.indexOf("}, \"dsh-purge: revert\")"));
  assert.match(body, /result\.parity = summarizeRevertParity\(parity\)/, "/dsh-purge/revert 的回包没有 parity 字段");
  assert.match(body, /\.\.\.result/, "parity 算出来了却没有并进回包");
});
