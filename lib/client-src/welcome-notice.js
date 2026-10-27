/**
 * lib/client-src/welcome-notice.js — 首次安装的一次性须知弹窗，丢了只会静默消失。
 * 用户须知弹窗（WelcomeNotice）—— 首次安装时的一次性合规提示。
 *
 * ## 为什么这个文件存在
 *
 * 与 welcome-helpers.js 同因：这段代码原本**只存在于生成物 client.js 里**，
 * 没有任何源文件。它丢了不会报错、不会红测试，只会让首次安装的用户
 * 再也看不到那份禁止事项与使用须知。
 *
 * ## 作用域约定（本文件不是 ES 模块，是生成时被内联的片段）
 *
 * 依赖 client.js 的闭包作用域：
 *   h / useState / useT / readWelcomeAck / writeWelcomeAck
 *   require("react-dom") / window / document
 * 以及 dock/auth-gate.js 注入的 .dshp-auth-* CSS 类。
 *
 * 缩进刻意保持两个 tab，与注入点一致 —— 逐字节可复现是硬要求。
 */

		function WelcomeNotice() {
			const t = useT();
			const [open, setOpen] = useState(() => !readWelcomeAck());
			const [checked, setChecked] = useState(false);
			if (!open) return null;
			const repo = t("welcome.repo");
			const node = h("div", { className: "dshp-auth-mask", role: "dialog", "aria-modal": "true" },
				h("div", { className: "dshp-auth-modal", style: { width: "min(560px,100%)" } },
					h("h2", null, t("welcome.title")),
					h("div", { className: "muted", style: { color: "var(--dsw-alias-label-secondary,#999)", fontSize: 12 } }, t("welcome.lead")),
					h("div", { className: "dshp-auth-warn" }, t("welcome.warn")),
					h("div", { className: "dshp-auth-legal", style: { height: "auto", maxHeight: 280 } },
						h("p", null, t("welcome.body")),
						h("p", null,
							h("a", {
								href: repo,
								target: "_blank",
								rel: "noopener noreferrer",
								style: { color: "var(--dsw-alias-label-brand, #8fbf9a)", wordBreak: "break-all" },
							}, repo),
						),
						h("h3", null, t("welcome.bans")),
						h("p", null, t("welcome.ban1")),
						h("p", null, t("welcome.ban2")),
						h("p", null, t("welcome.ban3")),
					),
					h("div", { className: "dshp-auth-checks" },
						h("label", null,
							h("input", {
								type: "checkbox",
								checked: checked,
								onChange: (e) => setChecked(!!(e && e.target && e.target.checked)),
							}),
							h("span", null, t("welcome.check")),
						),
					),
					h("div", { className: "dshp-auth-ops" },
						h("button", {
							type: "button",
							className: "primary",
							disabled: !checked,
							onClick: () => {
								if (!checked) return;
								writeWelcomeAck();
								setOpen(false);
							},
						}, t("welcome.ok")),
					),
				),
			);
			// 不再走 portal：本组件注册在宿主的 shell.overlay 座位上，
			// 那个座位本身就是盖在整页之上的浮层容器，再 portal 一次只是把同一个节点
			// 从浮层里搬出来，反而让「谁盖谁」取决于插入顺序。
			return node;
		}
