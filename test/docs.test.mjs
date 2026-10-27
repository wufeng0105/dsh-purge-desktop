/**
 * 文档门禁：锁住「手抄事实」的两类漂移。
 *
 * 判据来自 AGENTS.md 与 docs/文档索引.md：这一行会不会改变下一次动作？不会就删；能由工具算出来的交给断言。
 * 这里只锁**改了就会误导人**的几类东西：
 *   ① 版本号 —— README 徽章与 release-notes 首行必须与 package.json 同源，写错会让使用者按旧版本操作；
 *   ② 载体路径 —— docs/约束索引.md 每行第三列写着「谁在守这条约束」，测试改名/删除后必须同步；
 *   ③ 文档一句话 —— 「这份文档回答什么问题」只在标题下那一行，缺了就没人知道该打开哪一份；
 *   ④ 表格数字 —— AGENTS.md 的大文件行数与产物字节数，错了会让协作者用错读法（grep 满仓 vs 查符号）。
 *
 * 不锁行数、不锁文件数：那些数字不驱动任何动作，锁住它们等于给自己制造必须手工同步的副本。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const pkg = JSON.parse(read("package.json"));

/** 文档里出现的、以仓库真实顶层目录开头的路径引用。裸文件名（如 `shell.js`）无法无歧义解析，不在此列。 */
const REPO_PREFIX = /^(lib|test|scripts|docs|bin|rules|presets|skills|\.github)\//;

/** 有意指向「已删除 / 仓库外」的引用 —— 文档里就是在说明「这个东西不在了」，不是笔误。 */
const INTENTIONALLY_ABSENT = new Set([
	"lib/hostfs/",
	"lib/web.js",
	"lib/restart-web.js",
	"lib/uninstall-restart.js",
	"docs/preview/",
	"docs/notice/",
]);

test("AGENTS.md 不许出现目录规模数字（它会过时，且不驱动任何动作）", () => {
	// 判据来源：AGENTS.md 的「硬门禁」节 —— 行数、字节数、文件数一律不进文档，也不设断言；
	// 超 800 行交给 scripts/check-file-roles.mjs，产物是否漂移交给 CI 的 codegen drift。
	// 目录导航的「N 文件 / M 行」同样不产生动作 —— 知道 lib/prompt 是 422 行不会改变任何操作。
	// 这里守的是「别把这类数字抄回来」，不是它们的取值：一旦出现就红，因为它的归宿是脚本不是文档。
	const offenders = read("AGENTS.md")
		.split("\n")
		.filter((l) => /\d+\s*文件\s*\/\s*[\d,]+\s*行/.test(l)
			|| /共\s*\d+\s*个\s*`\.js`/.test(l)
			|| /^\|\s*`[^`]+\.js`[^|]*\|\s*[\d,]+\s*\|/.test(l)
			|| /`[\w./-]+\.(?:js|mjs)`（[\d,]+ B）/.test(l));
	assert.deepEqual(offenders, [], "AGENTS.md 又写了行数/字节数/目录规模数字，删掉它 —— "
		+ "那些交给 scripts/check-file-roles.mjs 与 CI 的 codegen drift，见 AGENTS.md「硬门禁」节");
});

test("release-notes 首行必须是 package.json 的版本（release.yml 的门禁同源）", () => {
	const first = read("release-notes.md").split("\n")[0].replace(/\r$/, "");
	assert.equal(first, `# ${pkg.version}`, `首行是 ${JSON.stringify(first)}，应为 "# ${pkg.version}"`);
});

test("README 两份的版本徽章等于 package.json version", () => {
	for (const f of ["README.md", "README.en.md"]) {
		// 为什么允许一个预发布后缀：轮次推进时版本号会写成 `1.2.2-m5` 这种形式，
		// 用来区分「同一台宿主上先后装的是哪一轮产物」。放宽的只有**后缀**这一段，
		// 三段数字的核心仍然必须在、且与 package.json 逐字相同 —— 放宽是为了让徽章
		// 跟得上版本，不是为了容忍把版本写错。
		const badge = read(f).match(/<strong>v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)<\/strong>/);
		assert.ok(badge, `${f} 里没找到版本徽章`);
		assert.equal(badge[1], pkg.version, `${f} 徽章写 v${badge[1]}，package.json 是 ${pkg.version}`);
	}
});

