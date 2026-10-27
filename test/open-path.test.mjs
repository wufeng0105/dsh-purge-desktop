/**
 * 打开目录的三条判据：命令行参数由服务端算、非法 kind 被拒、spawn 失败不抛。
 * 全部用注入的 spawn 假函数，不真的打开任何窗口。
 */
import { test } from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";

import { dirFor, openPathFor } from "../lib/open-path.js";

const HOME = path.join(os.tmpdir(), "dsh-home-fixture");

test("A：logs / config 的命令行参数分别是各自目录", () => {
  const calls = [];
  const fake = (cmd, args) => { calls.push({ cmd, args }); return { on() {}, unref() {} }; };
  const logs = openPathFor("logs", HOME, { spawnFn: fake, platform: "win32" });
  const config = openPathFor("config", HOME, { spawnFn: fake, platform: "win32" });
  assert.equal(logs.ok, true);
  assert.equal(config.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, "explorer");
  assert.deepEqual(calls[0].args, [path.join(HOME, "dsh-purge", "audit")]);
  assert.deepEqual(calls[1].args, [HOME]);
  // 非 Windows 分支
  const mac = [];
  openPathFor("logs", HOME, { spawnFn: (c, a) => { mac.push(c); return { on() {}, unref() {} }; }, platform: "darwin" });
  assert.deepEqual(mac, ["open"]);
});

test("B：kind 非法时被拒，不 spawn", () => {
  let spawned = 0;
  const fake = () => { spawned += 1; return { on() {}, unref() {} }; };
  const bad = openPathFor("logs/../..", HOME, { spawnFn: fake });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(dirFor("logs/../..", HOME), null);
  assert.equal(spawned, 0, "非法 kind 一律不许触发 spawn");
});

test("C：spawn 失败时返回 { ok:false, error }，不抛", () => {
  const fake = () => { throw new Error("spawn ENOENT"); };
  const r = openPathFor("logs", HOME, { spawnFn: fake });
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOENT/);
});
