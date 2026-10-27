/**
 * SPEC 求解器的行为回归（夹具目录，不依赖本机宿主，CI 上能跑）。
 *
 * 为什么补这条：调查发现 `lib/host/targets.js` 的 `mode` / 多 rel 语义
 * **一条测试都没有**，而它决定了「补丁到底往哪些文件写字节」。本轮差点按
 * 「把 `user-approval-invariant` 的 rel 补成 `types/`」这种直觉改掉它，实测
 * 那一行会让 strictFiles 补丁 9 在干净安装上从 applied 翻成
 * pattern_not_found。所以这里把三条语义钉住：
 *
 *   1. `mode: "first"` + 文件在        → 解析到入口 rel
 *   2. `mode: "first"` + 文件不在      → **整条 key 不出现**（落空的键不登记）
 *   3. `mode: "all"`  + 两个 rel 都在  → 两条都覆盖（不是只取第一条）
 *
 * 第 2 条同时是那个陷阱的守门人：一旦有人给某个落空 key 补 rel，
 * 它就会从「不出现」变成「出现」，而引它的补丁的 strict 语义随之改变。
 *
 * ⚠️ 所以「落空 key」是**刻意的安全态**，不是待清理的债。
 * `user-approval-invariant` 的 rel 指向历史布局（裸 `lib/invariant.js`；
 * `lib/core.js:1393` 的还原候选清单里躺着同一条路径），在当前宿主上恒落空。
 * 「删掉它 + 从补丁 5/9/12 的 file 数组摘掉」已评估并否决：判定层零差异，
 * 却要按 UPDATE-4 进位 minor → 触发全量重打。本文件第 2 条用例守的就是它。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { targetFiles } from "../lib/host/targets.js";

function fakeHost(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-target-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, dshHome: path.join(base, "home") };
}

function put(base, ...segments) {
  const fp = path.join(base, ...segments);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, "export default {};\n");
  return fp;
}

test("mode: first —— 入口 rel 在就解析到它", (t) => {
  const { base, dshHome } = fakeHost(t);
  const fp = put(base, "dsh-user-approval", "lib", "index.js");
  assert.equal(targetFiles(base, dshHome)["user-approval-code"], fp);
});

test("mode: first —— rel 落空时整条 key 不出现（不许登记空探测行）", (t) => {
  const { base, dshHome } = fakeHost(t);
  // 只放编译残留，不放 lib/invariant.js
  put(base, "dsh-user-approval", "lib", "types", "invariant.js");
  put(base, "dsh-user-approval", "lib", "index.js");
  const files = targetFiles(base, dshHome);
  assert.equal("user-approval-invariant" in files, false, "落空的键必须整条删掉，下游按缺键处理");
  assert.ok("user-approval-code" in files, "同一包里能落地的键不受影响");
});

test("mode: all —— 两个 rel 都覆盖，不是只取第一条", (t) => {
  const { base, dshHome } = fakeHost(t);
  const entry = put(base, "dsh-sandbox", "lib", "index.js");
  const leftover = put(base, "dsh-sandbox", "lib", "types", "escalation.js");
  const got = targetFiles(base, dshHome)["escalation"];
  assert.ok(Array.isArray(got), "mode: all 必须给出数组");
  assert.deepEqual([...got].sort(), [entry, leftover].sort());
});

test("mode: all —— 只剩一条时给单元素数组，不补空位", (t) => {
  const { base, dshHome } = fakeHost(t);
  const entry = put(base, "dsh-sandbox", "lib", "index.js");
  assert.deepEqual(targetFiles(base, dshHome)["escalation"], [entry]);
});
