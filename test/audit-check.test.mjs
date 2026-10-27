/**
 * 审计日志完整性判定的行为判据：断号、坏行、末行截断各有一条会真红的用例。
 *
 * 全部夹具在系统临时目录里现造，跑完即删 —— 审计目录是运行期数据，
 * 测试连读都不去读真实装机目录，否则「本机恰好没有日志」会被当成判据成立。
 *
 * 「命令崩了」和「判据不过」必须分得开：坏行那条用例同时断言另外两件判据照常输出，
 * 因为一份日志里有一行坏了，读者仍然需要知道序号断没断、末行全不全。
 */
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAuditCli } from "../lib/audit/index.js";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "dsh-purge.js");
const TS = "2026-10-25T18:00:00.000+08:00";

/** 一条最小事件：判定只看 seq，其余字段取合法形状即可。 */
const eventLine = (seq) => JSON.stringify({ ts: TS, seq, event: "code.probe", result: "ok" });

/** 造一份干净日志：seq 从 0 到 count-1，末行带换行。 */
function writeClean(target, count) {
  const lines = [];
  for (let seq = 0; seq < count; seq += 1) lines.push(eventLine(seq));
  writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
  return lines;
}

/** 捕获两路输出与退出码；用例只断言「码 + 输出」，不碰真实 stdout。 */
function run(argv) {
  const out = [];
  const err = [];
  const code = runAuditCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

/** 取以某个标签开头的输出行；缺了就是判据没输出，直接红。 */
function labeled(out, label) {
  const hit = out.find((line) => line.startsWith(label));
  assert.ok(hit, `输出里没有「${label}」这一行：\n${out.join("\n")}`);
  return hit;
}

/** 每个用例一个临时目录，结束即删；用例之间互不共享文件。 */
function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-purge-audit-check-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("干净文件：seq 密集、每行可解析、末行带换行 → 退出码 0", () => {
  withDir((dir) => {
    const file = join(dir, "2026-10-25.jsonl");
    writeClean(file, 5);

    const plain = run(["check", "--jsonl", file]);
    assert.equal(plain.code, 0, plain.err.join("\n"));
    assert.equal(labeled(plain.out, "gaps: "), "gaps: []");
    assert.equal(labeled(plain.out, "badLines: "), "badLines: []");
    assert.equal(labeled(plain.out, "lastLineTerminated: "), "lastLineTerminated: true");

    const structured = run(["check", "--jsonl", file, "--json"]);
    assert.equal(structured.code, 0);
    const report = JSON.parse(structured.out.join("\n"));
    assert.equal(report.ok, true);
    assert.equal(report.mode, "file");
    assert.deepEqual(report.files[0].gaps, []);
    assert.deepEqual(report.files[0].badLines, []);
    assert.equal(report.files[0].lastLineTerminated, true);
    assert.equal(report.files[0].seq.min, 0);
    assert.equal(report.files[0].seq.max, 4);
  });
});

test("删中间一行：缺口就是被删的序号 → 退出码 1", () => {
  withDir((dir) => {
    const file = join(dir, "2026-10-25.jsonl");
    const lines = writeClean(file, 5);
    // 删掉 seq=1：它是奇数位，把「步长」判错的人会得到空缺口，这条用例正对着那种改法。
    writeFileSync(file, `${lines.filter((_, index) => index !== 1).join("\n")}\n`, "utf8");

    const result = run(["check", "--jsonl", file]);
    assert.equal(result.code, 1);
    assert.equal(labeled(result.out, "gaps: "), "gaps: [1]");
    assert.equal(labeled(result.out, "badLines: "), "badLines: []");
    assert.equal(labeled(result.out, "lastLineTerminated: "), "lastLineTerminated: true");
    assert.equal(labeled(result.out, "ok: "), "ok: false");
  });
});

test("追加一行坏 JSON：只报它自己，另外两件判据照常输出 → 退出码 1", () => {
  withDir((dir) => {
    const file = join(dir, "2026-10-25.jsonl");
    const lines = writeClean(file, 6);
    writeFileSync(file, `${lines.join("\n")}\n{坏\n`, "utf8");

    const result = run(["check", "--jsonl", file]);
    assert.equal(result.code, 1);
    assert.equal(labeled(result.out, "badLines: "), "badLines: [7]");
    // 坏行不许拖垮其余判定：序号仍然密集，末行仍然带换行。
    assert.equal(labeled(result.out, "gaps: "), "gaps: []");
    assert.equal(labeled(result.out, "lastLineTerminated: "), "lastLineTerminated: true");
    assert.equal(result.err.length, 0, "坏行是判据结论，不是环境错误");
  });
});

test("末行换行被截掉：lastLineTerminated=false → 退出码 1", () => {
  withDir((dir) => {
    const file = join(dir, "2026-10-25.jsonl");
    writeClean(file, 3);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.slice(0, -1), "utf8");

    const result = run(["check", "--jsonl", file]);
    assert.equal(result.code, 1);
    assert.equal(labeled(result.out, "lastLineTerminated: "), "lastLineTerminated: false");
    // 截掉的只是换行：最后一行本身仍然解析得出来，序号也仍然密集。
    assert.equal(labeled(result.out, "gaps: "), "gaps: []");
    assert.equal(labeled(result.out, "badLines: "), "badLines: []");
  });
});

