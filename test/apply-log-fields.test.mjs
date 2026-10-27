/**
 * test/apply-log-fields.test.mjs — apply 两条边界事件上新加的字段：成功路径也留版本对照，
 * 以及「这一轮改了文件、要不要重启才生效」。
 *
 * 版本对照那半走真路径：夹具宿主的版本与补丁表要求不一致，门禁在写盘前整体拒绝，
 * 却能完整走过 apply.start → apply.hosts → apply.gate.reject，正好落在本文件要观测的
 * 那一段，且不产生任何宿主副作用。
 *
 * 「生效判据」那半不能这样测：要走到 apply.end 就得让门禁放行，而放行之后引擎会枚举到
 * 本机真实安装树并对它 backupAll —— 一次实测就把 66 份 .dshpurge.bak 写进真机宿主目录
 * （已清理，摘要里如实记了）。所以这里分两层：判据本身按纯函数逐档验，接线由字段块断言
 * 锁住 —— 单看任何一层都不够，两层合起来才等于「字段存在且取值正确」。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pendingRestartOf } from "../lib/core.js";

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function diagRows(home) {
  try {
    return fs.readFileSync(path.join(home, "dsh-purge", "logs", "diag.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** 造一个版本明确不匹配的假宿主：门禁拒绝发生在写盘之前，观测面只有三条事件。 */
function makeMismatchedHost(root) {
  const aiBase = path.join(root, "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.join(aiBase, "dsh-agent-instructions", "lib"), { recursive: true });
  fs.writeFileSync(path.join(aiBase, "dsh-agent-instructions", "lib", "index.js"), "export const x = 1;\n");
  fs.writeFileSync(
    path.join(aiBase, "dsh-agent-instructions", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-agent-instructions", version: "0.3.0" }),
  );
  return aiBase;
}

test("apply.start 就带版本对照：字段名与 apply.gate.reject 逐字一致，值也对得上", async () => {
  const core = await import("../lib/core.js");
  const root = makeTemp("dsh-purge-fields-host-");
  const home = makeTemp("dsh-purge-fields-home-");
  const previousBase = process.env.DSH_BASE;
  const previousSurface = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "desktop";
  try {
    const aiBase = makeMismatchedHost(root);
    process.env.DSH_BASE = aiBase;
    await assert.rejects(
      () => core.applyPatchesAllHosts(core.ALL_PATCHES, { dshHome: home }),
      (error) => error.code === "DSH_PURGE_HOST_VERSION_MISMATCH",
    );

    const rows = diagRows(home);
    const start = rows.find((row) => row.event === "apply.start");
    const reject = rows.find((row) => row.event === "apply.gate.reject");
    assert.ok(start, `临时 home 里没有 apply.start：${rows.map((row) => row.event).join(", ")}`);
    assert.ok(reject, "临时 home 里没有 apply.gate.reject —— 夹具没走到门禁那一段");

    // 成功路径也要有正向证据：这两个键缺一个，「门禁过了」就只剩缺席证明。
    assert.ok(Object.prototype.hasOwnProperty.call(start, "hostVersion"), "apply.start 缺 hostVersion");
    assert.ok(Object.prototype.hasOwnProperty.call(start, "dshTarget"), "apply.start 缺 dshTarget");
    assert.equal(start.hostVersion, "0.3.0", `apply.start 的宿主版本读错了：${start.hostVersion}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"));
    assert.equal(start.dshTarget, pkg.dshTarget, "apply.start 的 dshTarget 与 package.json 不一致");
    // 两条事件对读：字段名一致才叫「对得上」，否则读者要自己猜哪个是哪个。
    assert.equal(start.hostVersion, reject.hostVersion);
    assert.equal(start.dshTarget, reject.dshTarget);
  } finally {
    if (previousBase === undefined) delete process.env.DSH_BASE;
    else process.env.DSH_BASE = previousBase;
    if (previousSurface === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previousSurface;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pendingRestart：只有真改动过文件（status=applied）才算「要重启才可能生效」", () => {
  assert.equal(pendingRestartOf([{ status: "applied" }]), true, "改了一个文件就必须判 true");
  assert.equal(pendingRestartOf([{ status: "already" }, { status: "applied" }]), true, "有一条改动就够");
  // 一条都没改：重启也不会让宿主多读到任何东西，所以是 false，不是「不确定」。
  for (const status of ["already", "skipped", "missing_file", "pattern_not_found", "na", "off"]) {
    assert.equal(pendingRestartOf([{ status }]), false, `${status} 不该被判成要重启`);
  }
  // 读写失败是「没判出来」，不是「改了」：原子写没落地，不该拿它当改动证据。
  assert.equal(pendingRestartOf([{ status: "read_error" }]), false);
  assert.equal(pendingRestartOf([{ status: "write_error:EACCES" }]), false);
  assert.equal(pendingRestartOf([]), false);
  assert.equal(pendingRestartOf(null), false);
  assert.equal(pendingRestartOf(undefined), false);
});

test("apply.end 的字段块接上了两处判据：pendingRestart 与 asarSealed", () => {
  // 这一层只能按字段块判：真跑一次成功 apply 就会碰本机真实安装树（见文件头）。
  const core = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "core.js"), "utf8");
  assert.ok(
    core.includes("pendingRestart: pendingRestartOf(merged)"),
    "apply.end 没有接上 pendingRestart —— 字段没接线的判据等于没有",
  );
  assert.ok(
    core.includes("asarSealed: asarSealedForLog()"),
    "apply.end 没有接上 asarSealed —— 密封形态那一档读不出来",
  );
  assert.ok(
    core.includes("...gateVersionPairForLog(options)"),
    "apply.start 没有接上版本对照 —— 成功那轮又只剩缺席证明",
  );
});
