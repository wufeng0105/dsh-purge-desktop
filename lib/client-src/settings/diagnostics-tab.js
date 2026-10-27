/**
lib/client-src/settings/diagnostics-tab.js — 诊断页签：审计轨、健康与三条日志轨，全是只读。

## 为什么这两块合成一个页签

它们回答同一个问题：**这台机器的副本还对不对、过去发生了什么**。健康说现在的文件与
记录一不一致，审计说每一轮补丁判定留下了什么证据，三条日志轨说这些证据落到哪。分成两屏
只会让人来回切：看到不一致的第一反应就是去翻那一轮的审计。

## 数据只从服务端取，页面不再算一遍

审计走既有 `GET /dsh-purge/audit` 的三种查询（`?tail=20` / `?run=<runId>` / `?check`），
不新增任何写路径；健康与日志走 `GET /dsh-purge/health`；预设注册读共享快照的状态块。
四项计数与「一致 / 不一致」都由服务端一次算好 —— 同一个漂移数在页面上再数一遍，
就会与服务端漂出两种口径，而外面看不出来。

三条读取各走 `useAsyncResource` 的同一套五态：挂载时取一次，失败给一句失败 + 重试，
空态给下一步该做什么。不再是每块自己一套 `busy` / `notice` —— 那是「这次点击的结果」，
与「这一块的数据」不是一件事。查某一轮仍然是按钮触发的动作，所以它的 `busy` 留着。

## 判据口径那一行

`raw`（按补丁号）只在诊断页出现：它回答「这一次判定是按几个补丁号算的」。摘要与补丁页
数的是 `display`（展示行），两个分母同时上屏却不标名，读者只会以为其中一个错了。

## 版式取舍

沿用整页唯一的两种形态：分节标题 + 发丝线行。审计是「回看」，回看要能和补丁页签对得上
眼，所以结果就地展开、不弹窗；失败卡按绝对路径逐行列出 —— 那是人要去打开的落盘物，省略
路径等于让人再猜一次它在哪。空态给的是**下一步**而不是「无数据」：这台机器没跑过应用
时，审计轨本来就没有行。

本文件不是 ES 模块，正文逐字节内联进 client.js。
*/

		/** 最近 N 条事件：`ok: false` 是服务端说「读不到」，按失败处理而不是空态。 */
		function fetchAuditTail() {
			return apiJson("/dsh-purge/audit?tail=20").then((d) => {
				if (!d || !d.ok) throw new Error(String((d && d.error) || "bad response"));
				return d;
			});
		}

		/**
		 * 完整性对账。
		 *
		 * 取不到不是错：审计目录还不存在时端点会失败，那只是「还没有可判的对象」。
		 * 所以这里吞掉失败并返回 null，由文案说「还没有可判的审计文件」。
		 */
		function fetchAuditCheck() {
			return apiJson("/dsh-purge/audit?check").catch(() => null);
		}

		/** 健康与三条日志轨：一次 `GET` 拿全，失败要能看见（它与审计的「没有对象」不同）。 */
		function fetchHealth() {
			return apiJson("/dsh-purge/health").then((d) => {
				if (!d || !d.ok) throw new Error(String((d && d.error) || "bad response"));
				return d;
			});
		}

		function AuditSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const state = props.state || null;
			const [runId, setRunId] = useState("");
			const [runResult, setRunResult] = useState(null);
			const [runBusy, setRunBusy] = useState(false);

			const tail = useAsyncResource(fetchAuditTail, {
				emptyOf: (d) => !d || !Array.isArray(d.events) || d.events.length === 0,
			});
			const checkRes = useAsyncResource(fetchAuditCheck);
			const events = tail.phase === "ready" && tail.data && Array.isArray(tail.data.events) ? tail.data.events : null;
			const check = checkRes.phase === "ready" ? checkRes.data : null;

			const runWhy = () => {
				const wanted = String(runId || "").trim();
				if (!wanted) return;
				setRunBusy(true);
				setRunResult(null);
				apiJson("/dsh-purge/audit?run=" + encodeURIComponent(wanted))
					.then((d) => setRunResult(d && typeof d === "object" ? d : { ok: false, error: "bad response" }))
					.catch((e) => setRunResult({ ok: false, error: String((e && e.message) || e) }))
					.finally(() => setRunBusy(false));
			};

			const auditOf = state && state.audit ? state.audit : null;
			const lastRun = auditOf && auditOf.appliedRunId ? auditOf.appliedRunId : "";
			const layerNames = auditOf && auditOf.layers ? Object.keys(auditOf.layers) : [];
			const layerText = layerNames.length === 0
				? "—"
				: layerNames.map((name) => name + ":" + String((auditOf.layers[name] && auditOf.layers[name].result) || "?")).join(" · ");

			/* `?check` 的三种回包：取到且通过 / 取到但有判据不过 / 取不到（目录还不存在时端点是 5xx）。
			   第三种只是「还没有可判的对象」，不是错——别把「没跑过」渲染成「坏了」。 */
			const checkText = !check
				? t("audit.check.unavailable")
				: check.ok
					? t("audit.check.ok", { files: String(Array.isArray(check.files) ? check.files.length : 0) })
					: t("audit.check.bad", { gaps: String(check.gaps || 0), badLines: String(check.badLines || 0) });

			const runBlock = (() => {
				if (!runResult) return null;
				if (runResult.ok === false && runResult.found !== false) {
					return h(Note, { notice: { kind: "error", text: t("audit.err", { error: String(runResult.error || "") }) } });
				}
				if (runResult.found === false) {
					return h(Empty, { text: t("audit.run.missing", { runId: String(runResult.runId || runId) }) });
				}
				const auditRows = Array.isArray(runResult.audit) ? runResult.audit.length : 0;
				const diagRows = runResult.diag && typeof runResult.diag.rows === "number" ? runResult.diag.rows : 0;
				const cards = Array.isArray(runResult.cards) ? runResult.cards : [];
				const cross = runResult.cross || null;
				return h("div", { className: "dshp-disc__body" },
					h(Row, { label: t("audit.run.rows"), value: t("audit.run.counts", { audit: String(auditRows), diag: String(diagRows) }) }),
					h(Row, {
						label: t("audit.run.cross"),
						value: cross && cross.comparable
							? t("audit.run.cross.value", { matched: String(cross.matched || 0), checked: String(cross.checked || 0) })
							: t("audit.run.cross.none"),
					}),
					h(Row, { label: t("audit.cards"), value: cards.length === 0 ? t("audit.cards.none") : String(cards.length) }),
					cards.map((card) => h("p", { className: "dshp-cwd-sub", key: card }, String(card))),
				);
			})();

			return h(Section, {
				title: t("section.audit"),
				count: lastRun ? lastRun : null,
				hint: t("audit.hint"),
			},
				h(Row, { label: t("audit.lastRun"), value: lastRun || t("audit.lastRun.none") }),
				h(Row, { label: t("audit.events"), value: auditOf && auditOf.recorded ? String(auditOf.events || 0) : "—" }),
				h(Row, { label: t("audit.layers"), value: layerText }),
				h(Row, { label: t("audit.check"), value: checkText }),
				h(Row, {
					label: t("audit.files"),
					value: auditOf && auditOf.dir ? String(auditOf.dir) : "—",
				}),
				/* 判据口径：这一行数的是补丁号（raw），与摘要 / 补丁页的展示行不是一个分母。 */
				h(Row, {
					label: t("counts.denominator.raw.label"),
					value: t("counts.denominator.raw", { na: String(settingsInt(state && state.patches_na)) }),
				}),
				h("div", { className: "dshp-actions", style: { justifyContent: "flex-start" } },
					h("input", {
						className: "dshp-input",
						style: { maxWidth: 320 },
						placeholder: t("audit.run.ph"),
						value: runId,
						onChange: (e) => setRunId(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") runWhy(); },
					}),
					h(ActionButton, { tiny: true, disabled: runBusy || String(runId).trim() === "", onClick: runWhy }, t("audit.run.btn")),
					h(ActionButton, {
						tiny: true,
						disabled: runBusy,
						onClick: () => { tail.retry(); checkRes.retry(); },
					}, t("audit.refresh")),
				),
				runBlock,
				events === null
					? h(AsyncBlock, {
						t: t,
						resource: tail,
						height: SKEL_SM,
						empty: h(Empty, { text: t("audit.tail.empty"), hint: t("audit.tail.empty.hint") }),
						errorKey: "audit",
					})
					: h("div", { className: "dshp-list", style: { marginTop: 6 } },
						events.map((row, index) => h("div", { className: "dshp-list__item", key: String((row && row.recordId) || index) },
							h("div", { className: "dshp-list__head" },
								h("span", { className: "dshp-list__name" }, String((row && row.event) || "—")),
								h("span", { className: "dshp-list__meta" },
									[String((row && row.layer) || ""), String((row && row.result) || ""), String((row && row.ts) || "")]
										.filter((part) => part !== "").join(" · ")),
							),
						)),
					),
			);
		}

		function HealthSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const state = props.state || null;
			const healthRes = useAsyncResource(fetchHealth);
			const health = healthRes.phase === "ready" ? healthRes.data : null;

			const preset = (state && state.preset) || null;
			const install = health && health.install ? health.install : null;
			const presetCopy = health && health.presetCopy ? health.presetCopy : null;
			const logs = health && health.logs ? health.logs : null;

			const driftValue = (() => {
				if (!health) return null;
				if (!install || install.recorded !== true) return t("health.install.missing");
				return t("health.install.counts", {
					drifted: String(install.drifted || 0),
					missing: String(install.missing || 0),
					added: String(install.added || 0),
				});
			})();

			/* 「没有记录」既不是一致也不是不一致：那是不可判，用 idle 点，别拿红点冒充问题。 */
			const copyTone = !install || install.recorded !== true ? "idle" : install.consistent === true ? "ok" : "bad";
			const copyValue = !health || !install
				? null
				: install.recorded !== true
					? t("health.copy.unknown")
					: install.consistent === true
						? t("health.copy.same")
						: t("health.copy.diff", { n: String((install.drifted || 0) + (install.missing || 0) + (install.added || 0)) });

			/* 预设那行有两个事实：注册走到哪一步（共享快照的预设块）、仓库与已装副本一不一样
			   （health 的 presetCopy 组）。后者没读到时只印前者 —— 拿「没读到」冒充「一致」，
			   和拿「没有记录」冒充「一致」是同一种谎。
			   注册状态本身走 `settingsPresetWord`：`phase` / `broken` 是内部取值，上屏要说人话
			   （判据见 `test/settings-plain-words.test.mjs`）。 */
			const driftNote = !presetCopy || presetCopy.present !== true
				? ""
				: presetCopy.consistent === true
					? " · " + t("health.copy.same")
					: " · " + t("health.copy.diff", { n: String(presetCopy.drifted || 0) });
			const presetWord = settingsPresetWord(preset || {});
			const presetValue = h(react.Fragment, null,
				h(StatusDot, { tone: presetWord.tone }),
				h("span", null, " " + t(presetWord.key, presetWord.params) + driftNote),
			);

			const trackRow = (label, track, rule) => {
				if (!track) return h(Row, { label: label, value: "—" });
				const tail = track.present ? rule : t("logs.absent");
				return h(Row, { label: label, value: String(track.path || "—") + " · " + tail });
			};

			const rollRule = (track) => {
				if (!track) return "—";
				return t("logs.rule.roll", {
					generations: String(track.generations || 0),
					size: formatSize(track.maxBytes || 0),
				});
			};

			/* 两块共用一次取数与一处失败：一个读不到的健康端点，不该在页面上裂成两个失败。 */
			return h(AsyncBlock, { t: t, resource: healthRes, height: SKEL_LG, errorKey: "audit" },
				h(react.Fragment, null,
					h(Section, { title: t("section.health"), hint: t("health.hint") },
						driftValue === null
							? null
							: h(Row, {
								label: t("health.install"),
								value: h(react.Fragment, null,
									h(StatusDot, { tone: install && install.recorded === true && (install.drifted || install.missing || install.added) === 0 ? "ok" : "idle" }),
									h("span", null, " " + driftValue),
								),
							}),
						driftValue === null ? null : h(Row, {
							label: t("health.copy"),
							value: copyValue === null
								? "—"
								: h(react.Fragment, null, h(StatusDot, { tone: copyTone }), h("span", null, " " + copyValue)),
						}),
						h(Row, { label: t("health.preset"), value: presetValue }),
					),
					h(Section, { title: t("section.logs"), hint: t("logs.hint") },
						!logs
							? null
							: h(react.Fragment, null,
								trackRow(t("logs.track.audit"), logs.audit, t("logs.rule.daily")),
								trackRow(t("logs.track.diag"), logs.diag, rollRule(logs.diag)),
								trackRow(t("logs.track.internal"), logs.internal, rollRule(logs.internal)),
							),
					),
				),
			);
		}

		/**
		 * 诊断页签的容器：先把共享快照的五态摆在最外层，两块再各自取自己的只读端点。
		 *
		 * 两块都依赖共享快照（预设注册、判据口径），所以快照没读到时它们不挂载 —— 也就
		 * 不会带着「空」去各取一遍。
		 */
		function DiagnosticsPanel(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const resource = props.resource || null;
			const state = resource && resource.data ? resource.data : null;
			return h(AsyncBlock, { t: t, resource: resource, height: SKEL_MD },
				h(react.Fragment, null,
					h(AuditSection, { t: t, state: state }),
					h(HealthSection, { t: t, state: state }),
				),
			);
		}
