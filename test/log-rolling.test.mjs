/**
 * test/log-rolling.test.mjs — 两个写入器共用一份滚动规格，产物落在 DSH 主目录。
 *
 * 为什么存在：判据有两半，缺一半都能假绿 ——
 *   一、行为：两个写入器在同一阈值上滚成 `.1`，且第二次滚动能覆盖旧 `.1`
 *      （Windows 的 rename 不能覆盖已存在目标，旧实现第二次必然失败）；
 *   二、结构：阈值、保留代数与检查频率只在 lib/log-rolling.js 里定义一次，
 *      两个写入器都不许再写自己的常量。
 *
 * 全部在临时目录里跑；DSH_PURGE_LOG_FILE 每例都复原。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { diagLog, diagLogPath } from "../lib/diag-log.js";
import { LOG_ROLLING, rotateIfNeeded, shouldCheckSize } from "../lib/log-rolling.js";
import { purgeLog, purgeLogPath } from "../lib/purge-log.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("规格：三个数字是一份冻结常量，两个写入器都从同一模块取", () => {
  assert.ok(LOG_ROLLING.maxBytes > 0);
  assert.equal(LOG_ROLLING.generations, 8, "代数决定保留多久：单代 4 MB 折约 5.8 小时，1 代的话装完隔天就查不到了");
  assert.ok(LOG_ROLLING.checkEvery > 0);
  assert.ok(Object.isFrozen(LOG_ROLLING), "规格被改写成可变对象后，两个写入器可以各改各的");
  assert.equal(shouldCheckSize(LOG_ROLLING.checkEvery), true);
  assert.equal(shouldCheckSize(LOG_ROLLING.checkEvery + 1), false);

  for (const rel of ["lib/diag-log.js", "lib/purge-log.js"]) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(source.includes('from "./log-rolling.js"'), `${rel} 没有从唯一规格模块取滚动逻辑`);
    assert.ok(!/2\s*<<\s*20/.test(source), `${rel} 又写了一份 2MB 阈值`);
    assert.ok(!/4\s*<<\s*20/.test(source), `${rel} 又写了一份 4MB 阈值`);
    assert.ok(!/renameSync\(/.test(source), `${rel} 自己实现了一遍滚动`);
  }
});

test("动作：超过上限滚成 .1；第二次滚动覆盖旧 .1 而不是失败", () => {
  const dir = makeTemp("dsh-purge-roll-");
  const file = path.join(dir, "a.log");
  try {
    fs.writeFileSync(file, "x".repeat(64));
    assert.equal(rotateIfNeeded(file, { maxBytes: 16, generations: 1 }), true);
    assert.ok(fs.existsSync(`${file}.1`));
    assert.equal(fs.existsSync(file), false, "滚动后原文件应被改名，而不是复制");
    assert.equal(fs.readFileSync(`${file}.1`, "utf8").length, 64);

    fs.writeFileSync(file, "y".repeat(32));
    assert.equal(rotateIfNeeded(file, { maxBytes: 16, generations: 1 }), true, "第二次滚动失败：旧 .1 挡住了 rename");
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "y".repeat(32));

    // 没超限时不动文件。
    fs.writeFileSync(file, "z");
    assert.equal(rotateIfNeeded(file, { maxBytes: 16, generations: 1 }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("落点：purgeLog 写 <dshHome>/dsh-purge/logs/desktop.log，不再是系统临时目录", () => {
  const home = makeTemp("dsh-purge-roll-home-");
  try {
    const written = purgeLog("probe", { where: "home" }, home);
    assert.equal(written, purgeLogPath(home));
    assert.equal(diagLogPath(home), path.join(home, "dsh-purge", "logs", "diag.jsonl"));
    assert.equal(path.dirname(written), path.dirname(diagLogPath(home)), "两份日志应在同一层目录");
    assert.ok(fs.readFileSync(written, "utf8").includes("[probe] where=home"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("行为：两个写入器都在同一阈值上滚动（真实写入各 128 次）", () => {
  const home = makeTemp("dsh-purge-roll-home-");
  const previous = process.env.DSH_PURGE_LOG_FILE;
  try {
    delete process.env.DSH_PURGE_LOG_FILE;
    const diag = diagLogPath(home);
    const desktop = purgeLogPath(home);
    fs.mkdirSync(path.dirname(diag), { recursive: true });
    // 先写超上限，再触发一次「满 128 次」的检查点。
    fs.writeFileSync(diag, "x".repeat(LOG_ROLLING.maxBytes + 1));
    fs.writeFileSync(desktop, "x".repeat(LOG_ROLLING.maxBytes + 1));
    for (let index = 0; index < LOG_ROLLING.checkEvery; index += 1) {
      diagLog("roll.probe", { index }, home);
      purgeLog("roll.probe", { index }, home);
    }
    assert.ok(fs.existsSync(`${diag}.1`), "诊断轨没有滚动");
    assert.ok(fs.existsSync(`${desktop}.1`), "探针日志没有滚动");
    assert.ok(fs.statSync(diag).size < LOG_ROLLING.maxBytes, "滚动后诊断轨应从新文件重新开始");
    assert.ok(fs.statSync(desktop).size < LOG_ROLLING.maxBytes, "滚动后探针日志应从新文件重新开始");
  } finally {
    if (previous === undefined) delete process.env.DSH_PURGE_LOG_FILE;
    else process.env.DSH_PURGE_LOG_FILE = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