test("README 两份的 dsh 徽章等于 dshTarget", () => {
	for (const f of ["README.md", "README.en.md"]) {
		// shields 徽章把 prerelease 的点写成 --：dsh-0.2.1--rc.2
		const m = read(f).match(/badge\/dsh-(\d+\.\d+\.\d+(?:--rc\.\d+)?)-blue/);
		assert.ok(m, `${f} 里没找到 dsh 徽章`);
		assert.equal(m[1].replace("--", "-"), pkg.dshTarget, `${f} 徽章是 ${m[1]}，dshTarget 是 ${pkg.dshTarget}`);
	}
});

test("约束索引末尾的「各领域最大编号」等于表格里的实际最大值", () => {
	const text = read("docs/约束索引.md");
	const actual = new Map();
	for (const m of text.matchAll(/`([A-Z]+)-(\d+)`/g)) {
		actual.set(m[1], Math.max(actual.get(m[1]) ?? 0, Number(m[2])));
	}
	const claim = text.match(/当前各领域最大：([^）)]+)/);
	assert.ok(claim, "没找到「当前各领域最大：…」那行");

	const drift = [];
	for (const m of claim[1].matchAll(/([A-Z]+)-(\d+)/g)) {
		const [area, n] = [m[1], Number(m[2])];
		if (actual.get(area) !== n) drift.push(`${area}: 清单写 ${n}，表里最大 ${actual.get(area)}`);
	}
	assert.deepEqual(drift, [], `索引末尾编号清单漂了：\n  ${drift.join("\n  ")}`);
});

test("约束索引「载体」列指向的文件必须存在", () => {
	const text = read("docs/约束索引.md");
	const missing = [];
	for (const m of text.matchAll(/`([A-Za-z0-9_./@-]+\.(?:js|mjs|yml|yaml|json))`/g)) {
		const ref = m[1];
		if (!REPO_PREFIX.test(ref) || INTENTIONALLY_ABSENT.has(ref)) continue;
		if (!fs.existsSync(path.join(ROOT, ref))) missing.push(ref);
	}
	assert.deepEqual(missing, [], `约束索引的载体路径不存在：\n  ${[...new Set(missing)].join("\n  ")}`);
});

test("文档 INDEX（文档索引.md / AGENTS.md）互指的路径必须存在", () => {
	const missing = [];
	for (const f of ["docs/文档索引.md", "AGENTS.md"]) {
		for (const m of read(f).matchAll(/`([A-Za-z0-9_./@-]+\.(?:js|mjs|yml|yaml|json|md|html))`/g)) {
			const ref = m[1];
			if (!REPO_PREFIX.test(ref) || INTENTIONALLY_ABSENT.has(ref)) continue;
			if (!fs.existsSync(path.join(ROOT, ref))) missing.push(`${f} -> ${ref}`);
		}
	}
	assert.deepEqual(missing, [], `文档之间互指的路径不存在：\n  ${[...new Set(missing)].join("\n  ")}`);
});

/** docs 下全部 .md。 */
function docsMarkdown(dir = path.join(ROOT, "docs"), out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) docsMarkdown(abs, out);
		else if (entry.name.endsWith(".md")) out.push(abs);
	}
	return out;
}

test("每份 docs 下 .md 的标题之后三行内有「> 一句话：…」，且不超过 40 字", () => {
	// 为什么锁这一条：文档的目录、文件名都不告诉读者「这份文档回答什么问题」，
	// 于是没人知道该打开哪一份。一句话引注是唯一能在不读正文前就判断「要不要看」的东西。
	// 只锁「有没有、多少字」这类可判定的部分 —— 写得准不准是评审的活（见 docs/布局约定.md 第四节）。
	const offenders = [];
	for (const abs of docsMarkdown()) {
		const rel = path.relative(ROOT, abs).split(path.sep).join("/");
		const lines = fs.readFileSync(abs, "utf8").split("\n");
		const title = lines.findIndex((l) => /^#\s/.test(l));
		const window = title < 0 ? [] : lines.slice(title + 1, title + 4);
		const quote = window.find((l) => l.trim().startsWith("> 一句话："));
		if (!quote) {
			offenders.push(`${rel}  标题后三行内没有「> 一句话：…」`);
			continue;
		}
		const sentence = quote.trim().slice("> 一句话：".length).trim();
		if (!sentence) offenders.push(`${rel}  一句话是空的`);
		else if ([...sentence].length > 40) offenders.push(`${rel}  一句话 ${[...sentence].length} 字，超过 40`);
	}
	assert.deepEqual(offenders, [], `文档缺一句话或太长：\n  ${offenders.join("\n  ")}`);
});
