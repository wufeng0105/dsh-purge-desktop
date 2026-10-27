/**
lib/client-src/settings/page.js — 设置页的壳：页头 + 页签栏 + 五块面板的挂载 + 页脚。

## 这一页回答三个问题

正不正常（状态页签）、装了什么（补丁页签）、能改什么（配置页签：更新 / 注入 /
服务器名单 / Hooks 拦截 / 危险区），另有技能页签与诊断页签（审计轨、健康与三条日志轨）
两块只读 —— 后者回答「过去发生了什么、这台机器的副本还对不对」。

## 为什么是页签

左栏是宿主导航（通用设置 / 模型 / 内置插件 / 规则设定 / Agent 预设），本插件只占一个
section，往里加不了目录。十块异质内容挤成一条长滚动时，唯一的目录就是页内锚点导航；
页签把「目录」和「内容」合成一件事：一次只露一块，没有锚点可点错。

锚点导航已经删掉，各分节也不再挂分节 id。页签与面板的 id 只由 `settingsTabId` /
`settingsPanelId` 各拼一次，两处都从 `settingsTabItems()` 派生 —— 多一个页签就必然多
一块面板，少一块面板就必然少一个页签。

## 本文件只剩壳

取数、状态页签的内容、四个人话函数、五个页签各自的只读端点全在别处：数据入口是
`settings/store.js` 的 `usePurgeStatus()`，状态页签是 `settings/status-tab.js` 的
`StatusPanel`。本文件不知道状态端点的路径，也不自己数任何一个补丁 —— 壳一旦开始做
这两件事，就又长出一个取数点与第二份聚合。

页头只说状态词、不报数：数字在状态页签的摘要那一行出现一次，别处不再复述。

## 拿掉的东西

`applied_at`（服务端不返回，那格永远是「从未」）、`installed_rev`（同样不存在，页脚
永远是「—」）、「检测更新」这个在本地版部署里必然失败的按钮、以及页内锚点导航。

本文件不是 ES 模块，正文逐字节内联进 client.js。
*/

		/* ── 页签壳：清单、id、焦点 ───────────────────────────────────────────── */

		/**
		 * 页签清单：键 → 文案键。顺序即渲染顺序，条目数就是页签数。
		 *
		 * 为什么要一个纯函数而不是散在渲染里：判据要在不渲染的前提下取到这份清单，页签按钮
		 * 与面板两处都从它派生 —— 清单是唯一来源，「多一个页签少一块面板」就不可能发生。
		 */
		function settingsTabItems() {
			return [
				{ key: "status", label: "tab.status" },
				{ key: "patches", label: "tab.patches" },
				{ key: "config", label: "tab.config" },
				{ key: "skills", label: "tab.skills" },
				{ key: "diagnostics", label: "tab.diagnostics" },
			];
		}

		/** 页签按钮的 id。两处各拼一次必然漂，所以只在这里拼。 */
		function settingsTabId(key) {
			return "dshp-tab-" + key;
		}

		/** 面板的 id：与 `settingsTabId` 成对，`aria-controls` 与 `aria-labelledby` 互相指。 */
		function settingsPanelId(key) {
			return "dshp-panel-" + key;
		}

		/**
		 * 页签按钮与面板的版式。
		 *
		 * 为什么用这几条现成的类名：页签栏用 `.dshp-nav` 这条横条（它本来就在
		 * `design/layout.js` 里，带下边线），页签按钮用 `.dshp-tab-btn` +
		 * 选中态 `.on`（`design/components.js`）；面板容器用 `.dshp-panel-body`
		 * —— 它承担面板的内边距与 760 内容上限，且不建层叠上下文，面板因此不再
		 * 借页面壳的 `.dshp-page`（借来的是整页语义，不是面板需要的）。片段里不写
		 * 字面尺寸与颜色 —— 那条纪律由 `test/settings-inline-style.test.mjs` 守着。
		 */
		function SettingsPage(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			translate = t;
			const [openErr, setOpenErr] = useState("");
			const [tab, setTab] = useState("status");
			/* 页签节点的引用：方向键切页签时焦点必须同移，否则连按方向键只在同一个按钮上来回。 */
			const tabNodes = useRef({});
			/* 整页唯一的数据入口：五个页签共用这一份快照，写成功后叫 refresh() 重取。 */
			const resource = usePurgeStatus();
			const s = resource.data;

			const openLocal = useCallback((kind) => {
				setOpenErr("");
				apiJson("/dsh-purge/open", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ kind: kind }),
				}).catch((e) => setOpenErr(String((e && e.message) || e)));
			}, []);

			const head = settingsHeadStatus(s || {});
			const statusText = t(head.key);
			const updateInfo = (s && s.update) || null;
			const version = (s && s.plugin_version) || (updateInfo && updateInfo.localVersion) || "";

			/* 点选与键盘切换走同一条路：先换选中态，再把焦点搬到新页签上。 */
			const pickTab = useCallback((key) => {
				setTab(key);
				const node = tabNodes.current[key];
				if (node && typeof node.focus === "function") node.focus();
			}, []);

			/* 方向键在页签之间循环，Home / End 跳首尾；其余键放行给宿主。 */
			const onTabKey = useCallback((event) => {
				const keys = settingsTabItems().map((item) => item.key);
				const last = keys.length - 1;
				const at = keys.indexOf(tab);
				let to = -1;
				if (event.key === "ArrowRight") to = at >= last ? 0 : at + 1;
				if (event.key === "ArrowLeft") to = at <= 0 ? last : at - 1;
				if (event.key === "Home") to = 0;
				if (event.key === "End") to = last;
				if (to < 0) return;
				event.preventDefault();
				pickTab(keys[to]);
			}, [tab, pickTab]);

			/* 一块页签一块内容：按 key 分派，五块都从同一份快照读。 */
			const panelBody = (key) => {
				if (key === "status") return h(StatusPanel, { t: t, resource: resource });
				if (key === "patches") return h(PatchesPanel, { t: t, resource: resource });
				if (key === "config") return h(ConfigPanel, { t: t, resource: resource, onChanged: resource.refresh });
				if (key === "skills") return h(SkillsPanel, { t: t, resource: resource });
				return h(DiagnosticsPanel, { t: t, resource: resource });
			};

			return h("div", { className: "dshp-page" },
				h("header", { className: "dshp-page__head" },
					h("div", { className: "dshp-page__id" },
						h("h2", { className: "dshp-product" }, "dsh-purge"),
						version ? h("span", { className: "dshp-badge" }, "v" + version) : null,
					),
					h("span", { className: "dshp-page__status" },
						h(StatusDot, { tone: head.tone, title: statusText }),
						h("span", null, statusText),
					),
					h("span", { style: { flex: 1 } }),
				),

				/* 页签栏：宿主左栏加不了目录，所以目录长在页内 —— 但一次只露一块内容。
				   横条与按钮都用现成类名（`design/layout.js` 与 `design/components.js` 里已有）。 */
				h("div", {
					className: "dshp-nav",
					role: "tablist",
					"aria-label": t("tab.list.label"),
					onKeyDown: onTabKey,
				},
					h("span", { className: "dshp-nav__items", role: "presentation" },
						settingsTabItems().map((item) => {
							const on = tab === item.key;
							return h("span", { className: "dshp-tab-chip", role: "presentation", key: item.key },
								h("button", {
									type: "button",
									role: "tab",
									id: settingsTabId(item.key),
									className: "dshp-tab-btn" + (on ? " on" : ""),
									"aria-selected": on ? "true" : "false",
									"aria-controls": settingsPanelId(item.key),
									tabIndex: on ? 0 : -1,
									ref: (node) => { tabNodes.current[item.key] = node; },
									onClick: () => pickTab(item.key),
								}, t(item.label)),
							);
						}),
					),
				),

				/* 五块面板：都挂出来、只露当前那块。挂出来是为了切回来时不必重新取数 ——
				   诊断页签的审计与健康各自只在挂载时取一次。容器是面板自己的类，不是页面壳的。 */
				settingsTabItems().map((item) => h("div", {
					key: item.key,
					id: settingsPanelId(item.key),
					className: "dshp-panel-body",
					role: "tabpanel",
					"aria-labelledby": settingsTabId(item.key),
					tabIndex: 0,
					hidden: tab !== item.key,
				}, panelBody(item.key))),

				h("footer", { className: "dshp-page__foot" },
					h("div", { className: "dshp-foot__links" },
						h("button", { type: "button", className: "dshp-link", onClick: () => openLocal("logs") }, t("foot.logs")),
						h("button", { type: "button", className: "dshp-link", onClick: () => openLocal("config") }, t("foot.config")),
					),
					openErr ? h("div", { className: "dshp-note is-bad" }, openErr) : null,
					s && s.dsh_home ? h("div", { className: "dshp-hint" }, s.dsh_home) : null,
				),
			);
		}
