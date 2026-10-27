/**
 * UPDATE-4：版本戳对齐的判据（`stampMatches`）。
 *
 * ## 这条测试防的是什么
 *
 * `applied.json` 里的 `version` 是**上次应用补丁那一刻**的插件版本。
 * 老判据是严格相等 `stamp.version === pluginVersion()`，于是：
 *
 *   1.0.0 → 1.2.0 这种收口（号倒挂）会让 stamp 恒 false
 *     → 每次启动都全量 revert + reapply 所有补丁
 *     → 一次 patch 级修复变成「每开一次 dsh 就重打一遍」
 *
 * 收口到 1.2.0 之后还必须**能持续成立**：1.2.1、1.2.2 这种 patch 版本不该
 * 再触发重打，否则「放行 patch」就等于没放。
 *
 * ## 为什么只放主次版本（不放任意版本）
 *
 * minor 变动意味着可能动了补丁表 / 注入内容，那**应该**重打一次；
 * patch 变动只说明修了 bug，不该连带重打全部补丁。
 * `healEmptyAppliedStamp` 用的是同一判据 —— 两处曾各自严格相等，
 * 只改一处等于没改（另一个洞会补上同样的症状）。这条测试把两处一起锁。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stampMatches } from "../lib/stamp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** stamp 完整（带 sha），rev 与 stamp.sha 一致 —— 把变量收窄到「版本比较」这一轴。 */
function stamp(version, sha = "apply:1.2.0") {
  return { version, sha };
}

function aligned(stampVersion, pluginVersion, rev = "apply:1.2.0") {
  return stampMatches(stamp(stampVersion, rev), pluginVersion, rev);
}

test("UPDATE-4：主次版本相同即算对齐（patch 与 prerelease 不参与比较）", () => {
  assert.equal(aligned("1.2.0", "1.2.0"), true, "完全相同的版本必须算对齐");
  assert.equal(aligned("1.2.0", "1.2.7"), true, "patch 差异不该触发全量重打");
  assert.equal(aligned("1.2.3", "1.2.0"), true, "反向的 patch 差异同样算对齐");
  assert.equal(aligned("1.2.0-beta.1", "1.2.9"), true, "prerelease 不参与比较");
  assert.equal(aligned("v1.2.0", "1.2.5"), true, "前缀 v 不该影响判定");
});

test("UPDATE-4：主次版本不同即算未对齐（minor 变动应重打一次）", () => {
  assert.equal(aligned("1.0.0", "1.2.0"), false, "1.0.0 → 1.2.0 收口必须触发一次重打");
  assert.equal(aligned("1.2.0", "1.3.0"), false, "minor 变了可能动了补丁表，该重打");
  assert.equal(aligned("1.1.71", "1.2.0"), false, "跨 minor 一律判未对齐");
  assert.equal(aligned("2.0.0", "1.2.0"), false, "major 变了更要重打");
});

test("UPDATE-4：残缺 stamp 一律判未对齐（不能被当成已对齐）", () => {
  assert.equal(stampMatches(null, "1.2.0", ""), false, "没有 stamp 文件");
  assert.equal(stampMatches({ version: "", sha: "abc" }, "1.2.0", "abc"), false, "version 空串");
  assert.equal(stampMatches({ version: "1.2.0" }, "1.2.0", ""), false, "sha 缺失（#56）");
  assert.equal(stampMatches({ version: "1.2.0", sha: "" }, "1.2.0", ""), false, "sha 空串（#56）");
  assert.equal(stampMatches(stamp("1.2.0"), "", ""), false, "插件版本读不出来时不该算对齐");
});

test("UPDATE-4：sha 轴的行为未被版本判据改坏", () => {
  // 没有 installed-rev 时只认 version（手动应用场景）。
  assert.equal(stampMatches(stamp("1.2.0", "apply:1.2.0"), "1.2.0", ""), true);
  // 占位戳与 git rev 并存时只认 version，避免空转重启。
  assert.equal(stampMatches(stamp("1.2.0", "apply:1.2.0"), "1.2.0", "deadbeef"), true);
  // 两边都是 git rev 时必须一致。
  assert.equal(stampMatches(stamp("1.2.0", "deadbeef"), "1.2.0", "deadbeef"), true);
  assert.equal(stampMatches(stamp("1.2.0", "deadbeef"), "1.2.0", "cafebabe"), false);
});

test("UPDATE-4：healEmptyAppliedStamp 与 stampMatches 用同一判据（只改一处等于没改）", () => {
  // 这里做的是**源码级**断言，不是重构洁癖：两处曾经各自写 `stamp.version !== version`，
  // 版本号一动，两条路一起失效（一个走全量重打，一个走空 sha 自愈），症状相同。
  // 未来若有人把其中一处改回严格相等，这条会红。
  // 账本层已搬到 lib/stamp.js（`lib/reapply.js` 只转出 API），判据跟着它走。
  const src = readFileSync(join(ROOT, "lib", "stamp.js"), "utf8");
  // 只看**代码**，不看注释：注释里正当地引用着老判据 `stamp.version !== version`。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const strictComparisons = code.match(/stamp\.version\s*!==\s*version/g) || [];
  assert.deepEqual(
    strictComparisons,
    [],
    "stamp.js 里又出现了 `stamp.version !== version` 的严格比较 —— "
    + "版本号一动它恒 false，每次启动都会全量 revert+reapply",
  );
  const fn = /export function healEmptyAppliedStamp\(\)[\s\S]*?\n}/.exec(src);
  assert.ok(fn, "healEmptyAppliedStamp 找不到了（函数被改名/删了？）");
  assert.match(
    fn[0],
    /sameMajorMinor\(stamp\.version,\s*version\)/,
    "healEmptyAppliedStamp 没走 sameMajorMinor —— 它会与 stampMatches 判据漂移",
  );
});
