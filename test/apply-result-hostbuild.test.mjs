/**
 * apply-result 的 detail 必须带宿主 build：主次版本相同、build 不同的两份宿主，
 * 只看 hostVersion 分不开 —— 字段缺了，「这条补丁是为哪个 build 写的」就永远答不出来。
 *
 * 这里不调用库里的解析函数，而是自己把同一份 package.json 读一遍：断言的是
 * 「写进日志的值与独立读到的值逐字相同」。两边共用同一个实现时，这条断言只能证明代码自洽，
 * 证明不了它读对了对象，所以独立读这一步不能省。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readEvents } from "../lib/audit/store.js";
import { fileDigest, recordApply } from "../lib/audit/report.js";
import { makeEvent } from "../lib/audit/events.js";

const COMMIT = "332895e0f7c9d4dbfb29729f5eb367fa263ff986";
const MARKER = "HOST_BUILD_MARKER";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-hostbuild-"));
}

/**
 * 造一棵最小宿主树：`resources/app/package.json` 是 build 的来源，
 * 落点文件放在 `app/dsh/node_modules/.../lib/` 下 —— 真实宿主的最深层形态，
 * 上溯要跨过 dsh 运行时与包自己的 package.json 才轮到它。
 */
function makeHost(root, pkg = {}) {
  const appDir = path.join(root, "resources", "app");
  const pkgDir = path.join(appDir, "dsh", "node_modules", "@deepseek-ai", "dsh-agent-instructions");
  const targetFile = path.join(pkgDir, "lib", "registry.js");
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, `${MARKER}\n`, "utf8");
  // 包自己的 package.json 没有 dshBuildCommit：上溯必须略过它，落到 app 那一层。
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-agent-instructions", version: "0.2.1-rc.2" }),
    "utf8",
  );
  const pkgPath = path.join(appDir, "package.json");
  fs.writeFileSync(
    pkgPath,
    JSON.stringify({
      name: "@deepseek-ai/dsh-desktop",
      version: "0.2.1-rc.2",
      dshBuildCommit: COMMIT,
      dshBuildDirty: false,
      ...pkg,
    }, null, 2),
    "utf8",
  );
  return { appDir, targetFile, pkgPath };
}

function conclusions(home) {
  return readEvents(home).filter((event) => event.event.endsWith(".apply-result"));
}

