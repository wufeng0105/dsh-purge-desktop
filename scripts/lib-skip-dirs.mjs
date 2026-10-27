#!/usr/bin/env node
/**
 * scripts/lib-skip-dirs.mjs — 扫树类门禁共用的目录跳过清单。
 *
 * 为什么存在：四个门禁各写一份跳过清单，「草稿区算不算仓库布局」这类问题要在四处
 * 分别回答；上一轮就真的漏了一处 —— `.scratch` 里的打包产物把 `check-layout` 判红，
 * 而那与本次改动毫无关系。
 *
 * 清单只有一份。加目录之前先回答「它属于下面哪一类」，答不上来说明它该被某个门禁
 * 判到，而不是被跳过去：
 *   · `node_modules`            依赖树，不是本仓库写的；
 *   · `.git`                    版本库本体；
 *   · `.codegraph` / `.ua`      工具自管的知识图状态（Understand-Anything 与 CodeGraph）；
 *   · `.scratch`                跨会话工程的草稿区，`git` 已忽略；整份拷上游文档与临时产物当审计对象。
 * 前缀清单管点开头的临时目录（`.tmp-*` / `.tmp_*`），它们是本地构建残留。
 */

/** 不进扫描的目录名。列表唯一权威就是这里，门禁脚本不许再各存一份。 */
export const SKIP_DIRS = new Set(["node_modules", ".git", ".codegraph", ".ua", ".scratch"]);

/** 不进扫描的目录名前缀（本地临时目录）。 */
export const SKIP_PREFIX = [".tmp-", ".tmp_"];

/**
 * 一个目录名该不该被跳过。
 *
 * @param {string} name 目录名（不是路径）
 * @param {{skipDirs?:Set<string>, skipPrefixes?:string[]}} [scope] 覆盖口径，只给用例换一份清单用
 * @returns {boolean} 跳过为 true
 */
export function shouldSkipDir(name, scope = {}) {
	const dirs = scope.skipDirs ?? SKIP_DIRS;
	const prefixes = scope.skipPrefixes ?? SKIP_PREFIX;
	return dirs.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
}
