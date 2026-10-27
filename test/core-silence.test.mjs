/**
 * 静默链路的「符号完整性」回归。
 *
 * 为什么这条测试必须存在：`silenceHost()` 把 core 的路径层能力（findAiBase / keepSurfaceFile …）
 * 打包成一个宿主对象交给 lib/shim/silence.js。路径搬到 lib/host/ 之后，core 的 import 里漏掉了
 * `keepSurfaceFile`，于是这条链路在真机上抛 `ReferenceError`。
 *
 * 三道既有门禁都抓不到它：`node --check` 只验语法；tsc 只覆盖 client.js（CONTRACT-7）；
 * `depcruise` 只看模块之间的边，看不到「用了没导入」。它一路活到真实官方桌面的
 * `ensureHostClean → silenceCmdFlash` 才炸，而那条路径恰好是全仓库唯一没有自动化兜底的链路。
 *
 * 这里在临时 DSH_HOME 上真的走一次静默链路：符号缺失会立刻抛 ReferenceError，
 * 符号齐了只会返回结构化的「没找到」，两层都不碰真实宿主。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../lib/core.js";

test("静默链路符号齐全：空 DSH_HOME 上 silenceMnemonGitFlash 不抛 ReferenceError", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-silence-"));
  try {
    const hit = core.silenceMnemonGitFlash(home);
    // 空目录里没有目标文件，正确答案是 missing / absent 这类结构化结果，而不是抛错。
    assert.equal(typeof hit, "string");
    assert.match(hit, /^(missing|absent|reverted|patched|already)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("静默链路不越界写盘：非宿主目录不会被当成候选文件", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-silence-"));
  const stray = path.join(home, "dsh.cmd");
  fs.writeFileSync(stray, "echo hi\n", "utf8");
  try {
    const hit = core.silenceMnemonGitFlash(home);
    assert.equal(typeof hit, "string");
    // 关键断言：临时目录下的同名文件一个字节都不许被改。
    assert.equal(fs.readFileSync(stray, "utf8"), "echo hi\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
