/**
 * test/api-parity.test.mjs — 同一个状态，两条只读端点必须给出同一个答案。
 *
 * ## 为什么需要这一条
 *
 * `/dsh-purge/status` 与 `/redteam/api` 各自给面板供数：前者是设置页，后者是演练台。
 * 两边都自洽，只是可能不是同一件事 —— 而「不是同一件事」没有症状，用户看到的是两个都像
 * 真的数。WP12 之前，`platformEnvAdaptStatus` 自己摊字段、`skillCatalog` 自己合并目录，
 * 三处各算一遍（`STATUS` 的 env 块、演练台的 env op、技能目录的两个读者）。
 *
 * 收编之后规矩是：**派生只有一次**（`lib/state/contract.js` 的块），两条端点只负责把块
 * 摊成自己的信封。所以这里的判据是两句话：
 *
 *   一、**同名字段取值一致**：同一份夹具喂给两边，块里每个字段逐个相等；
 *   二、**字段集受声明约束**：只读 op 的顶层键 ⊆ 契约声明（块字段 ∪ 该 op 的信封），
 *      多一个就红。这一条是 WP6 退回时立的规矩，也是本文件真正的回归点。
 *
 * 夹具全部是合成的（临时 DSH_HOME、示例网段、演示主机名），不碰真宿主与真实 `~/.dsh`。
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_PURGE_LOG = "0";

const contract = await import("../lib/state/contract.js");
const { envAdaptPayload, skillCatalogOfHome } = await import("../lib/redteam/ui.js");
const { envAdaptStatus } = await import("../lib/redteam/platform-config.js");
const { listSkillCatalog } = await import("../lib/skills.js");
const { RedteamStore, dispatch } = await import("../lib/redteam/store-core.js");

/** 读一份仓库内的源文件（接线是静态事实，用源码核）。 */
const read = (rel) => readFileSync(join(import.meta.dirname, "..", rel), "utf8");

/** 环境适配的一份夹具：九个字段都必须有值，否则「相等」可能只是两边都是缺省。 */
function envFixture() {
  return {
    ready: true,
    reason: "configured",
    message: "演示：工具路径已保存",
    kali: false,
    skipped: false,
    configured: true,
    found: 3,
    missing: 1,
    total: 4,
  };
}

