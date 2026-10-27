/**
 * lib/patch/status.js — 补丁判定状态的唯一权威表，其余五处只许消费它。
 *
 * 为什么需要它：同一个 status 原先在六个地方各自解释 —— 合并多宿主报告时的优先级、
 * 诊断轨的软硬判定、诊断轨的逐补丁复核、审计轨的层结论、设置页的分组、设置页的色调。
 * 于是 `missing_file` 在四处是「跳过」、在审计轨是「失败」，`read_error` 在设置页上
 * 显示成「没事」。同一个词在不同位置有两个意思，只读日志的人就无法回答「卡在哪」。
 *
 * 边界：纯数据 + 纯函数。不 import 任何项目内模块、不读写文件、不读环境变量。
 * 因此「一条补丁在多个根上取最差」的次序与「算不算失败」是两列：`missing_file`
 * 排得靠前（某个根上缺文件必须显示出来），但它不算失败 —— 那批补丁在当前宿主
 * 本来就不适用，据实记成失败会让每一次干净的 apply 都像出了事故。
 *
 * `pattern_not_found` 要分两档，这是本表最容易被读错的一处：单看 status 它算失败，
 * 但补丁自己声明了 `onMiss: warn / ignore` 时，诊断轨、审计轨、设置页三处都该按
 * 「这一版不需要」放过。所以凡是有补丁对象在场的调用方，一律走下面的 `isSoftOk`
 * 与带 `softOk` 参数的折算函数；只有拿不到补丁对象时才退回本表的单值口径。
 */

/** 三种色调，取值与设置页的状态点一致。 */
const TONE_OK = "ok";
const TONE_IDLE = "idle";
const TONE_ERROR = "error";

/**
 * 一行的五行判定，冻结后不许在运行期改。
 *
 * @param {number} rank 取最差的次序，越小越差
 * @param {boolean} alwaysSoft 这条 status 本身就不构成失败
 * @param {boolean} countsAsFailure 单看这条 status 算不算失败
 * @param {string} tone 色调
 * @param {string} displayBucket 设置页分组时的归桶
 */
function row(rank, alwaysSoft, countsAsFailure, tone, displayBucket) {
  return Object.freeze({ rank, alwaysSoft, countsAsFailure, tone, displayBucket });
}

/**
 * 每个已知 status 的五行判定。键就是日志与报告里出现的那一串字面量。
 *
 * - `rank`：合并多宿主报告时「取最差」的次序。未知 status 落到 0（认不出的状态
 *   按最差处理，不许被当成好消息 —— 与改前 `?? 0` 的兜底一致）。
 * - `alwaysSoft`：这条 status 自己就不构成失败，与补丁声明无关。**这一列任何一格
 *   变化都会改变 apply 的 `soft` / `failed` 计数**（`summarizeApplyReport`）。
 * - `countsAsFailure`：审计轨与设置页用的口径。
 * - `tone`：`ok` / `idle` / `error` 三选一。
 * - `displayBucket`：取值与 `rollupDisplayStatus` 的返回值同域 —— `applied` /
 *   `pending` / `unmatched` / `skip`，失败一组归 `fail`，认不出的归 `unknown`。
 */
export const STATUS = Object.freeze({
  failed: row(0, false, true, TONE_ERROR, "fail"),
  "write_error:<msg>": row(10, false, true, TONE_ERROR, "fail"),
  pattern_not_found: row(20, false, true, TONE_ERROR, "fail"),
  unmatched: row(25, false, true, TONE_ERROR, "unmatched"),
  read_error: row(30, false, true, TONE_ERROR, "fail"),
  missing_file: row(40, true, false, TONE_IDLE, "skip"),
  pending: row(45, false, false, TONE_IDLE, "pending"),
  applied: row(50, true, false, TONE_OK, "applied"),
  already: row(60, true, false, TONE_OK, "applied"),
  na: row(70, true, false, TONE_IDLE, "skip"),
  off: row(80, true, false, TONE_IDLE, "skip"),
  skipped: row(90, true, false, TONE_IDLE, "skip"),
  deferred: row(95, false, false, TONE_IDLE, "skip"),
});

/**
 * 按字面量查一行；`write_error` 按前缀匹配 —— 真实取值是冒号后面还带底层错误文本
 * （`write_error:Error: EPERM: operation not permitted, open '<file>'`）。
 *
 * @param {unknown} status
 * @returns {{rank:number, alwaysSoft:boolean, countsAsFailure:boolean, tone:string, displayBucket:string}|null}
 */
function rowOf(status) {
  if (typeof status !== "string") return null;
  if (Object.hasOwn(STATUS, status)) return STATUS[status];
  if (status.startsWith("write_error:")) return STATUS["write_error:<msg>"];
  return null;
}

/** 取最差的次序；越小越差，认不出的按最差。 */
export function rankOf(status) {
  const found = rowOf(status);
  return found ? found.rank : 0;
}

