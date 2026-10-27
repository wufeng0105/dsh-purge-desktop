/**
 * test/open-kinds.test.mjs — 「打开目录」只认语义 kind（T40）。
 *
 * 知识库空态那个「打开知识库目录」按钮之前点不动：`/dsh-purge/open` 只认 logs / config。
 * 加一个 kind 看似无害，但它正是「外部输入决定去开哪条命令」的那道门，所以两头都要钉：
 *   一、`knowledge` 能开，路径由服务端算（`$DSH_HOME/redteam`）；
 *   二、未知 kind 一律拒（`dirFor` 给 null、`openPathFor` 回 400 形状、端点里的白名单仍是逐项列举）。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dirFor, openPathFor } from "../lib/open-path.js";

const ROOT = join(import.meta.dirname, "..");
const HOME = join("C:", "Users", "fixture", ".dsh");

function fakeSpawn(calls) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    return { on() {}, unref() {} };
  };
}

test("knowledge 能开，且路径由服务端算（$DSH_HOME/redteam）", () => {
  const calls = [];
  const result = openPathFor("knowledge", HOME, { spawnFn: fakeSpawn(calls), platform: "win32" });
  assert.equal(result.ok, true, `knowledge 打不开：${result.error || ""}`);
  assert.equal(result.path, join(HOME, "redteam"), "knowledge 指到了别的目录");
  assert.deepEqual(calls[0].args, [join(HOME, "redteam")], "命令行里出现的不是服务端算出来的路径");
});

test("既有 kind 行为不变：logs / config 仍按老路径开", () => {
  for (const [kind, expected] of [["logs", join(HOME, "dsh-purge", "audit")], ["config", HOME]]) {
    const calls = [];
    const result = openPathFor(kind, HOME, { spawnFn: fakeSpawn(calls), platform: "win32" });
    assert.equal(result.ok, true, `${kind} 打不开了（既有行为被破坏）`);
    assert.deepEqual(calls[0].args, [expected], `${kind} 的路径变了`);
  }
});

test("未知 kind 一律拒绝：dirFor 给 null、openPathFor 回 400 形状", () => {
  for (const kind of ["", "nope", "../..", "logs/../..", "knowledge/../../..", undefined]) {
    assert.equal(dirFor(kind, HOME), null, `dirFor 放行了非法 kind：${String(kind)}`);
    const result = openPathFor(kind, HOME, { spawnFn: fakeSpawn([]), platform: "win32" });
    assert.equal(result.ok, false, `openPathFor 放行了非法 kind：${String(kind)}`);
    assert.equal(result.status, 400, `非法 kind 没有标成 400：${String(kind)}`);
  }
});

test("端点白名单仍是逐项列举，且包含 knowledge", () => {
  const source = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  const at = source.indexOf('"/dsh-purge/open"');
  assert.ok(at > 0, "index.js 里找不到 /dsh-purge/open");
  const handler = source.slice(at, source.indexOf('"dsh-purge: open"', at));
  for (const kind of ["logs", "config", "knowledge"]) {
    assert.match(handler, new RegExp(`kind !== "${kind}"`), `端点白名单里缺 ${kind}`);
  }
  assert.ok(!/if\s*\(\s*!kind\s*\)/.test(handler), "端点改成「有 kind 就放行」：白名单失效");
});
