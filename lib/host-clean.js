/**
 * lib/host-clean.js — 重启前确认提示词标记真写进了宿主，没写上就拦住重启。
 * 重启前看系统提示词文件：标记写上了，或者当前原文里已经没有那两处旧拦截。
 *
 * marker 文本必须与补丁表当前的产出**同源**：补丁 40 现在写的是
 * `fold-complete inject first`，而这里曾长期只认 `complete prompt keeps inject`，
 * 于是「补丁打上了、判定却说没写进宿主」—— panel 与 CLI 都会因此拒绝重启。
 * 新旧文本都收，既兼容已洗过的旧机器，也不给未来改名挖坑。
 */
export function hostPromptKeepsInject(text) {
  const body = String(text || "");
  const identityMarked = body.includes("[dsh-purge] identity stripped");
  const injectMarked = body.includes("[dsh-purge] fold-complete inject first")
    || body.includes("[dsh-purge] complete prompt keeps waterfall inject")
    || body.includes("[dsh-purge] complete prompt keeps inject")
    || body.includes("[dsh-purge] inject last after closer");
  if (identityMarked && injectMarked) return true;
  // 空文件或不是这份模块，不能当成已经洗过。
  if (!body.includes("system-prompt/assemble")) return false;
  const identityLeft = body.includes("You are an AI agent powered by DeepSeek Harness.");
  const dropsInject = body.includes("transformed.sections : [completeSection]");
  return !identityLeft && !dropsInject;
}
