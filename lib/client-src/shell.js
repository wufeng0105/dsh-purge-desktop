/**
lib/client-src/shell.js — client.js 的模板：ModuleLoader 外壳与装配入口。

## 它是模板，不是普通源文件

`/* __DSHP_SLOT:<name>__ *\/` 是一行占位符，由 scripts/build-client.mjs 整行替换成
lib/client-src/<name>.js 的正文。所以本文件拼出来的 client.js 是**单向**的：
源 → 产物，产物永远不被读回。

没被占位符替换的那些行（闭包头、require、TARGETS、AUTH_KEY、drill 标记、
正则/空行胶水、apply()、exports）就是「shell」本身 —— 它们是外壳，不属于任何
子模块。

## 为什么占位符是注释行

这样本文件单独看也是合法 JS（占位符只是注释），knip / dependency-cruiser /
ast-grep 扫 lib/**\/*.js 时不会因为语法错而炸掉。

## 顺序即语义

占位符的先后就是 client.js 里的先后。改顺序等于改闭包内的声明顺序，
会改变 TDZ / 顶层求值行为 —— 不要为了「看起来更整齐」去调换。
*/

window.__ModuleLoader__.load({ id: "dsh-purge", factory: (require) => {

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useRef, Component } = react;
		/*
		 * 宿主原语包：设置页的所有控件都从这里取，不自造按钮与色块。
		 *
		 * 为什么必须用宿主组件：`@deepseek-ai/dsh-client-ui-primitives` 在宿主的冻结模块表
		 * （PLATFORM_MODULES）里，与 react / react-dom / cordis / slots 同列，所以片段可以
		 * 同步 require 它。用它换来的是原生外观、原生明暗、原生键盘与无障碍行为——自造一套
		 * 必然在某个主题下错位，而且每个控件都要自己重写一遍可逆逻辑。
		 *
		 * 取不到时整体降级为 null：旧宿主若没有这个包，页面渲染空的可见提示，而不是抛错把
		 * 整个设置页打掉。
		 */
		let prim = null;
		try {
			prim = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (e) {
			try { console.warn("[dsh-purge] primitives unavailable:", e && e.message); } catch { /* ignore */ }
		}
		function primOf(name) {
			return prim && typeof prim[name] === "function" ? prim[name] : null;
		}

		const name = "dsh-purge";
		const inject = ["slots", "locale"];
		const NS = "settings.dsh-purge";
		let translate = (key) => key;
		/** 演练台与片段的取词入口：同一闭包里复用 translate。 */
		function dt(key) {
			return translate(key);
		}
		function useT() {
			return translate;
		}
		function clientGuessSurface() {
			try {
				if (typeof navigator !== "undefined" && /electron/i.test(navigator.userAgent || "")) return "desktop";
				if (typeof location !== "undefined") {
					const port = String(location.port || "");
					if (port === "43120") return "desktop";
					const host = String(location.hostname || "");
					if (host && host !== "127.0.0.1" && host !== "localhost" && /dsh desktop/i.test(String(location.href || ""))) return "desktop";
				}
			} catch { /* ignore */ }
			return "";
		}
		function hostSurfaceOf(s) {
			return (s && s.surface) || clientGuessSurface() || "web";
		}
		function hostText(t, key, surface) {
			if (surface && surface !== "web") {
				const specific = key + "." + surface;
				const hit = t(specific);
				if (hit && hit !== specific) return hit;
			}
			return t(key);
		}
		function apiUrl(p) {
			try { return new URL(p, window.location.origin).toString(); } catch { return p; }
		}
		function apiTimeoutMs(p, init) {
			const path = String(p || "");
			const method = String((init && init.method) || "GET").toUpperCase();
			if (path.indexOf("/dsh-purge/update") !== -1) return method === "POST" ? 180000 : 45000;
			if (path.indexOf("/dsh-purge/uninstall") !== -1) return 90000;
			if (path.indexOf("/dsh-purge/skill") !== -1) return method === "POST" ? 120000 : 20000;
			// status 会在"应用"期间被后端的同步落盘阻塞，默认 20s 必然被 abort，界面只会显示"读取失败: timeout"。
			// 端点字面量只在 settings/store.js 里写一次，这里引用同一个常量。
			if (path.indexOf(PURGE_STATUS_PATH) !== -1) return 60000;
			if (path.indexOf("/dsh-purge/apply") !== -1) return 240000;
			if (path.indexOf("/dsh-purge/revert") !== -1) return 120000;
			if (path.indexOf("/dsh-purge/restart") !== -1) return 60000;
			return 20000;
		}
		function isAbortError(e) {
			const msg = String((e && e.message) || e || "");
			return (e && e.name === "AbortError") || /aborted|abort/i.test(msg);
		}
		async function apiJson(p, init) {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), apiTimeoutMs(p, init));
			try {
				const r = await fetch(apiUrl(p), { cache: "no-store", credentials: "same-origin", signal: ctrl.signal, ...(init || {}) });
				const text = await r.text();
				let data;
				try { data = text ? JSON.parse(text) : null; } catch {
					throw new Error(r.status + " non-json: " + text.slice(0, 120));
				}
				if (!r.ok) throw new Error((data && (data.error || data.message)) || (r.status + " " + r.statusText));
				return data;
			} catch (e) {
				if (isAbortError(e)) throw new Error("timeout");
				const msg = String((e && e.message) || e || "");
				if (/failed to fetch|networkerror|load failed/i.test(msg)) {
					throw new Error(dt('drill.e20001'));
				}
				throw e;
			} finally { clearTimeout(timer); }
		}

		function promptBoxEmpty(text) {
			return !String(text || "").trim();
		}

		function responseNeedsPrompt(d) {
			return Boolean(d && (d.needPrompt || d.injectSource === "none"));
		}

		function warnNeedPrompt(d, tr) {
			if (!responseNeedsPrompt(d)) return false;
			window.alert(tr("need.prompt"));
			return true;
		}

		async function bothInjectEmpty(overrideText, defaultText) {
			if (!promptBoxEmpty(overrideText)) return false;
			if (!promptBoxEmpty(defaultText)) return false;
			return true;
		}

		function rulesApi(op, extra) {
			return apiJson("/dsh-purge/rules", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: op, ...(extra || {}) }),
			});
		}

		function skillsRouteMissing(e) {
			return /\b404\b|\b405\b|non-json/i.test(String((e && e.message) || e || ""));
		}

		function skillsApi(op, extra) {
			const init = {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: op, ...(extra || {}) }),
			};
			return apiJson("/dsh-purge/skills", init).catch((e) => {
				if (!skillsRouteMissing(e)) throw e;
				return apiJson("/dsh-purge/skill", init);
			});
		}

		const TARGETS = ["AGENTS.md", "CLAUDE.md"];

		/* __DSHP_SLOT:i18n__ */

		/* 样式三层：令牌 → 原语 → 布局，装配顺序就是级联顺序，最后由 purge-css 拼成 PURGE_CSS。 */
		/* __DSHP_SLOT:design-tokens__ */
		/* __DSHP_SLOT:design-components__ */
		/* __DSHP_SLOT:design-layout__ */

		/* __DSHP_SLOT:purge-css__ */

		/* __DSHP_SLOT:settings-rows__ */
		/* __DSHP_SLOT:settings-store__ */
		/* __DSHP_SLOT:settings-ui__ */
		/* __DSHP_SLOT:settings-page__ */
		/* __DSHP_SLOT:settings-status-tab__ */
		/* __DSHP_SLOT:settings-patches-tab__ */
		/* __DSHP_SLOT:settings-config-tab__ */
		/* __DSHP_SLOT:settings-skills-tab__ */
		/* __DSHP_SLOT:settings-diagnostics-tab__ */
		/* __DSHP_SLOT:settings-host__ */

		/* __DSHP_SLOT:rewind-ui__ */

		/* __DSH_PURGE_DRILL_BEGIN__ */
