/**
 * test/terms-scope.test.mjs — 术语门禁的扫描范围有判据：`.scratch` 的豁免必须证明是真的。
 *
 * 为什么单独立一份：`scripts/check-terms.mjs` 把草稿区 `.scratch` 从扫描里跳过，理由是
 * 那里整份拷上游文档当审计对象、不按本仓库的措辞规范走。可「跳过」这件事本身没有症状 ——
 * 门禁照绿，谁也不知道它是真的跳过了，还是那段代码已经不生效了。这里用同一份扫描实现
 * 分别带 / 不带 `.scratch` 跑同一棵树：
 *
 *   · 带上跳过时，草稿区里的禁用词不报（这正是本仓库要的）；
 *   · 去掉跳过时，同一份文件必须被报出来（证明跳过就是那个开关，不是碰巧没扫到）。
 *
 * 任何一边缺了，这条豁免就只是纸面承诺 —— 而纸面承诺会在有人把上游文档拷进草稿区的那天
 * 变成一条查不清来历的红。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanTree, TERMS } from "../scripts/check-terms.mjs";
import { SKIP_DIRS } from "../scripts/lib-skip-dirs.mjs";

/** 守卫的禁用词：夹具里写它，门禁扫描才有对象。 */
const FORBIDDEN = TERMS[0];

/** 一棵小树：草稿区里一份带禁用词的拷贝 + 仓库内一份干净文件。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-terms-"));
  fs.mkdirSync(path.join(root, ".scratch", "zhll"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".scratch", "zhll", "upstream-copy.md"),
    `上游文档的旧措辞：这里的${FORBIDDEN}指的是宿主概念。\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(root, "docs", "ok.md"), "本仓库自己的文档，措辞按术语账本。\n", "utf8");
  return root;
}

test("`.scratch` 在跳过清单里：草稿区的禁用词不报，仓库内的照报", () => {
  const root = fixture();
  try {
    assert.ok(SKIP_DIRS.has(".scratch"), "跳过清单里没有 .scratch —— 草稿区的上游拷贝会把门禁永久判红");

    const skipped = scanTree({ root });
    assert.deepEqual(skipped.hits, [], `草稿区本该被跳过，却报了：${JSON.stringify(skipped.hits)}`);

    // 同一份文件放在仓库范围内时必须命中：否则「零命中」可能只是扫描根本没扫到东西。
    fs.writeFileSync(path.join(root, "docs", "bad.md"), `本仓库文档写了${FORBIDDEN}。\n`, "utf8");
    const inside = scanTree({ root });
    assert.equal(inside.hits.length, 1, `仓库内的禁用词应命中 1 处，实得：${JSON.stringify(inside.hits)}`);
    assert.ok(inside.hits[0].startsWith("docs/bad.md:"), `命中位置不对：${inside.hits[0]}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("红灯：把 `.scratch` 从跳过清单里去掉，同一棵树必须变红", () => {
  const root = fixture();
  try {
    const withoutScratch = new Set([...SKIP_DIRS].filter((name) => name !== ".scratch"));
    const red = scanTree({ root, skipDirs: withoutScratch });
    assert.equal(red.hits.length, 1, `去掉跳过之后草稿区应被扫到，实得：${JSON.stringify(red.hits)}`);
    assert.ok(
      red.hits[0].startsWith(".scratch/zhll/upstream-copy.md:"),
      `红灯位置不对，看上去跳过清单根本不是那个开关：${red.hits[0]}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
