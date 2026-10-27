/**
 * lib/log-rolling.js — 两个日志写入器共用的滚动规格与动作。
 *
 * 为什么单列：`diag.jsonl` 与宿主探针日志原先各写一套阈值（4 MB / 2 MB）、各写一套
 * 检查频率、各写一次 rename —— 两个常量抄在两个文件里，改一个忘一个之后，同一台机器
 * 上两份日志的保留行为就不一样了。规格收在这里，两个写入器只调用 `rotateIfNeeded`。
 *
 * 保留几代是「留多久」的换算：单代 4 MB，按真机实测 ~9.6 KB/min 折算，1 代约 7 小时 ——
 * 短到「今天装完、明天来查」就已经滚没了。现在留 8 代（约 32 MB、约 58 小时）：仍够不上审计轨
 * 的 30 天，但覆盖得住「一次发版验证 + 隔天回看」这段最常被追问的窗口。
 *
 * Windows 上 `renameSync` 不能覆盖已存在的目标，所以先删旧目标再改名 ——
 * 旧实现第二次轮转必然失败，这条是修复而不是新规格。
 */
import fs from "node:fs";

/**
 * 滚动规格。三个数字都是判据：改它们等于改「日志留多久」。
 *
 * - `maxBytes`：单文件上限，超过就滚成 `.1`
 * - `generations`：保留几代（1 = 只留 `.1`）
 * - `checkEvery`：每写这么多次才 stat 一次，避免每条日志都付出一次系统调用
 */
export const LOG_ROLLING = Object.freeze({
  maxBytes: 4 << 20,
  generations: 8,
  checkEvery: 128,
});

/**
 * 这次写入要不要检查文件大小。
 *
 * @param {number} writeCount 本次是第几次写（从 1 起）
 * @param {{checkEvery:number}} [spec]
 */
export function shouldCheckSize(writeCount, spec = LOG_ROLLING) {
  return Number.isInteger(writeCount) && spec.checkEvery > 0 && writeCount % spec.checkEvery === 0;
}

/**
 * 文件超限就滚一代。返回是否真的滚了。
 *
 * 永不抛错：滚动是维护动作，写日志是取证动作，前者失败不许把后者带走。
 *
 * @param {string} file 日志文件路径
 * @param {{maxBytes:number, generations:number}} [spec]
 * @returns {boolean}
 */
export function rotateIfNeeded(file, spec = LOG_ROLLING) {
  try {
    if (fs.statSync(file).size <= spec.maxBytes) return false;
  } catch {
    return false;
  }
  try {
    for (let gen = spec.generations; gen >= 1; gen -= 1) {
      const target = `${file}.${gen}`;
      const source = gen === 1 ? file : `${file}.${gen - 1}`;
      // 目标已存在时 rename 在 Windows 上会失败：先删再改名。
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // 删不掉就让它失败，下次写入再试。
      }
      try {
        fs.renameSync(source, target);
      } catch (e) {
        // 高代数还没生成过是常态（第一次滚动时 `.1`–`.7` 都不存在）：
        // 早先这里让 ENOENT 冒到外层 catch，于是 `generations > 1` 的规格一次都滚不动，
        // 表现出来就是「行为：两个写入器都在同一阈值上滚动」这条用例红。
        if (gen > 1 && e && e.code === "ENOENT") continue;
        throw e;
      }
    }
    return true;
  } catch {
    return false;
  }
}