/* __DSH_PURGE_DRILL_END__ */

		const AUTH_KEY = "dsh-purge-drill-auth";
		/* __DSHP_SRC:welcome-helpers:BEGIN__ */
		/* __DSHP_SLOT:welcome-helpers__ */
		/* __DSHP_SRC:welcome-helpers:END__ */

		/* __DSHP_SLOT:dock-auth__ */

		/* __DSHP_SRC:welcome-notice:BEGIN__ */
		/* __DSHP_SLOT:welcome-notice__ */
		/* __DSHP_SRC:welcome-notice:END__ */

		/* __DSHP_SLOT:dock-auth-gate__ */

		/* __DSHP_SLOT:dock-env-gate__ */

		/* __DSHP_SLOT:rewind-install__ */

		/* __DSHP_SLOT:settings-p1-section__ */

		/* __DSHP_SLOT:drill-copy__ */

		/* __DSHP_SLOT:main-drill-panel__ */

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-purge: dictionaries");
			const t = ctx.locale.bind(NS);
			translate = t;
			/*
			 * 样式必须挂在文档级，不能挂在某个页面组件里。
			 *
			 * 教训（真机复现）：删浮层之前，PURGE_CSS 是浮层组件挂上去的；浮层一删，
			 * 首次安装弹出的用户须知就成了「无样式 DOM」——`.dshp-auth-mask` 的
			 * `position:fixed` 没生效，弹窗按普通文档流堆着，勾选框与「同意」被压在别的元素下面，
			 * 用户看到窗口、却点不动按钮。页面组件（设置页 / 主区面板）各自还有一份，
			 * 但它们只在用户主动进去时才挂载，救不了首屏。
			 *
			 * 所以这里注入唯一的一份：谁先出现都吃得到样式，页面组件不再各自带 style。
			 */
			ctx.effect(() => {
				if (typeof document === "undefined" || !document.head) return () => {};
				const tag = document.createElement("style");
				tag.setAttribute("data-dsh-purge-ui", "1");
				tag.textContent = PURGE_CSS;
				document.head.append(tag);
				return () => {
					try { tag.remove(); } catch { /* ignore */ }
				};
			}, "dsh-purge: styles");
			// 一次性须知与环境适配门仍走浮层：前者是首次安装必须盖住整页的知己声明，
			// 后者要在**任意页面**拦下红队模式的发送（它不属于某一个页面，放进主区就只在主区生效）。
			// 原来的双页签面板、全面浏览第二窗口、hero chip、页签栏挂件与 DOM 兜底全部随浮层删除：
			// 清洗进了设置页，演练台进了主区，入口在侧栏。
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-purge-welcome",
				order: 50,
			}, () => h(react.Fragment, null, h(WelcomeNotice), h(EnvAdaptSendGate))));
			// P1 清洗页：与宿主设置页插件同一套形态 —— 先 inject 再 register，
			// 内容组件是 register 的第二实参；对象里的 inject 字段不收服务数组。
			// 座位注册形状只到「一个 section、一个内容组件」为止：设置页内部的页签由页面自己渲染，
			// 早先那行 `children` 声明的页签座位全仓无消费方，已删。
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-purge",
				order: 16,
				label: () => translate("nav"),
				locale: NS,
			}, PurgeSettingsSection));
			// P2 演练台：主区一整页 + 侧栏常驻入口，key 与侧栏 id 对齐，
			// 点图标才切得到这一页。主区用 generator 注入形态（宿主插件管理器同构）。
			ctx.slots.inject("main", function* () {
				yield ctx.slots.register({ name: "main", key: "dsh-purge-drill", locale: NS }, PurgeDrillPanel);
			});
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "dsh-purge-drill", order: 10, label: () => translate("dock.drill"), locale: NS }, PurgeDrillIcon));
			try {
				if (typeof ctx.inject === "function") {
					ctx.inject(["sessions", "uiWorkspace", "workspaces", "conversation"], (host) => installRewindUi(host));
				} else if (ctx.sessions) {
					installRewindUi(ctx);
				}
			} catch (e) {
				try {
					if (typeof ctx.inject === "function") {
						ctx.inject(["sessions", "uiWorkspace", "conversation"], (host) => installRewindUi(host));
					}
				} catch (e2) {
					try { console.warn("[dsh-purge] rewind ui skipped:", e2 || e); } catch { /* ignore */ }
				}
			}
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
