/**
 * 安装指纹的判据锁。
 *
 * 背景：测试机上出现过「`pnpm` 不知道的手工覆盖」——`--unseal` 让 `dsh` CLI 失效后，
 * 只能用 Copy-Item 覆盖 `node_modules/dsh-purge` 里的文件。下次 install 会把它们静默盖回去，
 * 而现场没有任何记录。这个模块的职责就是让那种改动**有痕迹**。
 *
 * 三条断言对应三种失败：装了没记、记了被改、改了还报一致。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkInstallState, readInstallState, recordInstallState } from "../lib/install-state.js";

/** 造一棵最小的插件树：package.json + bin + lib（含一个不该被统计的 client-src）。 */
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-install-"));
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib", "client-src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dsh-purge", version: "1.2.2" }), "utf8");
  fs.writeFileSync(path.join(root, "bin", "dsh-purge.js"), "console.log(1);\n", "utf8");
  fs.writeFileSync(path.join(root, "lib", "core.js"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, "lib", "client-src", "shell.js"), "var x = 1;\n", "utf8");
  return root;
}

test("装完记一次指纹：再查时一致，且不把 client-src 算进去", () => {
  const root = makeTree();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-home-"));
  try {
    const written = recordInstallState(home, { root, version: "1.2.2", method: "pnpm" });
    assert.equal(written.ok, true, "记录写失败");
    assert.ok(written.files >= 3, `参与指纹的文件太少（${written.files}）`);

    const state = readInstallState(home);
    assert.equal(state.version, "1.2.2");
    assert.equal(state.method, "pnpm");
    assert.ok(!Object.keys(state.files).some((rel) => rel.includes("client-src")), "client-src 是被装配的片段，不该参与安装指纹");

    const check = checkInstallState(home, root);
    assert.equal(check.ok, true, `刚记完就判不一致：${JSON.stringify({ d: check.drifted, m: check.missing, a: check.added })}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("文件被手工改过 → drifted 点名，ok 为 false", () => {
  const root = makeTree();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-home-"));
  try {
    recordInstallState(home, { root, version: "1.2.2", method: "pnpm" });
    fs.writeFileSync(path.join(root, "lib", "core.js"), "export const a = 2; // 手工覆盖\n", "utf8");

    const check = checkInstallState(home, root);
    assert.equal(check.ok, false, "改过文件却仍报一致 —— 这条记录就失去意义了");
    assert.deepEqual(check.drifted, ["lib/core.js"]);
    assert.deepEqual(check.missing, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("没有记录时返回 ok=false（不能当「干净」）", () => {
  const root = makeTree();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-home-"));
  try {
    assert.equal(readInstallState(home), null);
    const check = checkInstallState(home, root);
    assert.equal(check.ok, false, "没有基线就报 clean，等于给一个假的安全感");
    assert.equal(check.state, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