test("apply-result 的 detail.hostBuild 与独立读到的宿主 build 逐字相同", () => {
  const root = makeRoot();
  try {
    const { targetFile, pkgPath } = makeHost(root);
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const rows = [
      { id: 1, name: "PROMPT_ONE", layer: "prompt", status: "applied", files: [targetFile], marker: MARKER },
      { id: 2, name: "CODE_ONE", layer: "code", status: "applied", files: [targetFile], marker: MARKER },
      { id: 3, name: "TOOL_ONE", layer: "tool", status: "applied", files: [targetFile], marker: MARKER },
    ];
    recordApply({
      dshHome: home,
      rows,
      before: { [targetFile]: fileDigest(targetFile) },
    });

    // 独立读数：不经过 lib 的任何解析函数，直接按字段名取同一个 build 标识。
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const expected = pkg.dshBuildDirty === true
      ? `${pkg.dshBuildCommit}+dirty`
      : pkg.dshBuildCommit;

    const layers = conclusions(home);
    assert.equal(layers.length, 3, "三层各一条结论");
    for (const conclusion of layers) {
      assert.equal(conclusion.detail.hostBuild, expected, "宿主 build 必须与宿主 package.json 逐字相同");
      assert.ok(
        String(conclusion.detail.hostBuildSource).includes(pkgPath),
        "来源说明要指到真读到的那份 package.json，而不是一句「已解析」",
      );
      // 新键不进 completeness 的三布尔：多一个键，读侧按三项布尔复算的口径就断了。
      assert.deepEqual(
        Object.keys(conclusion.detail.completeness).sort(),
        ["files", "layers", "patches"],
        "completeness 仍然只有三项布尔",
      );
      // 判定不许被新字段带动：三条补丁全 applied，层结论只能是 ok。
      assert.equal(conclusion.result, "ok", "新字段不参与 result 折算");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("宿主 build 读不到时留空串，来源说明写清读过哪条路径、为什么不成立", () => {
  const root = makeRoot();
  try {
    // 没有 resources/app/package.json，只有包自己的那份 —— 它没有 dshBuildCommit。
    const { targetFile } = makeHost(root);
    fs.rmSync(path.join(root, "resources", "app", "package.json"));
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    recordApply({
      dshHome: home,
      rows: [{ id: 1, name: "CODE_ONE", layer: "code", status: "applied", files: [targetFile], marker: MARKER }],
      before: { [targetFile]: fileDigest(targetFile) },
    });

    const [conclusion] = conclusions(home);
    assert.equal(conclusion.detail.hostBuild, "", "读不到宿主时必须留空串，不许编一个值出来");
    const source = String(conclusion.detail.hostBuildSource);
    assert.ok(source.length > 0, "空串必须配一句来源说明");
    assert.match(source, /dshBuildCommit/, "要说清找的是哪个字段");
    assert.ok(
      source.includes(path.join(root, "resources", "app", "dsh", "node_modules", "@deepseek-ai", "dsh-agent-instructions", "package.json")),
      "要说清读过哪条路径、为什么那条不成立",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dshBuildDirty 为真时标识带 +dirty：同一个 commit 的脏构建不是那一版字节", () => {
  const root = makeRoot();
  try {
    const { targetFile, pkgPath } = makeHost(root, { dshBuildDirty: true });
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    recordApply({
      dshHome: home,
      rows: [{ id: 1, name: "CODE_ONE", layer: "code", status: "applied", files: [targetFile], marker: MARKER }],
      before: { [targetFile]: fileDigest(targetFile) },
    });

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const [conclusion] = conclusions(home);
    assert.equal(conclusion.detail.hostBuild, `${pkg.dshBuildCommit}+dirty`);
    assert.match(String(conclusion.detail.hostBuildSource), /dshBuildDirty/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("落点在 app.asar.unpacked 下时，仍按旁边的 resources/app/package.json 记 build", () => {
  const root = makeRoot();
  try {
    // 密封宿主的典型形态：补丁落进解包目录，而宿主壳的 package.json 留在 resources/app。
    const appDir = path.join(root, "resources", "app");
    fs.mkdirSync(appDir, { recursive: true });
    const pkgPath = path.join(appDir, "package.json");
    fs.writeFileSync(pkgPath, JSON.stringify({ name: "@deepseek-ai/dsh-desktop", dshBuildCommit: COMMIT }), "utf8");
    const targetFile = path.join(
      root, "resources", "app.asar.unpacked", "node_modules", "@deepseek-ai", "dsh-agent-instructions", "lib", "registry.js",
    );
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, `${MARKER}\n`, "utf8");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    recordApply({
      dshHome: home,
      rows: [{ id: 1, name: "CODE_ONE", layer: "code", status: "applied", files: [targetFile], marker: MARKER }],
      before: { [targetFile]: fileDigest(targetFile) },
    });

    const [conclusion] = conclusions(home);
    assert.equal(conclusion.detail.hostBuild, COMMIT);
    assert.ok(String(conclusion.detail.hostBuildSource).includes(pkgPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("写侧：detail.hostBuild 不带来源说明就不许落盘", () => {
  const base = {
    event: "code.apply-result",
    result: "ok",
    layer: "code",
    evidence: { refSeq: 0 },
  };
  assert.throws(
    () => makeEvent({ ...base, detail: { hostBuild: "" } }),
    /hostBuildSource/,
    "只留空串必须被拦下",
  );
  assert.throws(
    () => makeEvent({ ...base, detail: { hostBuild: "", hostBuildSource: "" } }),
    /hostBuildSource/,
    "来源说明不许是空串",
  );
  assert.doesNotThrow(() => makeEvent({
    ...base,
    detail: { hostBuild: "", hostBuildSource: "没找到带 dshBuildCommit 的宿主 package.json" },
  }));
});
