/**
 * lib/phase1-keep.js — 放宽官方 phase-1 的段过滤，否则本插件的段会被丢掉。
 */
export const PHASE1_KEEP_EXPR =
  'PERSONA_SECTION_NAMES.has(section?.name) || String(section?.name || "").startsWith("dsh-purge") || String(section?.name || "").startsWith("dshpg-")';

/**
 * phase-1 白名单放宽：把官方 phase-1 的段过滤从「只留 persona」放宽到
 * 「persona + dsh-purge* + dshpg-*」。
 *
 * 服务对象是**官方 dsh-agent-instructions 的 phase-1 白名单**，让本插件自己
 * 注册的 prompt section 在 phase-1 里不被丢掉。已放行 dsh-purge 的旧状态会升到
 * 带 dshpg- 的新形态。
 *
 * 与本机第三方插件无关 —— 文件名里的 "phase1" 指的是官方 phase-1 阶段，
 * 不是某个插件的内部阶段。
 */
export function widenPhase1KeepFilter(text) {
  const raw = String(text || "");
  const crlf = raw.includes("\r\n");
  let next = raw.replace(/\r\n/g, "\n");
  next = next.replace(
    /PERSONA_SECTION_NAMES\.has\(section\?\.name\) \|\| String\(section\?\.name \|\| ""\)\.startsWith\("dsh-purge"\)(?! \|\| String\(section\?\.name \|\| ""\)\.startsWith\("dshpg-"\))/g,
    PHASE1_KEEP_EXPR,
  );
  next = next.replace(
    /section => PERSONA_SECTION_NAMES\.has\(section\?\.name\)(?! \|\|)/g,
    `section => ${PHASE1_KEEP_EXPR}`,
  );
  return crlf ? next.replace(/\n/g, "\r\n") : next;
}
