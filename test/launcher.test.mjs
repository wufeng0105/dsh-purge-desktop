/**
 * 启动器解析的判据锁。
 *
 * 为什么值得单独测：`--unseal` 之后 `dsh` 命令全线失效这件事，根因就是启动器里写死了
 * `app.asar`。这个解析函数是 `--diagnose` 唯一能看见那个耦合的地方；
 * 它一旦判错，人就会以为「CLI 坏了是别的原因」，而实际只是归档被挪走了。
 */
import { test } from "node:test";
import assert from "node:assert";

import { inspectLauncher, parseLauncherTarget } from "../lib/launcher.js";

const ASAR_CMD = [
  "@echo off",
  "setlocal DisableDelayedExpansion",
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
  "exit /b %errorlevel%",
].join("\r\n");

const APP_CMD = ASAR_CMD.replace("app.asar\\dsh", "app\\dsh");

test("指向 app.asar 的启动器判成 asar（解封后会失效的形态）", () => {
  const parsed = parseLauncherTarget(ASAR_CMD);
  assert.equal(parsed.kind, "asar");
  assert.ok(parsed.evidence.includes("app.asar"), `evidence 没抓到关键行：${parsed.evidence}`);
});

test("指向解包目录的启动器判成 app", () => {
  const parsed = parseLauncherTarget(APP_CMD);
  assert.equal(parsed.kind, "app", `解包形态被误判：${JSON.stringify(parsed)}`);
  assert.ok(!parsed.evidence.includes("app.asar"));
});

test("空文件与无关内容一律 unknown，不许瞎猜", () => {
  assert.equal(parseLauncherTarget("").kind, "unknown");
  assert.equal(parseLauncherTarget("@echo off\r\necho hi\r\n").kind, "unknown");
});

test("三个启动器形态混着 = 不一致（改了一半那种）", () => {
  const texts = { "dsh.cmd": ASAR_CMD, "dsh.ps1": ASAR_CMD, dsh: APP_CMD };
  const stub = (fp) => {
    const name = fp.split(/[\\/]/).pop();
    if (!(name in texts)) throw new Error("ENOENT");
    return texts[name];
  };
  const mixed = inspectLauncher("C:\\fake\\bin", stub);
  assert.equal(mixed.exists, true);
  assert.equal(mixed.consistent, false, `混着还判一致，等于把「改了一半」吞掉：${JSON.stringify(mixed.kinds)}`);
  assert.deepEqual([...mixed.kinds].sort(), ["app", "asar"]);

  const allAsar = inspectLauncher("C:\\fake\\bin", () => ASAR_CMD);
  assert.equal(allAsar.consistent, true);
  assert.deepEqual(allAsar.kinds, ["asar"]);

  const empty = inspectLauncher("C:\\fake\\bin", () => {
    throw new Error("ENOENT");
  });
  assert.equal(empty.exists, false);
  assert.equal(empty.consistent, false);
});
