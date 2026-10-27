/**
 * test/audit-handout.test.mjs — 现场必须自带说明书：读法投递 + 失败卡落盘 + 滞后可见。
 *
 * 为什么单独立一份：读法原先只在仓库里，真机的审计目录下没有它 —— 真正的现场只有
 * 日志，没有说明书，做出来的东西用户拿不到。失败卡同理：十二张卡在内存里按现场挑，
 * 不落盘、事后回看不了。这三条都要能被一条命令复核，所以各造一次。
 *
 * 全部夹具在系统临时目录里现造，跑完即删。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  fileDigest,
  readEvents,
  recordApplyRun,
  resolveAuditDir,
  runAuditQuery,
} from "../lib/audit/index.js";
import { deliverReadme } from "../lib/audit/handout.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOC = path.join(ROOT, "docs", "readme-for-ai.md");

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 三层齐全、摘要齐全的一轮：用一个 shared 文件承载三个补丁的 marker。 */
function fixture(host, { status = "applied" } = {}) {
  const files = {};
  for (const key of ["ka", "kb", "kc"]) {
    const file = path.join(host, `${key}.js`);
    fs.writeFileSync(file, "MK\n");
    files[key] = file;
  }
  const patches = [
    { id: 1, name: "PROMPT_ONE", layer: "提示词", marker: "MK", file: "ka" },
    { id: 2, name: "CODE_ONE", layer: "代码", marker: "MK", file: "kb" },
    { id: 3, name: "TOOL_ONE", layer: "工具", marker: "MK", file: "kc" },
  ];
  return {
    patches,
    targets: files,
    before: Object.fromEntries(Object.values(files).map((file) => [file, fileDigest(file)])),
    report: patches.map((patch) => ({ patch_id: patch.id, status })),
  };
}

test("读法投递：apply 之后现场有一份 README-for-ai.md，内容与仓库那份逐字节相同", () => {
  const home = makeTemp("dsh-purge-handout-home-");
  const host = makeTemp("dsh-purge-handout-host-");
  try {
    const f = fixture(host);
    recordApplyRun({ dshHome: home, ...f, runId: "apply-20260110T000000Z-0001", entry: "http" });
    const target = path.join(resolveAuditDir(home), "README-for-ai.md");
    assert.equal(fs.existsSync(target), true, "审计目录下没有读法：现场只有日志，没有说明书");
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(DOC), "投递的必须是同一份内容，不许另写摘要");

    // 第二次 apply 不重写同一份内容：否则 mtime 一直是新的，看着像「读法刚变过」。
    const second = deliverReadme(resolveAuditDir(home));
    assert.equal(second.status, "kept", `第二次投递应当是 kept，实测 ${second.status}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("读法投递失败有痕迹：目标是文件而不是目录时返回 failed 并带原因", () => {
  const home = makeTemp("dsh-purge-handout-home-");
  try {
    // 让「审计目录」这个路径本身是一个文件：mkdir 必然失败。
    const blocker = path.join(home, "blocked");
    fs.writeFileSync(blocker, "x");
    const result = deliverReadme(blocker);
    assert.equal(result.status, "failed");
    assert.ok(String(result.error).length > 0, "失败必须带原因，否则读的人只能猜");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("失败卡落盘：有问题的一轮在落账时就写下 cards/<ts>-<runId>.md", () => {
  const home = makeTemp("dsh-purge-handout-home-");
  const host = makeTemp("dsh-purge-handout-host-");
  try {
    // 硬 miss：on-miss 缺省是 fail，所以这一层会被判 fail，正是要出卡的那一档。
    const f = fixture(host, { status: "pattern_not_found" });
    const runId = "apply-20260110T000000Z-0002";
    recordApplyRun({ dshHome: home, ...f, runId, entry: "cli" });
    const cardsDir = path.join(resolveAuditDir(home), "cards");
    assert.equal(fs.existsSync(cardsDir), true, "有问题的这一轮没有留下卡片目录");
    const names = fs.readdirSync(cardsDir);
    assert.equal(names.length, 1, `应当正好一张卡，实测 ${names.join(", ")}`);
    assert.ok(names[0].endsWith(`-${runId}.md`), `文件名必须带 runId：${names[0]}`);
    const body = fs.readFileSync(path.join(cardsDir, names[0]), "utf8");
    for (const field of [`run: ${runId}`, "entry: cli", "layers:", "unresolved:", "card:"]) {
      assert.ok(body.includes(field), `卡片缺固定行「${field}」：\n${body}`);
    }
    assert.ok(body.includes("下一步："), "卡片必须给出下一步，否则读者还是要回源码里找");
    // 卡片是数据不是自动修复：它只给命令与判定。
    assert.ok(!/@type|import |export /.test(body), "卡片里不该出现代码");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("干净的一轮不写卡：没有症候就不该在 cards/ 里堆噪声", () => {
  const home = makeTemp("dsh-purge-handout-home-");
  const host = makeTemp("dsh-purge-handout-host-");
  try {
    const f = fixture(host);
    recordApplyRun({ dshHome: home, ...f, runId: "apply-20260110T000000Z-0003", entry: "tool" });
    const cardsDir = path.join(resolveAuditDir(home), "cards");
    assert.equal(fs.existsSync(cardsDir), false, "干净的一轮不该写卡");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("lagMs 不再只是写着：audit tail 的输出里给出「这一批最多滞后多少」", () => {
  const home = makeTemp("dsh-purge-handout-home-");
  const host = makeTemp("dsh-purge-handout-host-");
  try {
    const f = fixture(host);
    recordApplyRun({ dshHome: home, ...f, runId: "apply-20260110T000000Z-0004", entry: "http" });
    assert.ok(readEvents(home).length > 0, "这一条的前提是先有审计行");

    const out = [];
    const code = runAuditQuery(["tail", "--n", "5"], {
      out: (line) => out.push(line),
      err: (line) => out.push(line),
    }, { dshHome: home });
    assert.equal(code, 0, out.join("\n"));
    const line = out.find((text) => text.startsWith("lagMs: "));
    assert.ok(line, `tail 输出里没有 lagMs：\n${out.join("\n")}`);
    assert.match(line, /这一批最多滞后 \d+ ms/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});
