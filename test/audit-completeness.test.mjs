/**
 * audit 装机完备性探针的判据测试：夹具过、六种篡改各自被拦。
 *
 * 为什么判据要住在测试里：探针脚本（scripts/check-audit-completeness.mjs）的战场
 * 在远程验证机——部署、apply、取回 JSONL 都是半自动。判据本身必须在 CI 里可重复，
 * 否则「探针存在」只是文档声明。这里用脱敏夹具驱动同一个脚本：绿灯证明判据不误报，
 * 六个篡改用例证明判据有牙（少落一行、completeness 记假、缺层结论、exempt 不列示、
 * exempt 补丁落事件、v2 字段缺失，各拦各的）。
 *
 * 夹具（test/fixtures/audit-f6*.json）形状复刻 WP3 真机验证轮的最小完备子集：4 条
 * 文件事件 + 3 条层结论，路径脱敏为占位符，audit.rows=4 与文件事件数对齐。
 * 夹具与补丁表有一处硬耦合：code 层 detail.exempt=[21] 必须等于表里 auditExempt 的
 * 现行集合（PATCH-9，当前仅 id 21）。表侧改标记时本测试会红，逼着同步改夹具——
 * 这是有意的，豁免变更必须留一次显式动作。
 */
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "check-audit-completeness.mjs");
const FIXTURE_JSONL = join(ROOT, "test", "fixtures", "audit-f6.jsonl");
const FIXTURE_RESPONSE = join(ROOT, "test", "fixtures", "audit-f6-response.json");

/** 跑一次探针，返回退出码与输出（不抛——退出码就是要断言的判据）。 */
function runProbe(jsonl, response, rows) {
  const argv = ["--jsonl", jsonl];
  if (response) argv.push("--response", response);
  if (rows !== undefined) argv.push("--rows", String(rows));
  return runRaw(argv);
}

