/**
 * lib/audit/vocabulary.js — 审计事件名的唯一权威：不在词表里的名字落不了盘。
 *
 * 为什么要有这一份：事件名原先是自由发挥区 —— 新增一个语义重叠、前缀不同的名字，
 * 全仓没有任何地方会红。名字一旦漂开，按 event 前缀检索就捞不全一次 apply 的全部
 * 事件；而「捞不全」在事后复核里看起来和「没发生过」一模一样。
 *
 * 为什么按家族分组：两件事必须一眼分清 —— 一条事件是某个文件上的一次探针（文件证据），
 * 还是整层的结论（引用证据）。同层两族混排，读者会以为层结论也是逐文件的。
 *
 * 收谁不收谁：只收今天真实在用的名字。来源有两处 —— 落账方 lib/audit/report.js 写出的
 * 四种家族模板，加上事件层由入库用例与冒烟脚本实际构造的那几个。新增事件先进这份词表，
 * 再写写入方；反过来的顺序会在第一次落盘时被 ./events.js 拦下。
 *
 * 读侧不查词表：旧日志里的名字可能早就不在清单里，读的时候抛错等于把历史日志变成
 * 不可读的。词表只在写侧生效。
 */
import { LAYER_ORDER } from "./layers.js";

// 文件层三族：apply 时每个落点一条，后缀跟着判定走（applied / miss / skipped）。
const FILE_FAMILIES = ["patch-applied", "patch-miss", "patch-skipped"];

// 结论层一族：每层一条，证据是指向本层最后一条探针事件的引用。
const CONCLUSION_FAMILY = "apply-result";

/**
 * 分组：组名 → 该组今天真实在用的名字。
 *
 * 结论层与文件层按层展开（每层各一组），事件层是不带 layer 的那两个，
 * 「测试与冒烟」是入库用例与冒烟脚本构造的名字 —— 不是生产写入方，但同样是事实，
 * 词表不收它们就等于逼着现状变红。
 */
export const EVENT_GROUPS = Object.freeze({
  结论层: Object.freeze(LAYER_ORDER.map((layer) => `${layer}.${CONCLUSION_FAMILY}`)),
  文件层: Object.freeze(LAYER_ORDER.flatMap(
    (layer) => FILE_FAMILIES.map((family) => `${layer}.${family}`),
  )),
  事件层: Object.freeze(["cli.invoke", "route.reject"]),
  测试与冒烟: Object.freeze(["code.probe", "tool.loaded"]),
});

/** 全部合法名字：去重后按字典序，写侧判据遍历它，读的人不必先知道分组。 */
export const EVENT_NAMES = Object.freeze([...new Set(Object.values(EVENT_GROUPS).flat())].sort());

/** 结论层事件的后缀：这一族必须带 layer，否则事后分不清结论是替谁下的。 */
export const CONCLUSION_SUFFIX = `.${CONCLUSION_FAMILY}`;

/** 文件层事件的三个后缀：同一条后缀在每个层里都合法，只有层名能说明它替谁取证。 */
const FILE_SUFFIXES = FILE_FAMILIES.map((family) => `.${family}`);

/**
 * 名字是不是文件层事件（`{layer}.patch-*`）。
 *
 * 写侧用它判「必须带 layer 与 runId」；读侧刻意不用它 —— 旧日志里的名字
 * 早于这条规则，读的时候按新规则抛错等于把历史日志变成不可读的。
 */
export function isFileEventName(name) {
  return typeof name === "string" && FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

const EVENT_NAME_SET = new Set(EVENT_NAMES);

/** 名字在不在词表里。写侧用它拦新名字；读侧刻意不用它，旧名字照样要把日志读回来。 */
export function isKnownEventName(name) {
  return typeof name === "string" && EVENT_NAME_SET.has(name);
}

/** 编辑距离：只服务「最接近的合法名」，名字很短，两重循环足够，不引任何依赖。 */
function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * 词表里与它最接近的合法名；一个都不像时返回 null。
 *
 * 不猜的边界：距离超过「名字长度的一半」就认为不像 —— 报一个南辕北辙的近似名，
 * 比不报更浪费时间。
 */
export function nearestEventName(name) {
  if (typeof name !== "string" || name === "") return null;
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of EVENT_NAMES) {
    const current = distance(name, candidate);
    if (current < bestDistance) {
      bestDistance = current;
      best = candidate;
    }
  }
  if (best === null) return null;
  return bestDistance <= Math.max(2, Math.floor(best.length / 2)) ? best : null;
}
