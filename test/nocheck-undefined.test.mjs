/**
 * test/nocheck-undefined.test.mjs — `@ts-nocheck` 文件的未定义符号判据。
 *
 * 为什么存在：`lib/desktop.js` 文件头那行「不检查」让 tsc 整份略过它，于是
 * 「找不到名称」这类错误在 `node --check`、全量用例、依赖图三道门里都看不见 ——
 * 真机上它变成 ReferenceError，直接把宿主进程停掉。第二趟检查（去掉声明再跑一遍
 * tsc）就是为这个盲区存在的；这里锁两件事：它真的能抓到一个未定义名，
 * 以及它确实接在门禁脚本的主流程上（而不是写了个没人调的函数）。
 */
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { SIGNAL_CODES, lintNoCheckSources, stripNoCheck } from "../scripts/check-lib-names.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

/** 与门禁脚本同一取法：走 typescript 包自己的 bin，不用 npx。 */
function locateTsc() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("typescript/package.json", { paths: [ROOT] });
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.tsc;
  return path.resolve(path.dirname(pkgPath), rel);
}

test("stripNoCheck 只删那一行声明，其余逐字不动", () => {
  const source = [
    "// lib/x.js — 一句话。",
    "// @ts-nocheck — 本文件不在类型检查范围内。",
    "export const a = 1;",
  ].join("\n");
  assert.equal(
    stripNoCheck(source),
    ["// lib/x.js — 一句话。", "export const a = 1;"].join("\n"),
  );
});

test("第二趟真的抓到未定义符号：干净文件零命中，坏文件点名 TS2304/TS2552", () => {
  const tsc = { bin: locateTsc() };
  const clean = {
    name: "clean.js",
    text: "// @ts-nocheck\nexport function ok(value) { return value + 1; }\n",
  };
  const broken = {
    name: "broken.js",
    text: "// @ts-nocheck\nexport function bad() { return notDefinedAnywhere; }\n",
  };
  const result = lintNoCheckSources([clean, broken], tsc);
  assert.equal(result.files, 2);
  assert.deepEqual(
    result.signal.map((d) => path.basename(d.file)),
    ["broken.js"],
    `只有坏文件该命中，实际：${result.signal.map((d) => d.raw).join(" | ")}`,
  );
  assert.ok(SIGNAL_CODES.includes(result.signal[0].code), `命中码 ${result.signal[0].code} 不在信号集合里`);
  assert.match(result.signal[0].message, /notDefinedAnywhere/);
});

test("门禁脚本的主流程里接了第二趟，且扫的是仓库里那批 @ts-nocheck 文件", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts", "check-lib-names.mjs"), "utf8");
  assert.ok(source.includes("lintNoCheckSources(sources, tsc)"), "第二趟没有接进 main：函数写了但没人调");
  assert.ok(source.includes("listNoCheckFiles()"), "第二趟没有从仓库里取 @ts-nocheck 清单");
  // 真文件至少有一个：一个都没有时，第二趟等于关掉了，红绿灯都不再代表任何事。
  const run = spawnSync(process.execPath, ["scripts/check-lib-names.mjs"], { cwd: ROOT, encoding: "utf8" });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.equal(run.status, 0, `门禁本身应通过：\n${out}`);
  assert.match(out, /第二趟：\d+ 个 @ts-nocheck 文件/);
  const files = Number((out.match(/第二趟：(\d+) 个/) ?? [])[1] ?? 0);
  assert.ok(files >= 1, `第二趟扫到 ${files} 个文件，盲区没被覆盖`);
});
