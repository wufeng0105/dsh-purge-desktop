/**
lib/client-src/settings/status-tab.js — 状态页签：摘要那一行、结论句、三句人话与「重启宿主」。

## 这一页回答什么

「现在正不正常」。五组数（已生效 / 待应用 / 按设计跳过 / 不适用 / 失败）由服务端算好，
页面只画；结论句把它们折成一句话；命令入口、原始文件备份与预设注册三处内部取值各走
一个纯函数折成人话；需要重载时给一个「重启宿主」。

## 为什么从 page.js 搬出来

状态页签原先就地画在页面组件里，数据也从页面组件自己的 `useState` 拿。搬出来之后
页面只剩壳（页头、页签栏、五块面板挂载、页脚），状态页签从 `usePurgeStatus()` 给的
同一份快照读 —— 取数只有一条路，画法只有一个落点。

三个人话函数跟着一起搬：它们与「状态页签上那三行」是同一件事，留在页面里只会让
「这一行怎么写」跨两个文件找。

## 计数只在服务端算

四种数（外加失败）全部读顶层字段，客户端不遍历状态表、不合并分组。失败数尤其如此：
读契约给的 `patches_failed`，别再自己数一遍 `unmatched`。

## 两个分母要标名

摘要这一行是 `display` 口径（按展示行），行数与补丁页读到的是同一个端点字段；
`raw` 口径（按补丁号）只在诊断页的「判据口径」那一行出现。只报数字不带口径，
就是让读者自己去猜两个数为什么不一样。

## 工程字段不直接上屏

`shim cmd:binary · ps1:missing …`、`备份 有`、预设的 `phase` / `broken` 原先都是把
内部取值印给用户看。现在三处各走一个纯函数（`settingsShimWord` / `settingsBackupWord` /
`settingsPresetWord`）：中文名 + 状态点 + 一句人话。判据在
`test/settings-plain-words.test.mjs`（裸标识符命中即红）。

## 两个曾经被误读的字段（逐条实测确认）

- **`patches_lost` 不是「失败」**：判据是「asar 仍密封，或宿主标记不在」。桌面端开着
  asar 也会为真，拿它当失败会让正常装机常驻一条「1 条失败」。
- **`patches_skipped` 不是「待写入」**：跳过是「按设计不适用」（`missing_file` / `off`），
  待写入是 `patches_pending`。把 skipped 渲染成「待写入 N」与事实相反。

本文件不是 ES 模块，正文逐字节内联进 client.js。
*/

		/** 取一个整数字段；缺省与脏值都按 0 —— 页面不替服务端猜。 */
		function settingsInt(value) {
			const n = Number(value);
			return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
		}

		/**
		 * 四种数（外加失败）：键给文案、数给模板。
		 *
		 * 「不适用」单列是因为它本来就从界面的分节里被过滤掉了（展示行不返回 `na` 行），
		 * 不给它一个数，用户就只会看到「62」而不知道剩下几条去哪了。
		 */
		function settingsCountItems(s) {
			const state = s || {};
			const items = [
				{ key: "counts.applied", n: settingsInt(state.patches_applied) },
				{ key: "counts.pending", n: settingsInt(state.patches_pending) },
				{ key: "counts.skipped", n: settingsInt(state.patches_skipped) },
				{ key: "counts.na", n: settingsInt(state.patches_na) },
			];
			const failed = settingsInt(state.patches_failed);
			if (failed > 0) items.push({ key: "counts.failed", n: failed });
			return items;
		}

		/**
		 * 结论句：返回 `{ key, params }`，不返回成品字符串。
		 *
		 * 为什么不让它自己拼句子：文案要两份词典、要能在用例里逐分支断言。返回键与参数
		 * 之后，「pending 存在时不许说全部生效」可以在不渲染的前提下判 —— 那就是
		 * `test/settings-conclusion.test.mjs` 的判据。
		 */
		function settingsConclusion(s) {
			const state = s || {};
			const applied = settingsInt(state.patches_applied);
			const pending = settingsInt(state.patches_pending);
			const skipped = settingsInt(state.patches_skipped);
			const na = settingsInt(state.patches_na);
			const failed = settingsInt(state.patches_failed);
			const rest = {
				applied: String(applied),
				pending: String(pending),
				skipped: String(skipped),
				na: String(na),
			};
			// 次序即口径：失败 > 待应用 > 待重启 > 全部生效。前三条都不成立时才可能是「全部生效」。
			if (failed > 0) return { key: "conclusion.failed", params: { ...rest, failed: String(failed) } };
			if (pending > 0) return { key: "conclusion.pending", params: rest };
			if (state.boot_full_quit) return { key: "conclusion.restart", params: rest };
			return { key: "conclusion.ok", params: rest };
		}

		/**
		 * 页头那一处状态词：只说状态词、不报数。
		 *
		 * 数字在摘要那一行出现一次，别处不再复述 —— 同一组数字说三遍的后果不是啰嗦，
		 * 是任何一处漏改都会让三处互相矛盾，而用户无从判断该信哪个。
		 *
		 * @returns {{tone:string, key:string, needsRestart:boolean}}
		 */
		function settingsHeadStatus(s) {
			const state = s || {};
			const pending = settingsInt(state.patches_pending);
			const failed = settingsInt(state.patches_failed);
			const needsRestart = Boolean(state.boot_full_quit);
			const tone = failed > 0 ? "bad" : (needsRestart || pending > 0 ? "idle" : "ok");
			const key = failed > 0
				? "status.partial"
				: pending > 0
					? "status.waiting"
					: needsRestart ? "status.needRestart" : "status.active";
			return { tone: tone, key: key, needsRestart: needsRestart };
		}

		/**
		 * 命令入口（`shim_*` 三项）折算成人话。
		 *
		 * 取值域来自 `core.shimFileStatus`：`patched` / `original` / `missing` / `binary`。
		 * 用户不需要知道是哪三个文件、也不需要看见这些词 —— 他只需要知道「dsh 命令
		 * 现在是谁在管」。
		 *
		 * 这里的计数是**三个固定字段**（cmd / ps1 / bin），不是服务端给的集合：端点没有
		 * 「几个已接管」这个字段，而这句人话必须说出个数。所以按字段逐个判，不写
		 * `filter(...).length` —— 那种写法在页面上一旦成为习惯，补丁计数也会这么长回来。
		 */
		function settingsShimWord(s) {
			const state = s || {};
			const values = [state.shim_cmd, state.shim_ps1, state.shim_bin];
			let patched = 0;
			let present = 0;
			for (const value of values) {
				if (value === "patched") patched += 1;
				if (typeof value === "string" && value !== "" && value !== "missing") present += 1;
			}
			if (patched > 0) {
				return { tone: "ok", key: "plain.shim.patched", params: { patched: String(patched), present: String(present) } };
			}
			if (present > 0) return { tone: "idle", key: "plain.shim.original", params: { present: String(present) } };
			return { tone: "idle", key: "plain.shim.none", params: {} };
		}

		/** 原始文件备份：有 / 没有，各自一句人话。没有备份不是错误，只是「这一版还没动过」。 */
		function settingsBackupWord(s) {
			const state = s || {};
			return state.has_backup
				? { tone: "ok", key: "plain.backup.yes", params: {} }
				: { tone: "idle", key: "plain.backup.no", params: {} };
		}

		/**
		 * 预设注册状态折算成人话。
		 *
		 * `phase` 的取值域来自 `lib/redteam/index.js`（apply-start / registering /
		 * registered / registered-broken / register-failed / read-failed /
		 * waiting-registry / timeout-waiting-registry）。原来页面直接把 `phase` 与
		 * `broken` 拼上屏，用户看到的是 `registered-broken · tool-subagent: …`。
		 */
		function settingsPresetWord(preset) {
			const p = preset || {};
			const phase = typeof p.phase === "string" ? p.phase : "";
			const broken = typeof p.broken === "string" ? p.broken : "";
			const detail = broken ? { broken: broken } : {};
			if (phase === "registered") return { tone: "ok", key: "plain.preset.registered", params: detail };
			if (phase === "registered-broken") return { tone: "idle", key: "plain.preset.broken", params: detail };
			if (phase === "registering" || phase === "waiting-registry") {
				return { tone: "idle", key: "plain.preset.running", params: detail };
			}
			if (phase === "apply-start" || phase === "register-failed" || phase === "read-failed") {
				return { tone: "error", key: "plain.preset.failed", params: detail };
			}
			if (phase === "timeout-waiting-registry") {
				return { tone: "idle", key: "plain.preset.timeout", params: detail };
			}
			return { tone: "idle", key: "plain.preset.none", params: detail };
		}

		/**
		 * 状态页签的内容：数据来自 `usePurgeStatus()` 的那一份快照，自己不取数。
		 *
		 * 五态外壳（骨架 / 失败 + 重试 / 空态）由 `AsyncBlock` 一次画好；这里只给内容。
		 */
		function StatusPanel(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const resource = props.resource || null;
			const s = resource && resource.data ? resource.data : {};
			const head = settingsHeadStatus(s);
			const counts = settingsCountItems(s);
			const conclusionSpec = settingsConclusion(s);
			const shimWord = settingsShimWord(s);
			const backupWord = settingsBackupWord(s);
			const total = settingsInt(s.patches_total);
			const na = settingsInt(s.patches_na);

			return h(AsyncBlock, { t: t, resource: resource, height: SKEL_MD },
				h("div", { className: "dshp-summary" },
					h("div", { className: "dshp-summary__counts" },
						counts.map((item) => h("span", { className: "dshp-count", key: item.key },
							h("span", { className: "dshp-count__label" }, t(item.key)),
							h("span", { className: "dshp-count__value" }, String(item.n)),
						)),
					),
					h("p", { className: "dshp-conclusion" }, t(conclusionSpec.key, conclusionSpec.params)),
					/* 分母标名：这一行数的是展示行，不是补丁号。 */
					h("p", { className: "dshp-hint" }, t("counts.denominator.display", { n: String(total) })),
					h(Row, {
						label: t("plain.shim.label"),
						value: h(react.Fragment, null,
							h(StatusDot, { tone: shimWord.tone }),
							h("span", null, " " + t(shimWord.key, shimWord.params)),
						),
					}),
					h(Row, {
						label: t("plain.backup.label"),
						value: h(react.Fragment, null,
							h(StatusDot, { tone: backupWord.tone }),
							h("span", null, " " + t(backupWord.key, backupWord.params)),
						),
					}),
					na > 0
						? h("p", { className: "dshp-hint" }, t("counts.na.hint", { n: String(na) }))
						: null,
					head.needsRestart
						? h("div", { className: "dshp-actions", style: { justifyContent: "flex-start" } },
							h(ActionButton, {
								primary: true,
								onClick: () => restartDsh(() => {}, () => {}, t, s.surface),
							}, t("head.restart")),
						)
						: null,
				),
			);
		}