test("目录模式：每个文件各自从 0 起判，汇总点名未终止末行的文件", () => {
  withDir((dir) => {
    const older = join(dir, "2026-10-24.jsonl");
    const newer = join(dir, "2026-10-25.jsonl");
    writeClean(older, 3);
    writeClean(newer, 3);

    // 两个文件各自 0..2：按全局累计判的话，后一份会假报断号。
    const clean = run(["check", "--dir", dir]);
    assert.equal(clean.code, 0, clean.err.join("\n"));
    assert.equal(
      labeled(clean.out, "files: "),
      "files: 2 / gaps: 共 0 / badLines: 共 0 / 未终止末行: 无",
    );

    // 一份删掉 seq=1，另一份截掉末行换行：两种残缺必须分别点名。
    writeFileSync(newer, `${[eventLine(0), eventLine(2)].join("\n")}`, "utf8");
    const broken = run(["check", "--dir", dir]);
    assert.equal(broken.code, 1);
    assert.equal(labeled(broken.out, "gaps: "), "gaps: 共 1");
    assert.equal(labeled(broken.out, "lastLineTerminated: "), "lastLineTerminated: false");
    assert.match(labeled(broken.out, "files: "), /未终止末行: 2026-10-25\.jsonl$/);
    assert.ok(
      broken.out.some((line) => line.includes("2026-10-24.jsonl") && line.includes("seq=0..2")),
      "干净的那份不该被坏的那份带偏",
    );
  });
});

test("用法与环境错误：退出码 2，不是「判据不过」的 1", () => {
  withDir((dir) => {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    const cases = [
      ["check", "--jsonl"],
      ["check", "--nope"],
      ["check", "--jsonl", join(dir, "missing.jsonl")],
      ["check", "--dir", join(dir, "missing-dir")],
      ["check", "--dir", empty],
      ["check", "--jsonl", join(dir, "a.jsonl"), "--dir", dir],
      ["bogus"],
    ];
    for (const argv of cases) {
      const result = run(argv);
      assert.equal(result.code, 2, `${argv.join(" ")} 应为 2，实为 ${result.code}`);
      assert.ok(result.err.length > 0, `${argv.join(" ")} 必须给出错误说明而不是静默`);
    }
  });
});

test("真命令行：bin 把退出码与判据原样带到进程退出码上", () => {
  withDir((dir) => {
    const file = join(dir, "2026-10-25.jsonl");
    writeFileSync(file, `${[eventLine(0), eventLine(2)].join("\n")}\n`, "utf8");
    // 关掉诊断日志：这条用例碰的是真进程，不该往用户目录里写任何东西。
    const env = { ...process.env, DSH_PURGE_LOG: "0" };

    const broken = spawnSync(process.execPath, [BIN, "audit", "check", "--jsonl", file], { encoding: "utf8", env });
    assert.equal(broken.status, 1, broken.stderr);
    assert.match(broken.stdout, /^gaps: \[1\]$/m);

    writeClean(file, 3);
    const clean = spawnSync(process.execPath, [BIN, "audit", "check", "--jsonl", file], { encoding: "utf8", env });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /^lastLineTerminated: true$/m);
  });
});
