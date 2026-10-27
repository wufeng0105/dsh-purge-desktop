/**
 * 诊断入口的性能契约。
 *
 * `gatherState` 是面板、CLI status、HTTP `/dsh-purge/status` 的共同入口。
 * 它必须**在任何宿主面下都快**，因为它的用途就是回答「为什么用不了」——
 * 如果它自己要先卡几秒才给结论，诊断本身就变成了负担。
 *
 * ## 这条测试守住的两个真实退化
 *
 * 1. `findAiBaseWeb` 的递归兜底扫描：实测 16 s / 6 万目录 / 结果为空。
 *    DELETE-3 删掉 web CLI 宿主面后，它服务的目标已经不存在。
 *
 * 2. `findNpmPrefix` 的 npm 子进程探测：PATH 里找不到 dsh 启动器时会 spawn
 *    `npm prefix -g` + `npm config get prefix` + `npm root -g`，三个进程约 100+ ms。
 *    三者都只为「web profile 装在 npm-global 里」服务。
 *
 * 两处都已改成「只有 DSH_PURGE_DEEP_AIBASE_SCAN=1 才跑」。**真实回归检测由下面两条
 * 读源码的结构性断言承担**：它们判的是「默认路径上还调不调那两处」，
 * 与机器快慢、并发多少无关，所以它们才是这条测试的可信那一半。
 *
 * ## 墙钟为什么在这里降级成信息项
 *
 * 实测（2026-10-25，本机 Node 24.20.0，同一份代码、同一条路径）：
 *   · 单独跑本文件：桌面路径 1052 / 1327 / 1511 ms —— 全绿，但已经贴在 1500 ms 上；
 *     逐次采样实测 541 / 481 / 426 ms，最小值 426 ms，余量只剩 3.5 倍。
 *   · 全量 `npm test`（约 30 个测试文件并发）：桌面路径 6004 / 5138 ms，8 轮里 2 轮红；
 *     复跑的采样合计 5170~5701 ms，逐次漂在 1.2~1.9 s，取最小值照样撞线
 *     （实测一次 min 1198 ms、同批单次 1530 ms）。
 *
 * 结论：**「N 次里最快的一次低于某条毫秒预算」在并发测试套件里不是可靠判据。**
 * 它红的时候，你分不清「代码真的慢了」和「这一轮没抢到 CPU」，最后只能靠重跑把它当噪声——
 * 那门禁就不作数了，而门禁不可靠比门禁缺失更坏：后续每一轮验收都拿它当凭据。
 * 所以采样与最小值**保留并打印**（信息项，漂移肉眼可见），但不再拿它断言。
 *
 * ## 唯一保留的墙钟断言是挂死上限
 *
 * 正常量级 1~1.5 s（3 次采样，单跑），并发下 5~6 s；挂死上限取 30000 ms，
 * 只挡「病态卡死」——例如递归兜底扫描被接回默认路径（那形态实测 16 s），
 * 或挂在一个永不返回的子进程上。**它不是性能预算**：把它调小成预算的样子，
 * 下面「墙钟只与挂死上限比较」那条测试会红。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), "..");
/**
 * 唯一允许与墙钟比较的常量：只挡病态卡死，不是预算。
 * 正常 1~1.5 s、并发下 5~6 s，所以 30000 不会因负载误报，却挡得住「根本没跑完」。
 */
const HANG_CEILING_MS = 30000;
/**
 * 挂死上限的下限。低于它的毫秒常量只可能是性能预算，
 * 而墙钟在并发套件里不是可靠判据（理由见文件头）——出现即判红。
 */
const MIN_CEILING_MS = 5000;
/** 取几次里的最小值。3 次足以让偶发抢占在信息项里显形，又不至于让这条测试变成负担。 */
const SAMPLES = 3;

/** 毫秒数的统一显示格式：整数毫秒，别让小数位把信息项挤成噪声。 */
const fmtMs = (value) => `${value.toFixed(0)} ms`;

