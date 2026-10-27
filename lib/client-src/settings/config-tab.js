/**
lib/client-src/settings/config-tab.js — 配置页签：更新、注入、名单、Hooks 拦截、危险区。

## 为什么这五块合成一个页签

它们回答同一个问题：**这台机器上哪些开关能改**。早先它们分住两个文件（审批策略与
Hooks 拦截各一份），在长滚动里是两块；改成页签之后仍要并排读 —— 用户调完注入就会顺手
看 Hooks 拦不拦，中间隔一次页签切换只是把一件事拆成两屏。

## 为什么按「有没有后端」划分

重构前这些内容塞在同一个自带面板的容器里，还夹着一份自己算的补丁指标 —— 那份指标
与页面顶上的计数算法不同（一个数 `patches_applied`，一个数台账行数），同屏出现两个
「61 / 62」时会互相矛盾。现在补丁指标只留在状态页签，本文件只做真正会改状态的操作。

## 读与写是两套状态

四块的读取各走 `useAsyncResource` 的同一套五态（骨架 / 失败 + 重试 / 空态 / 内容）：
挂载时取一次，失败能看见、能重试。`busy` / `notice` 只留给人点下去之后的写入结果 ——
把两者混在一起，一次保存失败就会把已经取到的内容打成「读取失败」。

文本域这两块要把读回来的内容灌进可编辑状态：`useSeededValue` 只在第一次读到内容时灌
一次，之后的刷新不会覆盖用户正在编辑的字。

## 每一块都必须有真实后端

- 更新：`/dsh-purge/update`。但本地版部署 `updateDisabled === true`，此时**不渲染任何按钮**，
  只如实写出服务端给的原因。摆一个点了必然失败的按钮，是把设计问题转嫁给用户。
- 注入：`/dsh-purge/override`。保存失败时保留编辑框内容，用户不必重打。
- 服务器名单：`/dsh-purge/own-servers`。
- Hooks 拦截：`/dsh-purge/hooks-deny`，读写 `hooksDenyBypass`，落到宿主配置。
- 还原 / 卸载：`/dsh-purge/revert`、`/dsh-purge/uninstall`，都不可撤销，放在最后。

## 版式

五块都是同一个 Section + Field 形态：标题行给动作，字段行给标签、说明与控件。
不自带面板、圆角或阴影 —— 宿主设置面板里已经有足够的容器层级。危险区与上方内容之间
只有一条发丝线，不另造容器。

## 为什么 Hooks 用宿主 Switch

原来的复选 `<input type="checkbox">` 靠一条样式表里不存在的规则挑样式，真机上就是一个
未对齐的系统方框。宿主 Switch 带原生键位与焦点环，与设置面板里其它开关长得一样。

本文件不是 ES 模块，正文逐字节内联进 client.js。
*/

		function RestartAsk(props) {
			// 确认窗留在页面里渲染，不走 portal：用户正看着这块区域点「重启」，
			// 把窗搬到 body 会丢掉上下文。深浅色一律吃宿主变量。
			return h("div", {
				className: "dshp-restart-mask",
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": "dshp-restart-title",
				onClick: (e) => { if (e.target === e.currentTarget && props.onLater) props.onLater(); },
			},
				h("div", { className: "dshp-restart-card" },
					h("h4", { id: "dshp-restart-title" }, props.t("restart.ask.title")),
					h("p", null, props.t("restart.ask.body")),
					h("div", { className: "dshp-modal-ops" },
						h(ActionButton, { onClick: props.onLater }, props.t("restart.notNow")),
						h(ActionButton, { primary: true, onClick: props.onRestart }, props.t("restart.now")),
					),
				),
			);
		}

		/** 读一次更新能力：服务端明确说了 `updateDisabled` 就一个按钮都不画。 */
		function fetchUpdateInfo() {
			return apiJson("/dsh-purge/update").then((d) => {
				if (!d || typeof d !== "object") throw new Error("bad response");
				return d;
			});
		}

		/**
		 * 更新与版本：先读一次 `/dsh-purge/update` 拿真实能力，再决定渲不渲染按钮。
		 *
		 * 不能只看状态快照里的更新结果：它来自 `updater.lastUpdateResult()`，只有用户主动
		 * 检测过更新才有值；本页从未检测过时它为空，于是「更新已关闭」的判断失效，
		 * 界面上就会出现一个点了必然失败的「检测更新」按钮 —— 实际部署确实如此。
		 * 这里自己取一次，服务端明确说了 `updateDisabled` 就一个按钮都不画。
		 */
		function UpdateSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const res = useAsyncResource(fetchUpdateInfo);
			const [fresh, setFresh] = useState(null);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			/* 用户点过「检测更新」之后以那一次的结果为准；没点过就用读到的能力与快照。 */
			const info = fresh || res.data || props.updateInfo || null;

			const check = useCallback(() => {
				setBusy(true);
				setNotice({ kind: "ok", text: t("update.checking") });
				apiJson("/dsh-purge/update")
					.then((d) => {
						if (!d) throw new Error("empty response");
						setFresh(d);
						setNotice({
							kind: d.error ? "error" : "ok",
							text: d.error || (d.hasUpdate
								? t("update.available").replace("{remote}", d.remoteVersion || "—").replace("{local}", d.localVersion || "—")
								: t("update.latest").replace("{version}", d.localVersion || "—")),
						});
						if (typeof props.onChanged === "function") props.onChanged();
					})
					.catch((e) => setNotice({ kind: "error", text: t("update.fail").replace("{error}", (e && e.message) || e) }))
					.finally(() => setBusy(false));
			}, [t, props.onChanged]);

			const off = Boolean(info && info.updateDisabled);
			const version = (info && info.localVersion) || "";
			const channel = (info && info.channel) || "stable";
			const channelText = t("channel." + channel);

			return h(Section, { title: t("section.update") },
				h(AsyncBlock, { t: t, resource: res, height: SKEL_SM },
					h(Field, {
						label: t("metric.version"),
						hint: off
							? t("update.off").replace("{reason}", (info && info.updateDisabledReason) || "")
							: channelText + (info && info.channelLabel && info.channelLabel !== channelText ? " · " + info.channelLabel : ""),
						action: off
							? null
							: h(ActionButton, { primary: true, tiny: true, disabled: busy, onClick: check }, t("btn.checkUpdate")),
						children: h("span", { className: "dshp-row__value" }, version ? "v" + version : "—"),
					}),
				),
				h(Note, { notice: notice }),
			);
		}

		/** 读注入提示词；`ok: false` 要能看见，所以抛出去交给五态。 */
		function fetchOverride() {
			return apiJson("/dsh-purge/override").then((d) => {
				if (!d || !d.ok) throw new Error(String((d && d.error) || "bad response"));
				return d;
			});
		}

		/** 注入提示词：读写 `/dsh-purge/override`，保存失败保留用户输入。 */
		function OverrideSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const res = useAsyncResource(fetchOverride);
			const [override, setOverride] = useSeededValue(res.phase, res.data, (d) => {
				const packed = typeof d.defaultContent === "string" ? d.defaultContent : "";
				const shown = typeof d.content === "string" ? d.content : "";
				return shown || packed;
			});
			const [defaultOverride] = useSeededValue(res.phase, res.data, (d) => (
				typeof d.defaultContent === "string" ? d.defaultContent : ""
			));
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const text = override === null ? "" : override;
			const def = defaultOverride === null ? "" : defaultOverride;
			const empty = promptBoxEmpty(text) && promptBoxEmpty(def);

			const post = useCallback((content) => {
				setBusy(true);
				setNotice({ kind: "idle", text: "" });
				apiJson("/dsh-purge/override", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ content: content }),
				})
					.then((d) => {
						if (!d || !d.ok) {
							/* 失败时不动 textarea：内容留在编辑框里，用户不必重打。 */
							setNotice({ kind: "error", text: t("err.save").replace("{error}", (d && d.error) || "") });
							return;
						}
						if (typeof d.content === "string") setOverride(d.content);
						setNotice({ kind: "ok", text: t("saved.override") });
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.save").replace("{error}", (e && e.message) || e) }))
					.finally(() => setBusy(false));
			}, [t]);

			return h(Section, {
				title: t("override.title"),
				action: h("div", { className: "dshp-actions" },
					h(ActionButton, { primary: true, tiny: true, disabled: busy || override === null || empty, onClick: () => post(text) }, t("btn.saveInject")),
					h(ActionButton, { tiny: true, disabled: busy || override === null || !def, onClick: () => post(def) }, t("btn.restoreInject")),
				),
			},
				h(AsyncBlock, { t: t, resource: res, height: SKEL_LG, errorKey: "override" },
					h("textarea", {
						className: "dshp-area",
						value: text,
						onChange: (e) => setOverride(e.target.value),
						spellCheck: false,
						rows: 10,
					}),
				),
				empty ? h("p", { className: "dshp-hint" }, t("need.prompt")) : null,
				h(Note, { notice: notice }),
			);
		}

		/** 读自己的服务器名单。 */
		function fetchOwnServers() {
			return apiJson("/dsh-purge/own-servers").then((d) => {
				if (!d || !d.ok) throw new Error(String((d && d.error) || "bad response"));
				return d;
			});
		}

		/** 自己的服务器名单：读写 `/dsh-purge/own-servers`。 */
		function OwnServersSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const res = useAsyncResource(fetchOwnServers);
			const [text, setText] = useSeededValue(res.phase, res.data, (d) => (
				typeof d.content === "string" ? d.content : ""
			));
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const body = text === null ? "" : text;

			const save = useCallback(() => {
				setBusy(true);
				setNotice({ kind: "idle", text: "" });
				apiJson("/dsh-purge/own-servers", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ content: body }),
				})
					.then((d) => {
						if (!d || !d.ok) {
							setNotice({ kind: "error", text: t("err.save").replace("{error}", (d && d.error) || "") });
							return;
						}
						if (typeof d.content === "string") setText(d.content);
						setNotice({
							kind: "ok",
							text: d.dropped > 0
								? t("saved.own.dropped").replace("{n}", String(d.dropped))
								: t("saved.own"),
						});
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.save").replace("{error}", (e && e.message) || e) }))
					.finally(() => setBusy(false));
			}, [t, body, setText]);

			return h(Section, {
				title: t("own.title"),
				action: h(ActionButton, { primary: true, tiny: true, disabled: busy || text === null, onClick: save }, t("own.save")),
			},
				h(AsyncBlock, { t: t, resource: res, height: SKEL_MD, errorKey: "status" },
					h("textarea", {
						className: "dshp-area",
						value: body,
						onChange: (e) => setText(e.target.value),
						spellCheck: false,
						rows: 4,
						style: { minHeight: 96 },
					}),
				),
				h("p", { className: "dshp-field__hint" }, t("own.hint")),
				h(Note, { notice: notice }),
			);
		}

		/** 读 Hooks 拦截开关的现状。 */
		function fetchHooksDeny() {
			return apiJson("/dsh-purge/hooks-deny").then((d) => {
				if (!d || !d.ok) throw new Error(String((d && d.error) || "bad response"));
				return d;
			});
		}

		/** Hooks 拦截开关：读一次、写一次，失败就把服务端的 error 原样显示。 */
		function HooksDenySection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const res = useAsyncResource(fetchHooksDeny);
			/* 用户拨过开关之后以本地那一次为准；没拨过就读服务端这一次的现状。 */
			const [overrideCfg, setOverrideCfg] = useState(null);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [busy, setBusy] = useState(false);
			const cfg = overrideCfg || (res.data ? { hooksDenyBypass: res.data.hooksDenyBypass !== false } : null);

			const save = (hooksDenyBypass) => {
				if (!cfg || busy) return;
				setOverrideCfg({ hooksDenyBypass: hooksDenyBypass });
				setBusy(true);
				apiJson("/dsh-purge/hooks-deny", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ hooksDenyBypass }),
				})
					.then((d) => {
						if (d && d.ok) {
							setOverrideCfg({ hooksDenyBypass: d.hooksDenyBypass === true });
							setNotice({ kind: "ok", text: t("saved.hooksDeny") });
							if (typeof props.onSaved === "function") props.onSaved();
						} else {
							setNotice({ kind: "error", text: t("err.save").replace("{error}", (d && d.error) || "") });
						}
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.save").replace("{error}", (e && e.message) || e) }))
					.finally(() => setBusy(false));
			};

			const Switch = primOf("Switch");
			const checked = !!(cfg && cfg.hooksDenyBypass === true);
			const control = h("div", { className: "dshp-field__head" },
				h("span", { className: "dshp-field__label" }, t("hooksDeny.bypass")),
				Switch
					? h(Switch, { checked: checked, disabled: busy || !cfg, label: t("hooksDeny.bypass"), onChange: save })
					: h("input", { type: "checkbox", checked: checked, disabled: busy || !cfg, onChange: (e) => save(e.target.checked) }),
			);

			return h(Section, { title: t("section.hooks") },
				h(AsyncBlock, { t: t, resource: res, height: SKEL_SM, errorKey: "status" },
					h("div", { className: "dshp-field" },
						control,
						h("p", { className: "dshp-field__hint" }, t("hooksDeny.hint")),
					),
				),
				h(Note, { notice: notice }),
			);
		}

		/**
		 * 危险区：还原与卸载。两者都有真实后端、都不可撤销，所以放最后、与上方隔开。
		 */
		function DangerZoneSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [askUninstall, setAskUninstall] = useState(false);
			const state = props.state;

			const doRevert = useCallback(() => {
				setBusy(true);
				setNotice({ kind: "idle", text: "" });
				fetch("/dsh-purge/revert", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
					.then((r) => r.json())
					.then((d) => {
						if (!d || !d.ok) {
							setNotice({ kind: "error", text: t("err.action").replace("{error}", (d && d.error) || "") });
							return;
						}
						setNotice({ kind: "ok", text: t("ok.done") });
						if (typeof props.onChanged === "function") props.onChanged();
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.action").replace("{error}", (e && e.message) || e) }))
					.finally(() => setBusy(false));
			}, [t, props.onChanged]);

			const doUninstall = useCallback(() => {
				setAskUninstall(false);
				setBusy(true);
				setNotice({ kind: "ok", text: t("uninstall.applying") });
				const surface = hostSurfaceOf(state);
				apiJson("/dsh-purge/uninstall", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
					.then((d) => {
						if (!d || !d.ok) throw new Error((d && d.error) || "uninstall failed");
						setNotice({ kind: "ok", text: hostText(t, "uninstall.done", d.surface || surface) });
					})
					.catch((e) => {
						const msg = String((e && e.message) || e || "");
						/* 卸载会切断宿主自己的连接，fetch 失败是预期结果，不是故障。 */
						if (/failed to fetch|networkerror|load failed/i.test(msg)) {
							setNotice({ kind: "ok", text: hostText(t, "uninstall.done", surface) });
							return;
						}
						setNotice({ kind: "error", text: t("uninstall.fail").replace("{error}", msg) });
						setBusy(false);
					});
			}, [t, state]);

			const surface = hostSurfaceOf(state);
			const noRoot = state && !state.ai_base;

			return h("section", { className: "dshp-section dshp-section--danger" },
				h(Section, { title: t("section.danger") },
					noRoot ? h("p", { className: "dshp-hint" }, hostText(t, "warn.noRoot", surface)) : null,
					h(Field, {
						label: t("action.revert"),
						hint: t("action.revert.hint"),
						action: h(ActionButton, { danger: true, disabled: busy, onClick: doRevert }, t("btn.revert")),
					}),
					h(Field, {
						label: t("action.uninstall"),
						hint: t("action.uninstall.hint"),
						action: h(ActionButton, { danger: true, disabled: busy, onClick: () => setAskUninstall(true) }, t("btn.uninstall")),
					}),
					h(Note, { notice: notice }),
				),
				askUninstall
					? h("div", {
						className: "dshp-modal-bg",
						role: "dialog",
						"aria-modal": "true",
						onClick: (e) => { if (e.target === e.currentTarget) setAskUninstall(false); },
					},
						h("div", { className: "dshp-modal" },
							h("h4", null, t("uninstall.title")),
							h("p", null, t("uninstall.body")),
							h("div", { className: "dshp-modal-ops" },
								h(ActionButton, { onClick: () => setAskUninstall(false) }, t("uninstall.cancel")),
								h(ActionButton, { danger: true, onClick: doUninstall }, t("uninstall.confirm")),
							),
						),
					)
					: null,
			);
		}

		/**
		 * 配置页签的容器：五块共享同一份快照的五态，各自再取自己的只读端点；危险区按设计
		 * 排在最后（它要读快照里的宿主面，所以快照没读到时整块不挂载）。
		 */
		function ConfigPanel(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const resource = props.resource || null;
			const state = resource && resource.data ? resource.data : null;
			const updateInfo = (state && state.update) || null;
			return h(AsyncBlock, { t: t, resource: resource, height: SKEL_MD },
				h(react.Fragment, null,
					h(UpdateSection, { t: t, updateInfo: updateInfo, onChanged: props.onChanged }),
					h(OverrideSection, { t: t }),
					h(OwnServersSection, { t: t }),
					h(HooksDenySection, null),
					h(DangerZoneSection, { t: t, state: state, onChanged: props.onChanged }),
				),
			);
		}