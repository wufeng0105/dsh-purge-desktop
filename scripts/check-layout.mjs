#!/usr/bin/env node
/**
 * scripts/check-layout.mjs — 目录职责、命名与文档索引的判定器。
 *
 * 为什么存在：目录职责、命名约定、文档索引完备性这三件事原先散在 AGENTS.md 与
 * docs/文档索引.md 的正文里，只能靠人记得。判据一旦写成表，就能按表逐条对照 ——
 * 这个脚本读 docs/布局约定.md 的四张表，把「文档说了什么」变成「命令能判什么」。
 *
 * 判据一：目录职责表。每张表行给出「目录 + 允许的文件名模式」，表外的文件报红。
 *   模式里没有斜杠的按任意深度匹配（`*.js` 覆盖该目录下所有层级），这是为了让
 *   表的行数等于目录数，而不是等于每个子目录一行。
 * 判据二：禁止的后缀与名字（`.bak` / `.old` / `.copy` / `-2` 结尾 / `tmp-` `tmp_` 开头 / `.tgz`）。
 * 判据三：同类文件同前缀同目录（`check-*` 在 scripts、`patch-*` 在 lib/patch、`policy-*` 在设置页片段）。
 * 判据四：索引完备。docs 下每个 `.md` 在 docs/文档索引.md 的表格里出现恰好一次且带一句话；
 *   登记了但文件不存在，或者出现两次，都报红。
 *
 * 用法：node scripts/check-layout.mjs
 * 退出码：0 全过 / 1 有命中 / 2 环境错误（读不到布局约定或文档索引）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldSkipDir } from "./lib-skip-dirs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT_DOC = join(ROOT, "docs", "布局约定.md");
const INDEX_DOC = join(ROOT, "docs", "文档索引.md");

const EXIT_OK = 0;
const EXIT_HIT = 1;
const EXIT_TOOLING = 2;

const log = (msg) => process.stdout.write(`${msg}\n`);
const fail = (msg) => {
	process.stderr.write(`[check-layout] 无法完成检查：${msg}\n`);
	process.exit(EXIT_TOOLING);
};

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			// 跳过口径与其它扫树门禁共用一份：依赖树、版本库、工具自管状态、草稿区都不算仓库布局。
			if (shouldSkipDir(entry.name)) continue;
			walk(join(dir, entry.name), out);
		} else if (entry.isFile()) {
			out.push(relative(ROOT, join(dir, entry.name)).split(sep).join("/"));
		}
	}
	return out;
}

function tableRows(sectionText) {
	const rows = [];
	for (const line of sectionText.split("\n")) {
		if (!line.trimStart().startsWith("|")) continue;
		const cells = line.split("|").slice(1, -1).map((c) => c.trim());
		if (cells.every((c) => /^:?-{2,}:?$/.test(c))) {
			// 分隔行紧跟的那一行是表头，表头不是数据行。
			rows.pop();
			continue;
		}
		if (cells.length >= 2) rows.push(cells);
	}
	return rows;
}

function sections(text) {
	const map = new Map();
	let key = "";
	for (const line of text.split("\n")) {
		const m = line.match(/^#{2,4}\s+(.+)$/);
		if (m) {
			key = m[1].trim();
			map.set(key, []);
		} else if (key) map.get(key).push(line);
	}
	return new Map([...map].map(([k, v]) => [k, v.join("\n")]));
}

function patternToRegex(pattern) {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const source = escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
	// 无斜杠的模式按任意深度匹配：表的一行对应一个目录，不是一层。
	if (!pattern.includes("/")) return new RegExp(`(^|/)${source}$`);
	return new RegExp(`^${source}$`);
}

function readLayout() {
	if (!existsSync(LAYOUT_DOC)) fail(`找不到 ${relative(ROOT, LAYOUT_DOC)}`);
	const text = readFileSync(LAYOUT_DOC, "utf8");
	const parts = sections(text);
	const find = (fragment) => {
		for (const [title, body] of parts) if (title.includes(fragment)) return body;
		return null;
	};
	const dirsSection = find("目录职责");
	const forbidSection = find("禁止的后缀");
	const prefixSection = find("同前缀同目录");
	const missing = [dirsSection, forbidSection, prefixSection].filter((s) => s === null);
	if (missing.length > 0) fail("布局约定缺表：目录职责 / 禁止的后缀与名字 / 同前缀同目录 三张表都要在");

	const dirs = tableRows(dirsSection).map((cells) => ({
		dir: cells[0].replace(/`/g, "").trim(),
		patterns: [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]),
	}));
	if (dirs.some((d) => d.patterns.length === 0)) fail("目录职责表有行没写允许的文件名模式");

	const forbid = tableRows(forbidSection).map((cells) => cells[0].replace(/`/g, "").trim());
	const prefixes = tableRows(prefixSection).map((cells) => ({
		prefix: cells[0].replace(/`/g, "").trim(),
		dir: cells[1].replace(/`/g, "").trim(),
	}));
	return { dirs, forbid, prefixes };
}

function inDir(file, dir) {
	return dir === "." ? !file.includes("/") : file.startsWith(`${dir}/`);
}

function checkDirs(files, dirs) {
	const hits = [];
	const sorted = [...dirs].sort((a, b) => b.dir.length - a.dir.length);
	for (const file of files) {
		const owners = sorted.filter((d) => inDir(file, d.dir));
		if (owners.length === 0) continue;
		const ok = owners.some((owner) => {
			const rel = owner.dir === "." ? file : file.slice(owner.dir.length + 1);
			return owner.patterns.some((p) => patternToRegex(p).test(rel));
		});
		if (!ok) hits.push(`${file}  不匹配 ${owners.map((o) => `${o.dir}（${o.patterns.join(" ")}）`).join(" 或 ")}`);
	}
	return hits;
}

/** `-2` 只针对代码与数据文件：素材图有自己的语义名，不按副本编号规则管。 */
const COPY_SUFFIX_EXTS = [".js", ".mjs", ".json", ".txt", ".yml", ".yaml", ".md"];

