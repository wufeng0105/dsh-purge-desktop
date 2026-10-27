/**
 * lib/version.js — 版本比较的唯一实现：一个全序，而不是四段手写分支。
 *
 * 为什么需要它：版本比较原先在三处各写一遍 —— 宿主门禁在自己文件里按「四条互斥分支」
 * 比（prerelease 分支排在 patch 之前，于是同一 minor 下 patch 号根本没参与比较：0.2.2-rc.1
 * 被判成「比 0.2.1-rc.2 更旧」，0.2.0-rc.5 被放行），戳的对齐判据另写一份 major.minor
 * 相等，更新通道再写一份。同一件「谁新谁旧」有三份实现，改一处不会连带另两处。
 *
 * 判据按 semver 2.0.0 的 precedence：主次补丁按数值比；**正式版高于同号预发布**
 * （`0.2.1` > `0.2.1-rc.2`）；两边都是预发布时逐段比，数字段按数值、非数字段按字典序，
 * 数字段小于非数字段，前缀相同则段数多的更新（`alpha` < `alpha.1`）。
 *
 * 边界：纯函数，不读盘、不读环境变量、不 import 任何项目内模块。
 */

/**
 * 解析 semver 形态的版本串。构建元数据（`+sha`）不参与比较，解析时丢掉。
 *
 * 解析失败返回 null —— 调用方必须自己决定「不认识的版本」怎么处置，
 * 这里不许猜一个值出来（猜出来的版本号长得像事实，却是验不了的）。
 *
 * @param {unknown} raw
 * @returns {{major:number, minor:number, patch:number, prerelease:string[]}|null}
 */
export function parseVersion(raw) {
  const text = String(raw == null ? "" : raw).trim().replace(/^v/i, "");
  if (!text) return null;
  const m = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

/** 数字段：非负整数按数值比，其余按字符串比（semver 的「数字段小于非数字段」由此而来）。 */
function isNumericSegment(segment) {
  return /^\d+$/.test(segment);
}

/**
 * 预发布段的比较：空数组大于非空（正式版更高），非空逐段比。
 *
 * @param {string[]} left
 * @param {string[]} right
 * @returns {number} -1 / 0 / 1
 */
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i += 1) {
    const a = left[i];
    const b = right[i];
    // 前缀一方先耗尽：段数少的那一方更低（alpha < alpha.1）。
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const na = isNumericSegment(a);
    const nb = isNumericSegment(b);
    if (na && nb) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (na !== nb) return na ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * 两个版本的全序比较。任一方解析不出来时返回 null —— 「不可判」不是「相等」。
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {-1|0|1|null} left 低于 / 等于 / 高于 right；null = 不可判
 */
export function compareVersions(left, right) {
  const a = typeof left === "object" && left ? left : parseVersion(left);
  const b = typeof right === "object" && right ? right : parseVersion(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * 两个版本是否落在同一主次版本上（补丁目标结构的边界）。
 *
 * 任一方解析失败时退回字符串相等 —— 坏数据只该更保守（多打一次），
 * 不该被当成已对齐。
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function sameMajorMinor(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return String(left == null ? "" : left).trim() === String(right == null ? "" : right).trim();
  return a.major === b.major && a.minor === b.minor;
}

/** 人类可读的段名，只为把「差在哪一段」写进拒绝理由。与 `compareVersions` 一样接受解析结果。 */
export function lowestDifferingField(left, right) {
  const a = typeof left === "object" && left ? left : parseVersion(left);
  const b = typeof right === "object" && right ? right : parseVersion(right);
  if (!a || !b) return "unknown";
  if (a.major !== b.major) return "major";
  if (a.minor !== b.minor) return "minor";
  if (a.patch !== b.patch) return "patch";
  return "prerelease";
}
