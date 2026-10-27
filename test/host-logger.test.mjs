/**
 * test/host-logger.test.mjs — 关键事件镜像到宿主日志面板，且拿不到 ctx.logger 时静默保持原行为。
 *
 * 宿主接口取自 Cordis：`ctx.logger(name)` 返回具名 logger，带 info / warn / error / debug。
 * 这里用一个记录调用的假 logger 验三件事：只镜像关键事件（逐条 apply.patch 不进面板）、
 * 失败档走 warn、摘掉之后不再转发。真实宿主面板由真机验证，不在本文件的能力范围。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { diagLog } from "../lib/diag-log.js";
import { clearHostLogger, hostLoggerOf, installHostLogger } from "../lib/host-logger.js";

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeHost() {
  const calls = [];
  const logger = {
    info: (...args) => calls.push(["info", ...args]),
    warn: (...args) => calls.push(["warn", ...args]),
    error: (...args) => calls.push(["error", ...args]),
    debug: (...args) => calls.push(["debug", ...args]),
  };
  return {
    calls,
    ctx: { logger: (name) => { logger.named = name; return logger; } },
  };
}

test("拿到 ctx.logger：apply 起止与门禁拒绝进面板，逐条 apply.patch 不进", () => {
  const home = makeTemp("dsh-purge-hostlog-home-");
  const previous = process.env.DSH_PURGE_LOG_FILE;
  const host = fakeHost();
  try {
    delete process.env.DSH_PURGE_LOG_FILE;
    const installed = installHostLogger(host.ctx, { dshHome: home });
    assert.deepEqual(installed, { installed: true });

    diagLog("apply.start", { patches: 66 }, home);
    diagLog("apply.patch", { id: 1, status: "applied" }, home);
    diagLog("apply.end", { applied: 54, failed: 0, pendingRestart: true }, home);
    diagLog("apply.gate.reject", { rejected: "C:/host" }, home);

    assert.equal(host.calls.length, 3, `镜像条数不对：${JSON.stringify(host.calls)}`);
    assert.deepEqual(host.calls.map((call) => call[0]), ["info", "info", "warn"]);
    assert.match(host.calls[0][2], /apply\.start .*patches=66/);
    assert.match(host.calls[1][2], /apply\.end .*pendingRestart=true/);
    assert.match(host.calls[2][2], /apply\.gate\.reject .*rejected=C:\/host/);
  } finally {
    clearHostLogger();
    if (previous === undefined) delete process.env.DSH_PURGE_LOG_FILE;
    else process.env.DSH_PURGE_LOG_FILE = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("摘掉镜像后不再转发；没有 ctx.logger 时安装结果是未安装", () => {
  const home = makeTemp("dsh-purge-hostlog-home-");
  const host = fakeHost();
  try {
    installHostLogger(host.ctx, { dshHome: home });
    clearHostLogger();
    diagLog("apply.end", { applied: 1 }, home);
    assert.equal(host.calls.length, 0, "摘掉后仍在转发");

    assert.equal(hostLoggerOf(null), null);
    assert.equal(hostLoggerOf({}), null);
    assert.deepEqual(installHostLogger({}, { dshHome: home }), { installed: false });
  } finally {
    clearHostLogger();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("镜像失败不影响落盘：logger 方法抛错时诊断轨照样有行", () => {
  const home = makeTemp("dsh-purge-hostlog-home-");
  try {
    installHostLogger({ logger: () => ({ info: () => { throw new Error("panel down"); } }) }, { dshHome: home });
    const written = diagLog("apply.end", { applied: 2 }, home);
    assert.ok(written, "写盘被镜像异常带走了");
    assert.ok(fs.readFileSync(written, "utf8").includes('"event":"apply.end"'));
  } finally {
    clearHostLogger();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("装没装成留一条自己的记录：host.logger（真机靠它区分「没接线」与「宿主不落盘」）", () => {
  const home = makeTemp("dsh-purge-hostlog-home-");
  const read = () => fs.readFileSync(path.join(home, "dsh-purge", "logs", "diag.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.event === "host.logger");
  try {
    installHostLogger(fakeHost().ctx, { dshHome: home });
    clearHostLogger();
    const ok = read();
    assert.equal(ok.length, 1, `装了镜像却没留记录：${JSON.stringify(ok)}`);
    assert.equal(String(ok[0].installed), "true");

    installHostLogger({}, { dshHome: home });
    const bad = read();
    assert.equal(bad.length, 2);
    assert.equal(String(bad[1].installed), "false");
    assert.match(String(bad[1].reason), /ctx\.logger/, "没装成时要说清是拿不到服务，而不是「宿主不写日志」");
  } finally {
    clearHostLogger();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
