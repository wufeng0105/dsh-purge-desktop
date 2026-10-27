/**
 * test/settings-conclusion.test.mjs — 顶栏那一句结论必须用全量口径：pending 存在时不许说「全部生效」。
 *
 * 为什么单独立一份：结论句原先只读 `skipped`，而 `pending` 只进了状态点的颜色。于是
 * 「2 条待应用」的机器上，顶栏显示绿的「已生效」，结论句写着「全部生效，8 条按设计跳过」——
 * 一句假话，而且它长得跟真话一模一样。这种失败没有症状：页面不报错，数字也在，只是
 * 结论与事实相反。所以判据不看「有没有结论句」，看**在四种数各自非零时它说什么**。
 *
 * 判据只碰设置页片段里的纯函数（`settingsConclusion` / `settingsCountItems`）：
 * 片段是文本装配进 `client.js` 的，靠 `test/helpers/settings-fragment.mjs` 在 VM 里求值。
 */
import { test } from "node:test";
import assert from "node:assert";

import { loadFragmentHelpers, readRepo, renderKey } from "./helpers/settings-fragment.mjs";

const PAGE = "lib/client-src/settings/page.js";
/** 结论句与四种数住在状态页签片段里（本批从页面壳搬出去）；顶栏的取样仍在页面壳。 */
const STATUS = "lib/client-src/settings/status-tab.js";
const HELPERS = ["settingsConclusion", "settingsCountItems", "settingsInt"];
const { settingsConclusion, settingsCountItems } = loadFragmentHelpers(STATUS, HELPERS);

/** 四份现场：干净、有待应用、有失败、待重启。数都是「服务端算好的」，夹具照抄端点字段名。 */
const FIXTURES = {
  clean: { patches_applied: 54, patches_pending: 0, patches_skipped: 8, patches_na: 4, patches_failed: 0, boot_full_quit: false },
  pending: { patches_applied: 54, patches_pending: 2, patches_skipped: 8, patches_na: 4, patches_failed: 0, boot_full_quit: false },
  failed: { patches_applied: 50, patches_pending: 1, patches_skipped: 8, patches_na: 4, patches_failed: 3, boot_full_quit: false },
  restart: { patches_applied: 54, patches_pending: 0, patches_skipped: 8, patches_na: 4, patches_failed: 0, boot_full_quit: true },
};

/** 「全部生效」只许出现在它的前提成立时：这句话是判据本身，不是文案偏好。 */
const ALL_LIVE_ZH = "全部生效";

/**
 * 把一套结论函数的违规逐条列出来。
 *
 * 写成函数而不是逐个 assert，是为了能拿一版**故意坏的**实现喂给它（红灯夹具）：
 * 探测器认不出「pending 还说全部生效」，这条用例就只是纸面判据。
 *
 * @param {(state:object) => {key:string, params:Record<string,string>}} conclusionFn 结论函数
 * @param {(state:object) => Array<{key:string, n:number}>} countsFn 计数函数
 * @returns {string[]} 违规明细
 */
function violations(conclusionFn, countsFn) {
  const problems = [];

  const pendingSpec = conclusionFn(FIXTURES.pending);
  if (pendingSpec.key === "conclusion.ok") {
    problems.push("有待应用（2 条）时结论仍是 conclusion.ok —— 顶栏在用「全部生效」盖住 pending");
  } else {
    const rendered = renderKey(pendingSpec.key, pendingSpec.params);
    if (rendered.zh.includes(ALL_LIVE_ZH) || rendered.en.toLowerCase().includes("all live")) {
      problems.push(`有待应用时结论文案仍写着「${ALL_LIVE_ZH}」：${rendered.key}`);
    }
    if (String(pendingSpec.params.pending) !== "2") {
      problems.push(`有待应用时结论没把 2 说出来（params.pending=${JSON.stringify(pendingSpec.params.pending)}）`);
    }
  }

  const cleanSpec = conclusionFn(FIXTURES.clean);
  const cleanRendered = renderKey(cleanSpec.key, cleanSpec.params);
  if (cleanSpec.key !== "conclusion.ok" || !cleanRendered.zh.includes(ALL_LIVE_ZH)) {
    problems.push(`干净现场（无待应用无失败）应给出「${ALL_LIVE_ZH}」这一档，实得 ${cleanSpec.key}`);
  }

  const failedSpec = conclusionFn(FIXTURES.failed);
  if (failedSpec.key !== "conclusion.failed") problems.push(`有失败时应走 conclusion.failed，实得 ${failedSpec.key}`);
  else if (String(failedSpec.params.failed) !== "3") problems.push("失败数没有进结论句的参数");

  const restartSpec = conclusionFn(FIXTURES.restart);
  if (restartSpec.key !== "conclusion.restart") problems.push(`待重启的一档丢了，实得 ${restartSpec.key}`);

  const items = countsFn(FIXTURES.clean);
  const keys = items.map((item) => item.key);
  for (const needed of ["counts.applied", "counts.pending", "counts.skipped", "counts.na"]) {
    if (!keys.includes(needed)) problems.push(`四种数里缺 ${needed}`);
  }
  if (keys.includes("counts.failed")) problems.push("失败为 0 时不该出现失败那一格");
  const values = Object.fromEntries(items.map((item) => [item.key, item.n]));
  if (values["counts.applied"] !== 54 || values["counts.pending"] !== 0 || values["counts.skipped"] !== 8 || values["counts.na"] !== 4) {
    problems.push(`四种数的取值与端点字段不一致：${JSON.stringify(values)}`);
  }
  const withFailed = countsFn(FIXTURES.failed).map((item) => item.key);
  if (!withFailed.includes("counts.failed")) problems.push("有失败时结论区没多出失败那一格");

  return problems;
}

test("红灯夹具：把结论写死成「全部生效」必须被这条用例抓住", () => {
  const broken = () => ({ key: "conclusion.ok", params: { applied: "54", pending: "2", skipped: "8", na: "4" } });
  const caught = violations(broken, settingsCountItems);
  assert.ok(caught.length > 0, "探测器认不出「pending 还说全部生效」这种写法，判据本身失效了");
  assert.ok(
    caught.some((line) => line.includes("conclusion.ok") || line.includes(ALL_LIVE_ZH)),
    `红灯命中位置不对：${caught.join(" / ")}`,
  );
});

test("结论句用全量口径：四种数各自非零时都说对，全部生效只在前提成立时出现", () => {
  assert.deepEqual(violations(settingsConclusion, settingsCountItems), [], "结论句与四种数对不上");
});

test("顶栏不报数：同一组数字全页只出现一次（摘要那一行）", () => {
  const page = readRepo(PAGE);
  // 顶栏（header 块）里不许再拼数字：两种旧写法都点名。
  const header = page.slice(page.indexOf('h("header"'), page.indexOf('role: "tablist"'));
  assert.ok(header.length > 0 && header.includes("dshp-page__head"), "取不到顶栏那一段：取样点变了，判据已失效");
  assert.ok(!header.includes("patches_applied"), "顶栏又读了已生效数：数字该只在摘要出现一次");
  assert.ok(!header.includes(" / "), "顶栏还在拼「N / M」这种比值");
  // 补丁分节的标题也不再挂第二遍计数。
  const section = readRepo("lib/client-src/settings/patches-tab.js");
  assert.ok(!/count:\s*applied/.test(section), "补丁分节标题又挂上了「已生效 / 总数」");
  // 结论句必须经纯函数，不在渲染里现拼。
  assert.ok(readRepo(STATUS).includes("settingsConclusion("), "结论句没走 settingsConclusion：分支会重新长回渲染里");
});
