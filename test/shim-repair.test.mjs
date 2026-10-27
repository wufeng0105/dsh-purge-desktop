/**
 * shim 写回的三条路，全部在临时目录里造，不碰真实宿主。
 *
 * 这三种情形对应真机上的三次观测：
 *   A 目标 .js 还在（asar 没改名）→ 什么都不做；
 *   B 目标没了、文件可写 → 原地截断写成功；
 *   C 目标没了、文件被独占占用 → 落 pending，状态 deferred，补落盘后 pending 消失。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  flushPending,
  parseTargetPath,
  pendingStatus,
  targetIsValid,
  writeShimInPlace,
} from "../lib/host/shim-repair.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-shim-"));

test("A：shim 指向的目标存在 → 判定有效、整段跳过", () => {
  const dir = tmp();
  try {
    const target = path.join(dir, "cli.js");
    fs.writeFileSync(target, "// host cli", "utf8");
    const shim = `@echo off\r\nnode "${target}" %*\r\n`;
    assert.equal(parseTargetPath(shim), target);
    assert.equal(targetIsValid(shim), true, "目标在，就不该进入写回");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("B：目标不存在且可写 → 原地写成功，内容等于期望值", () => {
  const dir = tmp();
  try {
    const target = path.join(dir, "cli.js");
    const shimPath = path.join(dir, "dsh.cmd");
    fs.writeFileSync(shimPath, "old", "utf8");
    const shim = `@echo off\r\nnode "${target}" %*\r\n`;
    assert.equal(targetIsValid(shim), false, "目标不在，应进入写回");
    const r = writeShimInPlace(shimPath, shim, path.join(dir, "shims"));
    assert.equal(r.status, "ok");
    assert.equal(fs.readFileSync(shimPath, "utf8"), shim);
    assert.equal(pendingStatus(path.join(dir, "shims")), null, "成功时不该留 pending");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C：目标不存在且被独占占用 → deferred + pending，补落盘后 pending 消失", () => {
  const dir = tmp();
  try {
    const target = path.join(dir, "cli.js");
    const shimPath = path.join(dir, "dsh.cmd");
    fs.writeFileSync(shimPath, "old", "utf8");
    const shim = `@echo off\r\nnode "${target}" %*\r\n`;
    const pendingDir = path.join(dir, "shims");
    // 模拟「cmd.exe 正占用该文件」：改成只读，Open("w") 会 EACCES/EPERM。
    // 不用独占句柄 —— 同一进程内的句柄共享写权限，模拟不出来。
    fs.chmodSync(shimPath, 0o444);
    const r = writeShimInPlace(shimPath, shim, pendingDir);
    assert.equal(r.status, "deferred", `被占用时应 deferred，实际 ${r.status}${r.error ? "：" + r.error : ""}`);
    const pendingFile = path.join(pendingDir, "dsh.cmd.pending");
    assert.ok(fs.existsSync(pendingFile), "pending 文件应存在");
    assert.equal(fs.readFileSync(pendingFile, "utf8"), shim, "pending 内容应等于期望内容");
    assert.equal(pendingStatus(pendingDir)?.status, "deferred");

    // 补落盘：此时没有进程占用（恢复可写）
    fs.chmodSync(shimPath, 0o666);
    const flushed = flushPending(pendingDir);
    assert.deepEqual(flushed.flushed, [shimPath]);
    assert.equal(fs.existsSync(pendingFile), false, "落盘成功后 pending 应删除");
    assert.equal(fs.readFileSync(shimPath, "utf8"), shim, "目标内容应更新");
    assert.equal(pendingStatus(pendingDir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