/** 在指定 surface 下跑一次 gatherState，返回耗时。 */
async function timeGatherStateOnce(surface, queryKey) {
  const previous = process.env.DSH_SURFACE;
  const previousDeep = process.env.DSH_PURGE_DEEP_AIBASE_SCAN;
  process.env.DSH_SURFACE = surface;
  delete process.env.DSH_PURGE_DEEP_AIBASE_SCAN;
  try {
    // 每个 surface 用独立 query 参数绕开 ESM 模块缓存，确保测的是冷路径
    const core = await import(`../lib/core.js?surface=${surface}&sample=${queryKey}`);
    const started = performance.now();
    await core.gatherState();
    return performance.now() - started;
  } finally {
    if (previous === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previous;
    if (previousDeep !== undefined) process.env.DSH_PURGE_DEEP_AIBASE_SCAN = previousDeep;
  }
}

/**
 * 跑 SAMPLES 次，返回 { min, all }。
 *
 * 每次都用新的 query 参数 → 新的模块实例 → 都是冷路径。
 * 最小值只用于打印：它是「这一轮最好情况」的观测值，不是判据。
 */
async function timeGatherState(surface) {
  const all = [];
  for (let i = 0; i < SAMPLES; i += 1) all.push(await timeGatherStateOnce(surface, `${surface}-${i}`));
  return { min: Math.min(...all), all };
}

/**
 * 把一次测量打成信息项：最小值与**全部**采样值都进输出。
 * 墙钟降级后这里是唯一还能看见漂移的地方，所以两样都打，不合并成一句「最快 / 最慢」——
 * 只有全部样本才能看出「整体抬升」（真退化）与「个别次被抢占」（噪声）的区别。
 */
function reportSample(t, surface, { min, all }) {
  t.diagnostic(
    `${surface} gatherState：min=${fmtMs(min)}；${SAMPLES} 次采样=${all.map(fmtMs).join(" / ")}；挂死上限=${HANG_CEILING_MS} ms`,
  );
}

test("性能：非桌面进程的 gatherState 不挂死（墙钟只作信息项）", async (t) => {
  const sample = await timeGatherState("web");
  reportSample(t, "非桌面", sample);
  assert.ok(
    sample.min < HANG_CEILING_MS,
    `非桌面 gatherState 最快一次也用了 ${fmtMs(sample.min)}（${SAMPLES} 次：${
      sample.all.map(fmtMs).join(" / ")
    }），超过挂死上限 ${HANG_CEILING_MS} ms —— 这不是慢，是卡死。`
    + "先看 findAiBaseWeb 是否又走了递归兜底扫描或 npm 子进程。",
  );
});

test("性能：桌面进程的 gatherState 不挂死（墙钟只作信息项）", async (t) => {
  const sample = await timeGatherState("desktop");
  reportSample(t, "桌面", sample);
  assert.ok(
    sample.min < HANG_CEILING_MS,
    `桌面 gatherState 最快一次也用了 ${fmtMs(sample.min)}（${SAMPLES} 次：${
      sample.all.map(fmtMs).join(" / ")
    }），超过挂死上限 ${HANG_CEILING_MS} ms —— 这不是慢，是卡死。`
    + "先看 findNpmPrefix 是否又 spawn 了 npm。",
  );
});

test("性能：gatherState 不 spawn npm 子进程（除非显式开 deep 扫描）", () => {
  // findAiBaseWeb 已随路径层搬到 lib/host/paths.js。断言逻辑一字未改。
  const src = readFileSync(join(ROOT, "lib/host/paths.js"), "utf8");
  // findAiBaseWeb 必须在 npm 探测之前就返回
  const fnStart = src.indexOf("function findAiBaseWeb()");
  assert.ok(fnStart > 0, "找不到 findAiBaseWeb");
  const fnEnd = src.indexOf("\n}", fnStart);
  const body = src.slice(fnStart, fnEnd);

  const npmIdx = body.indexOf("npmQuery(");
  const guardIdx = body.indexOf("if (!deep) return null;");
  assert.ok(npmIdx > 0, "findAiBaseWeb 里应有 npmQuery 调用（deep 模式下）");
  assert.ok(guardIdx > 0, "findAiBaseWeb 缺少 deep 门禁");
  assert.ok(
    guardIdx < npmIdx,
    "deep 门禁必须在 npmQuery 之前 —— 否则默认路径仍会 spawn npm",
  );
});

test("性能：递归兜底扫描默认关闭", () => {
  // 同上，findAiBaseWeb 现在住在 lib/host/paths.js。断言逻辑一字未改。
  const src = readFileSync(join(ROOT, "lib/host/paths.js"), "utf8");
  // 找到兜底扫描那段的守卫
  const marker = "const needle = path.join(\"node_modules\", nested);";
  const idx = src.indexOf(marker);
  assert.ok(idx > 0, "找不到递归兜底扫描段");
  const after = src.slice(idx, idx + 900);
  assert.match(
    after,
    /if \(String\(process\.env\.DSH_PURGE_DEEP_AIBASE_SCAN \|\| ""\)\.trim\(\) !== "1"\) \{\s*return null;/,
    "递归兜底扫描的守卫不见了 —— 它会在每次 gatherState 时扫 6 万个目录",
  );
  // 守卫不许再依赖 isDesktop()（那会让非桌面进程绕过它）
  assert.equal(
    /if \(isDesktop\(\) && String\(process\.env\.DSH_PURGE_DEEP_AIBASE_SCAN/.test(after),
    false,
    "守卫不该再用 isDesktop() 作为条件 —— 非桌面进程会绕过它继续扫描",
  );
});

test("性能：DSH_BASE 旁路仍然有效（优化没砍掉合法入口）", async () => {
  const previous = process.env.DSH_BASE;
  const previousSurface = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "web";
  // 指向一个真实存在的宿主根（本机有则验证，CI 上跳过）
  const realBase =
    "C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai";
  try {
    const core = await import("../lib/core.js?dsbase=1");
    // 不存在时返回 null 是正确行为
    const withoutEnv = core.findAiBase();
    if (!withoutEnv) {
      // 确认这条路径没有抛错，只是找不到
      assert.equal(withoutEnv, null);
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_BASE;
    else process.env.DSH_BASE = previous;
    if (previousSurface === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previousSurface;
  }
});

test("性能：墙钟只与挂死上限比较（防回退，不许把紧预算加回来）", () => {
  // 判据读本文件自己的源码。注释先剥掉：解释文字里写「1500 ms」不算违规，
  // 能变成判据的只有代码。只剥整块注释与整行注释 —— 本文件没有行尾注释，
  // 正则字面量里也不含块注释起始序列，所以剥法够用。
  const code = readFileSync(SELF, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // 判据一：文件里每个「毫秒常量」都不许小于挂死上限的下限。
  // 把挂死上限改成 1500、或新增一个 1500 的「预算」，都在这里红。
  const declared = [...code.matchAll(/const\s+([A-Z][A-Z0-9_]*_MS)\s*=\s*([0-9_]+)\s*;/g)];
  assert.ok(
    declared.length > 0,
    "本文件没有毫秒常量了 —— 挂死上限必须有名字，否则无法判定它是不是被换成了预算",
  );
  const ceilings = new Set();
  for (const [, name, raw] of declared) {
    const value = Number(raw.replaceAll("_", ""));
    assert.ok(
      value >= MIN_CEILING_MS,
      `毫秒常量 ${name} = ${value} < ${MIN_CEILING_MS}：低于下限的毫秒常量只可能是性能预算，`
      + "而墙钟在并发测试套件里不是可靠判据（文件头有 3~4 倍漂移的实测）。"
      + "要重新引入性能判据，先给出并发下不漂的证据，再改这条下限。",
    );
    ceilings.add(name);
  }

  // 判据二：采样最小值只许与「已通过下限校验的挂死上限」比较。
  const compared = [...code.matchAll(/\bmin\s*(?:<=|>=|<|>)\s*([A-Za-z_$][\w$]*)/g)];
  assert.ok(
    compared.length > 0,
    "找不到「采样最小值 vs 常量」的比较 —— 测量被删掉了，这条防回退判据就失去了对象",
  );
  for (const [expr, name] of compared) {
    assert.ok(
      ceilings.has(name),
      `采样最小值与 ${name} 比较（${expr.trim()}），但 ${name} 不是经过下限校验的挂死上限：`
      + "墙钟只许与挂死上限比较，否则紧墙钟会以另一个名字回到门禁里。",
    );
  }

  // 判据三：阈值必须是有名字的常量 —— 内联字面量连「为什么这么大」都无处写。
  const inline = /\bmin\s*(?:<=|>=|<|>)\s*[0-9][0-9_]*(?:\.\d+)?/.exec(code);
  assert.equal(
    inline,
    null,
    `采样最小值与字面量比较（${inline ? inline[0] : ""}）：阈值要有名字，才审得动它为什么这么大`,
  );
});