/** 直接跑给定的 argv（无参模式与 --fixtures 需要绕开 runProbe 的固定形状）。 */
function runRaw(argv) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...argv], { cwd: ROOT, encoding: "utf8" });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout || ""}${error.stderr || ""}` };
  }
}

/** 在临时目录里放一份篡改过的 JSONL（必要时连响应体一起改），跑探针。 */
function withTampered(mutate, mutateResponse) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-purge-audit-f6-"));
  try {
    const events = readFileSync(FIXTURE_JSONL, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    const tampered = mutate(events);
    const jsonl = join(dir, "tampered.jsonl");
    writeFileSync(jsonl, tampered.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    let response = FIXTURE_RESPONSE;
    if (mutateResponse) {
      const body = JSON.parse(readFileSync(FIXTURE_RESPONSE, "utf8"));
      mutateResponse(body);
      response = join(dir, "response.json");
      writeFileSync(response, JSON.stringify(body, null, 2), "utf8");
    }
    return runProbe(jsonl, response);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("audit 完备性：脱敏夹具全绿（判据不误报）", () => {
  const { code, out } = runProbe(FIXTURE_JSONL, FIXTURE_RESPONSE);
  assert.equal(code, 0, out);
  assert.match(out, /SMOKE OK/);
});

test("audit 完备性：--rows 模式（无响应体）同样可跑", () => {
  const { code, out } = runProbe(FIXTURE_JSONL, null, 4);
  assert.equal(code, 0, out);
  assert.match(out, /SMOKE OK/);
});

/**
 * 无参模式：探针进了验证链之后，无人值守环境里跑的就是这一条。
 * 判据分两层 —— 退出码要 0，且输出必须与显式给夹具路径时**逐字节相同**：
 * 后者才是「默认值只是把路径填好，判据体没动」的证明。只断言 exit 0 的话，
 * 无参模式里塞一套更松的断言同样能过。
 */
test("audit 完备性：无参模式跑仓库夹具，exit 0", () => {
  const { code, out } = runRaw([]);
  assert.equal(code, 0, out);
  assert.match(out, /SMOKE OK/);
});

test("audit 完备性：无参模式的输出与显式给夹具路径逐字节相同", () => {
  const implicit = runRaw([]);
  const explicit = runProbe(FIXTURE_JSONL, FIXTURE_RESPONSE);
  assert.equal(implicit.code, explicit.code);
  assert.equal(implicit.out, explicit.out, "无参模式与显式模式跑出了不同的结论 —— 默认值不只是填路径");
});

test("audit 完备性：--fixtures 可换一套夹具，夹具路径不是写死的唯一路径", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-purge-audit-altfix-"));
  try {
    for (const name of ["audit-f6.jsonl", "audit-f6-response.json"]) {
      writeFileSync(join(dir, name), readFileSync(join(ROOT, "test", "fixtures", name)), "utf8");
    }
    const { code, out } = runRaw(["--fixtures", dir]);
    assert.equal(code, 0, out);
    assert.match(out, /SMOKE OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit 完备性：--fixtures 指向坏证据时真的会红（默认值没有被硬编码兜住）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-purge-audit-altbad-"));
  try {
    const events = readFileSync(FIXTURE_JSONL, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    events.splice(2, 1);
    writeFileSync(join(dir, "audit-f6.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    writeFileSync(join(dir, "audit-f6-response.json"), readFileSync(FIXTURE_RESPONSE, "utf8"), "utf8");
    const { code, out } = runRaw(["--fixtures", dir]);
    assert.equal(code, 1, out);
    assert.match(out, /文件事件数 == audit\.rows/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit 完备性：过滤 apply 的分母是 selected（合法过滤不红，selected 里缺条点名）", () => {
  // 写侧把这一轮 report 的补丁号记在 detail.table.selected；探针不能拿补丁表全量当分母。
  const dir = mkdtempSync(join(tmpdir(), "dsh-purge-audit-selected-"));
  try {
    const source = join(ROOT, "test", "fixtures", "log-criteria", "closed-v3.jsonl");
    const response = join(ROOT, "test", "fixtures", "log-criteria", "closed-v3-response.json");
    const rows = readFileSync(source, "utf8").split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    const table = rows.map((row) => row.detail && row.detail.table).find(Boolean);
    table.selected = [1, 46, 29];
    const filtered = join(dir, "filtered.jsonl");
    writeFileSync(filtered, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

    const good = runProbe(filtered, response);
    assert.equal(good.code, 0, good.out, "合法过滤轮被判红了");

    table.selected = [1, 46, 29, 3];
    writeFileSync(filtered, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    const bad = runProbe(filtered, response);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /缺 3/, "selected 里缺的补丁 3 必须被点名");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit 完备性：--help 说清无参会跑夹具，exit 0", () => {
  const { code, out } = runRaw(["--help"]);
  assert.equal(code, 0, out);
  assert.match(out, /无参/);
  assert.match(out, /audit-f6\.jsonl/);
});

test("audit 完备性：未知参数与坏 rows 是 exit 2，不是 exit 1（用法错误不算判据不过）", () => {
  assert.equal(runRaw(["--bogus", "x"]).code, 2);
  assert.equal(runRaw(["--jsonl", FIXTURE_JSONL, "--rows", "abc"]).code, 2);
});

test("audit 完备性：红灯——少落一条文件事件，行数对账不上", () => {
  const { code, out } = withTampered((events) => events.filter((_, i) => i !== 2));
  assert.equal(code, 1, out);
  assert.match(out, /文件事件数 == audit\.rows/);
});

test("audit 完备性：红灯——completeness 记假", () => {
  const { code, out } = withTampered((events) => {
    const c = events.find((e) => e.event === "code.apply-result");
    c.detail.completeness.files = false;
    return events;
  });
  assert.equal(code, 1, out);
  assert.match(out, /completeness 三项全真/);
});

test("audit 完备性：红灯——缺一层结论", () => {
  const { code, out } = withTampered((events) =>
    events.filter((e) => e.event !== "tool.apply-result"));
  assert.equal(code, 1, out);
  assert.match(out, /tool 层有且仅有一条 apply-result/);
});

test("audit 完备性：红灯——exempt 不按表列示", () => {
  const { code, out } = withTampered((events) => {
    const c = events.find((e) => e.event === "code.apply-result");
    c.detail.exempt = [];
    return events;
  });
  assert.equal(code, 1, out);
  assert.match(out, /detail\.exempt 与补丁表一致/);
});

test("audit 完备性：红灯——exempt 补丁落了文件事件", () => {
  // 响应体行数同步改成 5，隔离出「exempt 不落事件」这一条（不让行数对账抢先红）
  const { code, out } = withTampered(
    (events) => {
      const clone = JSON.parse(JSON.stringify(events[2]));
      clone.detail.patchId = 21;
      clone.evidence.file = "C:\\dsh-host\\resources\\app\\lib\\legacy.js";
      clone.seq = 7;
      clone.recordId = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
      return [...events, clone];
    },
    (body) => {
      body.audit.rows = 5;
      body.audit_events = 8;
    },
  );
  assert.equal(code, 1, out);
  assert.match(out, /exempt 补丁不落文件事件/);
});

test("audit 完备性：红灯——result 与计数折算对不上（这一档原先照绿）", () => {
  // 夹具原先三行 result 全写 `skip`，而计数分别是 1/0/1 与 1/0/0 —— 探针一条断言都没有，
  // 照旧 exit 0。一个照绿的门禁比没有门禁更糟：它让人不去看。
  const { code, out } = withTampered((events) => {
    const conclusion = events.find((e) => e.event === "code.apply-result");
    conclusion.result = "skip";
    return events;
  });
  assert.equal(code, 1, out);
  assert.match(out, /result 与计数折算一致（应为 ok）/);
});

test("audit 完备性：红灯——partial 的来路与 completeness 对不上", () => {
  const { code, out } = withTampered((events) => {
    const conclusion = events.find((e) => e.event === "prompt.apply-result");
    conclusion.detail.partialReason = "record";
    return events;
  });
  assert.equal(code, 1, out);
  assert.match(out, /partialReason 与来路一致（应为 layer）/);
});

test("audit 完备性：红灯——v2 三字段缺失", () => {
  const { code, out } = withTampered((events) => {
    delete events[1].recordId;
    return events;
  });
  assert.equal(code, 1, out);
  assert.match(out, /v2 三字段齐全/);
});
