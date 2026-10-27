/**
 * test/gate-skip-dirs.test.mjs — 扫树类门禁的跳过清单只有一份，且草稿区 `.scratch` 在内。
 *
 * 为什么单独立一份：跳过清单原先由每个门禁各写一份，于是「草稿区算不算仓库」这件事要在
 * 四处分别回答。上一轮 `.scratch` 里的打包产物把 `check-layout` 判红，正是漏了其中一处 ——
 * 那类红与改动无关，却会把 `npm run verify` 拦住。
 *
 * 判据三条：
 *   1. 共享清单里有 `.scratch`（以及工具自管状态与依赖树），且判定函数认它；
 *   2. 四个扫树门禁都从 `scripts/lib-skip-dirs.mjs` 取口径，源码里不许再有第二份 `SKIP_DIRS`；
 *   3. 覆盖口径仍然可用：把 `.scratch` 从清单里拿掉，判定函数就必须放行（证明跳过是那个开关）。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKIP_DIRS, SKIP_PREFIX, shouldSkipDir } from "../scripts/lib-skip-dirs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATES = ["check-layout.mjs", "check-terms.mjs", "check-comments.mjs", "check-file-roles.mjs"];
const SHARED = "lib-skip-dirs.mjs";

test("共享清单：`.scratch` 与工具自管目录都在，判定函数认它", () => {
  for (const name of [".scratch", "node_modules", ".git", ".codegraph", ".ua"]) {
    assert.equal(SKIP_DIRS.has(name), true, `跳过清单里没有 ${name}`);
    assert.equal(shouldSkipDir(name), true, `shouldSkipDir 不认 ${name}`);
  }
  for (const prefix of SKIP_PREFIX) {
    assert.equal(shouldSkipDir(`${prefix}draft`), true, `前缀 ${prefix} 没被跳过`);
  }
  for (const name of ["lib", "scripts", "docs"]) {
    assert.equal(shouldSkipDir(name), false, `仓库目录 ${name} 被误跳过了`);
  }
});

test("四个门禁都从共享清单取口径：源码里不许有第二份 SKIP_DIRS", () => {
  const offenders = [];
  for (const gate of GATES) {
    const source = readFileSync(join(ROOT, "scripts", gate), "utf8");
    if (!source.includes(SHARED)) offenders.push(`${gate}：没有 import ${SHARED}`);
    if (/const\s+SKIP_DIRS\s*=\s*new Set/.test(source)) offenders.push(`${gate}：还留着一份局部 SKIP_DIRS`);
    if (/const\s+SKIP_PREFIX\s*=\s*\[/.test(source)) offenders.push(`${gate}：还留着一份局部 SKIP_PREFIX`);
  }
  assert.deepEqual(offenders, [], `这些门禁没有跟上共享清单：\n  ${offenders.join("\n  ")}`);
});

test("红灯：把 `.scratch` 从口径里拿掉，判定函数必须放行", () => {
  assert.equal(shouldSkipDir(".scratch"), true, "先确认默认口径跳过它");
  const withoutScratch = new Set([...SKIP_DIRS].filter((name) => name !== ".scratch"));
  assert.equal(
    shouldSkipDir(".scratch", { skipDirs: withoutScratch }),
    false,
    "覆盖口径不生效 —— 那「跳过」就是写死的，而不是这份清单在起作用",
  );
});
