/**
 * test/patch-idempotency.test.mjs — `skipIfMarked` 只当幂等护栏，连打两次不许再动文件。
 *
 * 为什么单独立一份：`skipIfMarked` 原先同时承担两件事 —— 「报告已生效」与「阻止重复插入」。
 * 前者要的是内容真相（见本批另一条判据），后者要的是护栏。护栏自己也得有判据：
 * 一条护栏如果在第二遍就失效，重复 apply 会把宿主文件越叠越长，而状态面板照样是绿的。
 *
 * 判据：对每条声明了 `skipIfMarked` 的补丁，把它自己的 pattern 原文喂进去连打两次，
 * 第二次 `changed=false`，且写盘后的文件 sha256 与第一次逐字节相同。
 *
 * 覆盖数是硬断言：31 条。这个数变了说明补丁表动了类型登记，要连这条判据一起复核。
 */
import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_PATCHES, applyReplacementsToText } from "../lib/core.js";

const SKIP_MARKED = ALL_PATCHES.filter((patch) => patch.skipIfMarked === true);

/**
 * 该补丁第一个字面量 pattern；纯正则补丁无法反推原文，返回空串。
 * 纯正则两条（id 3 与 id 73）是已登记的判据缺口：它们没有可反推的原文，
 * 与 characterization 快照里的处理同一口径 —— 记「判不了」，不编一份假原文。
 */
function firstLiteralPattern(patch) {
  const reps = Array.isArray(patch.replacements)
    ? patch.replacements
    : (patch.patterns ?? []).map((pattern) => ({ pattern, replace: patch.replace }));
  for (const rep of reps) {
    if (typeof rep.pattern === "string" && rep.pattern.length > 0) return rep.pattern;
  }
  return "";
}

/**
 * 与引擎的 saveText 同义：字节相同就不写。
 * 这里自己实现一份是为了让判据落在「文件到底动没动」上，而不是落在函数返回值上。
 */
function writeIfChanged(fp, text) {
  const next = Buffer.from(text, "utf8");
  try {
    if (readFileSync(fp).equals(next)) return false;
  } catch {
    /* 文件还不存在：照常写 */
  }
  writeFileSync(fp, next);
  return true;
}

const sha256OfFile = (fp) => createHash("sha256").update(readFileSync(fp)).digest("hex");

test("覆盖数：声明 skipIfMarked 的补丁恰好 31 条", () => {
  assert.equal(
    SKIP_MARKED.length,
    31,
    "补丁表的 skipIfMarked 集合变了；这是按替换粒度登记过的 31 条，变动要连判据一起复核",
  );
});

test("每条 skipIfMarked 补丁连打两次：第二次 changed=false 且文件 sha256 不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "wp2-idem-"));
  const failures = [];
  const noLiteral = [];
  for (const patch of SKIP_MARKED) {
    const original = firstLiteralPattern(patch);
    if (!original) {
      noLiteral.push(patch.id);
      continue;
    }
    const fp = join(dir, `patch-${patch.id}.txt`);
    const first = applyReplacementsToText(original, patch);
    if (first.changed !== true) {
      failures.push(`${patch.id}/${patch.name}：第一次没有改写，幂等判据失去对象`);
      continue;
    }
    writeIfChanged(fp, first.text);
    const shaAfterFirst = sha256OfFile(fp);

    const second = applyReplacementsToText(first.text, patch);
    if (second.changed !== false) {
      failures.push(`${patch.id}/${patch.name}：第二次仍在改写，重复 apply 会把文件越叠越长`);
      continue;
    }
    if (second.text !== first.text) {
      failures.push(`${patch.id}/${patch.name}：第二次返回的文本与第一次不同`);
      continue;
    }
    writeIfChanged(fp, second.text);
    const shaAfterSecond = sha256OfFile(fp);
    if (shaAfterSecond !== shaAfterFirst) {
      failures.push(`${patch.id}/${patch.name}：第二次写盘后文件字节变了`);
    }
  }
  assert.deepEqual(failures, [], `这些补丁的幂等护栏不成立：\n  ${failures.join("\n  ")}`);
  // 纯正则的两条按已登记缺口跳过，数量写死：多了说明有补丁被改成正则却没说一声。
  assert.deepEqual(noLiteral.sort((a, b) => a - b), [3, 73], "无字面量 pattern 的 skipIfMarked 集合变了");
});

test("幂等护栏的两半：marker 在且没活才短路；marker 在但还有活必须真干", () => {
  // 这条锁的是护栏的成立条件。它有两个分量，缺一个就出事：
  //   `marker 在 + 没活` → 短路（否则重复 apply 会把文件越叠越长）；
  //   `marker 在 + 还有活` → 不许短路（#73 的 marker 是 #70 写的，短路会让它的删除永远不执行）。
  // 旧实现只看前半个分量，于是「别人写的 marker」被当成「自己的活干完了」。
  const patch = SKIP_MARKED.find(
    (item) => Array.isArray(item.markers) && item.markers.length > 0 && firstLiteralPattern(item) !== "",
  );
  assert.ok(patch, "夹具需要一条带 markers 且带字面量 pattern 的 skipIfMarked 补丁");
  const original = firstLiteralPattern(patch);
  const applied = applyReplacementsToText(original, patch);
  assert.equal(applied.changed, true, "夹具的第一步必须真的改写，否则后面的判断没有对象");

  // 已应用态：marker 在、原文也不在 → 护栏短路，幂等成立。
  const lostNothing = applyReplacementsToText(applied.text, patch);
  assert.equal(lostNothing.changed, false, "marker 在且没活时护栏必须短路，否则重复 apply 会越叠越长");

  // 同一份已应用态里再塞一条残留原文：marker 在，但活真的还在 → 必须改，不许短路。
  const withResidual = `${applied.text}\n${original}\n`;
  const guarded = applyReplacementsToText(withResidual, patch);
  assert.equal(
    guarded.changed,
    true,
    "marker 在但还有活时必须真替换 —— 共享 marker 的补丁（#73）就是被这一条冻住的",
  );

  // 反方向：marker 不在时更不该短路。
  const stripped = patch.markers.reduce((text, marker) => text.split(marker).join(""), withResidual);
  const unguarded = applyReplacementsToText(stripped, patch);
  assert.equal(unguarded.changed, true, "marker 不在时护栏不该短路：那会把「还差这一步」冻住");
});
