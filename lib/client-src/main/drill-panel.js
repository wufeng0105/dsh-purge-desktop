/**
lib/client-src/main/drill-panel.js — 演练台在主区 `main` 座位的实现体 + 侧栏入口图标。

为什么单独一个文件：主区面板与侧栏图标是两个座位，但用的是同一份数据与同一套授权态；
放在一个文件里，读的人一眼能看到「点侧栏图标 → 主区出现面板」这条链路的两端。

为什么未授权时直接渲染授权窗而不是先给个空壳：演练台的数据全部走需要授权的接口，
先挂空壳只会让用户看到一堆取不到数据的骨架。
 */

		function PurgeDrillPanel() {
			const t = useT();
			if (!__dshPurgeDrill || typeof __dshPurgeDrill.Panel !== "function") {
				return h("div", { className: "dshp-root dshp-root--main" },
					h("div", { className: "dshp-drill-note" }, t("drill.missing")),
				);
			}
			if (!readDrillAuth()) {
				return h("div", { className: "dshp-root dshp-root--main" },
					h("style", null, __dshPurgeDrill.CSS),
					h(AuthGate, { pending: "tab" }),
				);
			}
			return h("div", { className: "dshp-root dshp-root--main" },
				h("style", null, __dshPurgeDrill.CSS),
				h(__dshPurgeDrill.Panel, { embedded: true }),
			);
		}

		function PurgeDrillIcon() {
			const t = useT();
			const label = t("dock.drill");
			return h("span", { className: "dshp-panellist", title: label, "aria-label": label }, "\u25e7");
		}