function checkNames(files, forbid) {
	const hits = [];
	for (const file of files) {
		const base = file.slice(file.lastIndexOf("/") + 1);
		for (const rule of forbid) {
			if (rule.endsWith("*")) {
				if (base.startsWith(rule.slice(0, -1))) hits.push(`${file}  名字以 ${rule.slice(0, -1)} 开头`);
				continue;
			}
			if (rule.startsWith("*")) {
				if (base.endsWith(rule.slice(1))) hits.push(`${file}  后缀 ${rule.slice(1)} 是禁止的`);
				continue;
			}
			if (rule.startsWith(".")) {
				if (file.endsWith(rule)) hits.push(`${file}  后缀 ${rule} 是禁止的`);
				continue;
			}
			if (rule === "-2") {
				if (!COPY_SUFFIX_EXTS.some((e) => base.endsWith(e))) continue;
				if (new RegExp("-2(\\.[^./]+)$").test(base)) hits.push(`${file}  文件名以 -2 结尾`);
				continue;
			}
			// 带通配符的按前缀 / 后缀匹配；不带通配符的按**完整文件名**精确匹配 ——
			// 否则 `utils.js` 这一条会把 `lib/redteam/ip-utils.js` 一起判红。
			if (base === rule) hits.push(`${file}  这是禁用文件名（不说明职责）`);
		}
	}
	return hits;
}

/** 前缀规则只作用于 lib（不含被文本装配的片段）与 scripts：test/ 与 rules/ 各有自己的命名约定。 */
function prefixScope(file) {
	if (file.startsWith("scripts/")) return true;
	return file.startsWith("lib/") && !file.startsWith("lib/client-src/");
}

function checkPrefixes(files, prefixes) {
	const hits = [];
	for (const file of files) {
		if (!prefixScope(file)) continue;
		const base = file.slice(file.lastIndexOf("/") + 1);
		for (const rule of prefixes) {
			if (!base.startsWith(rule.prefix)) continue;
			if (!inDir(file, rule.dir)) hits.push(`${file}  ${rule.prefix} 开头的文件只许在 ${rule.dir}/`);
		}
	}
	return hits;
}

function checkTestExecutables(files) {
	return files
		.filter((f) => f.startsWith("test/") && !f.endsWith(".test.mjs"))
		.filter((f) => readFileSync(join(ROOT, f), "utf8").startsWith("#!"))
		.map((f) => `${f}  带 shebang 却不是 *.test.mjs`);
}

function checkIndex(files) {
	if (!existsSync(INDEX_DOC)) fail(`找不到 ${relative(ROOT, INDEX_DOC)}`);
	const rows = tableRows(readFileSync(INDEX_DOC, "utf8"));
	const counts = new Map();
	const sentences = new Map();
	for (const cells of rows) {
		const m = cells[0].match(/docs\/[^`|\]\s]+\.md/);
		if (!m) continue;
		const path = m[0];
		counts.set(path, (counts.get(path) ?? 0) + 1);
		const sentence = (cells[1] ?? "").replace(/`/g, "").trim();
		if (!sentences.has(path)) sentences.set(path, sentence);
	}
	const hits = [];
	const mds = files.filter((f) => f.startsWith("docs/") && f.endsWith(".md"));
	for (const md of mds) {
		const n = counts.get(md) ?? 0;
		if (n === 0) hits.push(`${md}  没在 docs/文档索引.md 里登记`);
		else if (n > 1) hits.push(`${md}  在索引里登记了 ${n} 次（只许一次）`);
		else {
			const sentence = sentences.get(md) ?? "";
			if (!sentence) hits.push(`${md}  索引条目没有一句话`);
			else if ([...sentence].length > 40) hits.push(`${md}  索引里的说明 ${[...sentence].length} 字，超过 40`);
		}
	}
	for (const path of counts.keys()) {
		if (!existsSync(join(ROOT, path))) hits.push(`${path}  登记在索引里，但文件不存在`);
	}
	return hits;
}

function main() {
	const { dirs, forbid, prefixes } = readLayout();
	const files = walk(ROOT);
	const groups = [
		["目录职责", checkDirs(files, dirs)],
		["禁用名", checkNames(files, forbid)],
		["同前缀同目录", checkPrefixes(files, prefixes)],
		["test 可执行文件", checkTestExecutables(files)],
		["文档索引", checkIndex(files)],
	];

	log(`[check-layout] 扫描 ${files.length} 个文件；目录表 ${dirs.length} 行、禁用名 ${forbid.length} 条、前缀 ${prefixes.length} 条`);
	let total = 0;
	for (const [label, hits] of groups) {
		total += hits.length;
		if (hits.length === 0) continue;
		log(`\n${label}：${hits.length} 条`);
		for (const hit of hits) log(`  ${hit}`);
	}
	if (total > 0) {
		log(`\n[check-layout] 失败：${total} 条。`);
		process.exit(EXIT_HIT);
	}
	log("[check-layout] OK：目录职责、命名、索引四项零命中");
	process.exit(EXIT_OK);
}

main();