/** 一份 `SKILL.md`：frontmatter 只写宿主认的两行。 */
const skillDoc = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`;

/**
 * 环境适配的一份**真实来源**：临时 `$DSH_HOME/redteam/config.json`。
 *
 * 为什么不再用「同一个对象喂两侧」：那证明的只是「两个渲染函数对同一输入一致」，
 * 不覆盖**接线** —— 生产里真正会出问题的是「一侧根本没有来源」（`envBlock(null)` 全缺省），
 * 而夹具照样绿。这里改成都从 `envAdaptStatus(真实 root)` 出一道现场，再分别过两个入口。
 */
async function withEnvSource(configJson, fn) {
  const home = mkdtempSync(join(tmpdir(), "dsh-purge-wp13-env-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const root = join(home, "redteam");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "config.json"), JSON.stringify(configJson), "utf8");
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("env：两个入口从同一个真实来源取值，接线在源码里可核", async () => {
  /* 一、接线：`/status` 必须**真的**把生产者交给契约，`/redteam/api` 必须调同一个生产者。
     这两条是静态的，但缺了它们，下一条的运行时相等就只是「两个函数对同一输入一致」。 */
  const indexSource = read("lib/index.js");
  assert.match(
    indexSource,
    /env:\s*envAdaptStatus\(/,
    "`/dsh-purge/status` 没把 envAdaptStatus 交给 statusBlocks —— 契约只能给 `envBlock(null)` 的全缺省值",
  );
  assert.ok(
    !/env:\s*null/.test(indexSource),
    "`/dsh-purge/status` 仍有一处把 env 传成 null：那等于「这条端点没有来源」",
  );
  const uiSource = read("lib/redteam/ui.js");
  assert.match(
    uiSource,
    /envAdaptPayload\(\s*envAdaptStatus\(/,
    "演练台的 env op 没有用同一个生产者：两条端点会各报各的现场",
  );

  /* 二、运行时：同一份真实来源（临时 DSH_HOME 里的 config.json）分别过两个入口。 */
  await withEnvSource({ envAdaptSkip: true }, async (root) => {
    const source = envAdaptStatus(root);
    const statusBlock = contract.statusBlocks({ env: source }).env;
    const opPayload = envAdaptPayload(source);
    const fields = Object.keys(contract.STATE_BLOCKS.env);
    for (const field of fields) {
      assert.deepEqual(
        opPayload[field],
        statusBlock[field],
        `env.${field} 两个入口不一致：演练台 ${JSON.stringify(opPayload[field])} / 状态 ${JSON.stringify(statusBlock[field])}`,
      );
    }
    assert.deepEqual(
      Object.keys(opPayload).sort(),
      ["ok", ...fields].sort(),
      "演练台的 env 回包多了块外的字段",
    );
    /* 来源必须真的起作用：换一份 config，`skipped` 跟着变 —— 否则上面的相等是空的。 */
    assert.equal(statusBlock.skipped, true, "夹具的 config 没被读到：这条判据的前提没成立");
  });

  await withEnvSource({}, async (root) => {
    const source = envAdaptStatus(root);
    assert.equal(
      contract.statusBlocks({ env: source }).env.skipped,
      false,
      "换成另一份 config 后取值没变：两侧的相等与来源无关，判据是空的",
    );
    assert.equal(envAdaptPayload(source).skipped, false, "演练台侧同样应跟着来源变");
  });
});

test("env：把一侧的来源换掉必须红（接线判据的灵敏度）", async () => {
  /* 这一条是上面那条的**对照**：来源不同，两侧就该不相等。它证明「相等」不是恒等式。 */
  await withEnvSource({ envAdaptSkip: true }, async (root) => {
    const a = envAdaptStatus(root);
    const b = { ...a, skipped: false };
    const left = contract.statusBlocks({ env: a }).env;
    const right = envAdaptPayload(b);
    assert.notDeepEqual(
      { skipped: right.skipped },
      { skipped: left.skipped },
      "换掉一侧的输入后仍相等：说明比较的两侧其实没有各自读来源",
    );
  });
});

test("skills：同一份 DSH_HOME，设置页与演练台的目录块逐字段相等", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-purge-wp12-parity-"));
  try {
    const officialDir = join(home, "skills");
    const redteamDir = join(home, "redteam", "skills");
    mkdirSync(officialDir, { recursive: true });
    mkdirSync(redteamDir, { recursive: true });
    writeFileSync(join(officialDir, "alpha.md"), skillDoc("alpha", "用户自己的 alpha"), "utf8");
    writeFileSync(join(officialDir, "dup.md"), skillDoc("dup", "用户改过的 dup"), "utf8");
    writeFileSync(join(redteamDir, "beta.md"), skillDoc("beta", "随包的 beta"), "utf8");
    writeFileSync(join(redteamDir, "dup.md"), skillDoc("dup", "随包模板的 dup"), "utf8");

    /* 状态侧：`/dsh-purge/status` 的 skills 块来自 `skillsStatus()`。 */
    const statusItems = (await listSkillCatalog(home)).items;
    const statusBlock = contract.skillsBlock({ dir: "$DSH_HOME/skills", items: statusItems });
    /* 演练台侧：`/redteam/api` 的 skillCatalog 一个个数来自同一个目录模块。 */
    const drillItems = skillCatalogOfHome(home).items;
    const drillBlock = contract.skillsBlock({ dir: "$DSH_HOME/skills", source: "plugin", items: drillItems });

    assert.deepEqual(
      drillBlock.total,
      statusBlock.total,
      `技能总数不一致：演练台 ${drillBlock.total} / 设置页 ${statusBlock.total}`,
    );
    assert.deepEqual(drillBlock.byLibrary, statusBlock.byLibrary, "按库计数不一致");
    assert.deepEqual(
      drillItems.map((item) => item.name).sort(),
      statusItems.map((item) => item.id).sort(),
      "两个端点列出的技能集合不一致",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("只读 op 的顶层键 ⊆ 契约声明：env 与 skills 两条都有判据", () => {
  const envPayload = envAdaptPayload(envFixture());
  assert.deepEqual(
    contract.redteamOpReport("platformEnvAdaptStatus", envPayload).undeclared,
    [],
    "env op 的回包里有未声明的字段",
  );

  /* 红线夹具：多一个字段必须被报出来 —— 否则「零差额」只是探测器坏了。 */
  assert.deepEqual(
    contract.redteamOpReport("platformEnvAdaptStatus", { ...envPayload, drift: 1 }).undeclared,
    ["drift"],
    "探测器认不出未登记的字段，本条判据失效了",
  );

  /* skills op 的块字段 + 它自己的信封（availability / bySource / byDir / libraries / note）。 */
  const skillsPayload = {
    ok: true,
    total: 3,
    fromPlugin: 1,
    items: [],
    byLibrary: { official: 2, redteam: 1 },
    shadowed: 1,
    availability: { summary: {} },
    bySource: [],
    byDir: [],
    libraries: { redteam: 1, official: 2 },
    note: "演示",
  };
  assert.deepEqual(contract.redteamOpReport("skillCatalog", skillsPayload).undeclared, []);
  assert.deepEqual(
    contract.redteamOpReport("skillCatalog", { ...skillsPayload, surprise: true }).undeclared,
    ["surprise"],
  );
});

test("事实库读类 op：信封键受声明约束，多一个就红；写 op 的失败形状统一", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-purge-wp12-store-"));
  const store = new RedteamStore(root);
  try {
    const { id } = store.openEngagement("wp12-parity", ["198.51.100.0/24"], { bindCurrent: false });
    for (const op of ["stats", "assets", "vulns", "credentials", "chain", "stages", "shots"]) {
      const payload = dispatch(store, { op, engagement: id });
      assert.equal(payload.ok, true, `${op} 在空库上不该失败：${JSON.stringify(payload).slice(0, 120)}`);
      assert.deepEqual(
        contract.redteamOpReport(op, payload).undeclared,
        [],
        `${op} 的回包里有契约未登记的顶层键`,
      );
    }
    /* 写 op 失败：形状必须是 { ok:false, error }，不留第四种形态给模型猜。 */
    const failed = dispatch(store, { op: "deleteScorePoint", engagement: id, id: 999999 });
    assert.deepEqual(Object.keys(failed).sort(), ["error", "ok"]);
    assert.equal(failed.ok, false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