/** 这条 status 是不是「与补丁声明无关地就能放过」。 */
export function isAlwaysSoft(status) {
  const found = rowOf(status);
  return found ? found.alwaysSoft : false;
}

/** 单看这条 status 算不算失败。 */
export function countsAsFailure(status) {
  const found = rowOf(status);
  return found ? found.countsAsFailure : false;
}

/** 设置页的色调；认不出的按 `idle`（与改前的兜底一致）。 */
export function toneOf(status) {
  const found = rowOf(status);
  return found ? found.tone : TONE_IDLE;
}

/** 设置页分组的归桶；认不出的既不算 `skip` 也不算 `applied`。 */
export function displayBucketOf(status) {
  const found = rowOf(status);
  return found ? found.displayBucket : "unknown";
}

/**
 * 单条补丁的判定折算成审计轨的四态（ok / fail / skip）。
 *
 * 只有 `applied` 是 ok：`already` 与 `skipped` 都是「这一轮不需要动」，不是结论。
 * 失败一组按本表算，其余一律 skip —— 把 `pending` 记成 fail 会让每次改表都像出了
 * 事故，而把读写失败记成 skip 会把「不知道」说成「没事」。
 *
 * `softOk` 是调用方按 `isSoftOk` 判好的补丁级结论：为真时 `pattern_not_found`
 * 折成 skip。审计轨与诊断轨都用这一个入口，两边的分歧只剩「有没有把补丁对象传进来」。
 *
 * @param {unknown} status
 * @param {{softOk?:boolean}} [context]
 */
export function resultOfStatus(status, context = {}) {
  if (status === "applied") return "ok";
  if (status === "pattern_not_found" && context.softOk === true) return "skip";
  return countsAsFailure(status) ? "fail" : "skip";
}

/**
 * 补丁声明里的 on-miss 口径。
 *
 * 表里漏写字段时落到 `fail`：缺省的失败是设计意图，漏写会让补丁门禁红，
 * 逼人显式选择，而不是悄悄退回「静默失效」。
 *
 * @param {{onMiss?:string}|null} patch
 * @returns {"fail"|"warn"|"ignore"}
 */
export function onMissKind(patch) {
  const value = patch?.onMiss;
  if (value === "warn" || value === "ignore") return value;
  return "fail";
}

/**
 * 这条补丁的失败算不算「能放过」。
 *
 * 与搬出 `lib/core.js` 之前的逐支等价：先看 status 本身是否总是能放过；不是的话只有
 * `pattern_not_found` 还有商量余地 —— `strictFiles` 把它钉死成失败，其余看补丁声明的
 * `onMiss`。`onMissOf` 住在引擎里，本模块是叶子，所以由调用方把判定函数递进来；
 * 没递就按 `fail` 算（与补丁表漏写 `onMiss` 时的缺省一致）。
 *
 * @param {{status?:string, patch_id?:number, id?:number}|null} row
 * @param {{strictFiles?:boolean}|null} patch 调用方按 row 的 id 查好的补丁；null 表示查不到
 * @param {((patch:object|null)=>"fail"|"warn"|"ignore")|null} resolveOnMiss
 */
export function isSoftOk(row, patch = null, resolveOnMiss = null) {
  if (!row) return false;
  if (isAlwaysSoft(row.status)) return true;
  if (row.status !== "pattern_not_found") return false;
  if (patch && patch.strictFiles) return false;
  const onMiss = typeof resolveOnMiss === "function" ? resolveOnMiss(patch) : "fail";
  return onMiss !== "fail";
}

/**
 * 列表上的「已就绪」：已写入、或当前版本不需要 / 组件未装。
 *
 * 与 `resultOfStatus` 同源但不是同一个问题：`na` 在表里是软放过，却不该算就绪；
 * `deferred` 也不算。判据从本表的 `alwaysSoft` 与归桶两列推出来，写在这里是为了
 * 别处不再按 status 字符串现列一遍。
 *
 * @param {unknown} status
 */
export function isReadyStatus(status) {
  const found = rowOf(status);
  if (!found) return false;
  // 补丁在当前面上不适用：显示为跳过，但「就绪」问的是这一份安装有没有缺活。
  if (status === "na") return false;
  if (found.displayBucket === "applied") return true;
  return found.alwaysSoft === true && found.displayBucket === "skip";
}

/**
 * 带补丁声明的「已就绪」：`pattern_not_found` 是否放过由 `isSoftOk` 定。
 *
 * @param {unknown} status
 * @param {{strictFiles?:boolean}|null} patch
 * @param {((patch:object|null)=>"fail"|"warn"|"ignore")|null} [resolveOnMiss]
 */
export function isReady(status, patch = null, resolveOnMiss = null) {
  if (isReadyStatus(status)) return true;
  if (status !== "pattern_not_found") return false;
  return isSoftOk({ status }, patch, resolveOnMiss);
}
