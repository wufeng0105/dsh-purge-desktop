/**
lib/client-src/settings/ui.js — 设置页的设计原语。

## 为什么需要这一层

重构前每个分节各自发明版式：概览是四张卡片、补丁是自定义表格、技能是左右双栏、
危险区自带一个面板。三种字号、两种圆角、两种空态对齐方式挤在同一屏里，看起来像
三个不同产品拼接。原语收成一层之后，「一个分节长什么样」只在这里定义一次。

## 这套原语的依据

不是审美偏好，是从宿主自己的设置页反查出来的：`settings-general` 的内容区只有两种
结构 —— **发丝线分隔的行**（`border-bottom: .5px solid border-l2`）与**字段**
（label 13px/500 + 说明 12px 三级色）。它不用卡片、不用圆角容器、不用阴影。
跟着宿主走的好处不是「好看」，是明暗主题、字体缩放、密度偏好全都自动生效。

## 层级

1. 页面标题 18px/600 —— 只出现一次
2. 分节标题 13px/600 + 计数 + 右侧动作
3. 行：左标签（13px/500）右取值（12.5px），行间发丝线
4. 说明：12px，三级色

本文件只画东西，不取数、不判断业务。宿主原语可用时转调它，不可用时退回本插件样式。

例外只有一条，且仍然不取数：`AsyncBlock` 把 `useAsyncResource` 给的相位画成骨架 /
失败 + 重试 / 空态 / 内容。它拿的是别人取好的结果，自己不发起任何请求 —— 五个页签的
同一个读取失败之所以长得一模一样，靠的就是这一处。
 */

		/** 取宿主原语；宿主没这个包或没这个导出时返回 null。 */
		function nativeP(name) {
			return primOf(name);
		}

		/**
		 * 分节：标题行（标题 + 计数 + 右侧动作）+ 内容。
		 *
		 * 所有分节都必须经由它，这样「标题在哪、动作在哪、内容从哪开始」全页只有一个答案。
		 */
		function Section(props) {
			return h("section", { className: "dshp-section", id: props.id, "aria-labelledby": props.id ? props.id + "-title" : undefined },
				h("div", { className: "dshp-section__head" },
					h("h3", { className: "dshp-section__title", id: props.id ? props.id + "-title" : undefined }, props.title),
					props.count != null ? h("span", { className: "dshp-section__count" }, props.count) : null,
					h("span", { className: "dshp-section__gap" }),
					props.action || null,
				),
				props.hint ? h("p", { className: "dshp-section__hint" }, props.hint) : null,
				props.children,
			);
		}

		/** 行：左标签、右取值。行间由 CSS 画发丝线，行自己不带边框。 */
		function Row(props) {
			return h("div", { className: "dshp-row" },
				h("span", { className: "dshp-row__label" }, props.label),
				h("span", { className: "dshp-row__value" }, props.value),
			);
		}

		/**
		 * 字段：标签 + 控件 + 说明。控件放右侧还是换行由 `wide` 决定。
		 *
		 * `wide` 用于文本域、开关这类需要整行的控件；默认是「标签左、控件右」的一行。
		 */
		function Field(props) {
			return h("div", { className: "dshp-field" + (props.wide ? " is-wide" : "") },
				h("div", { className: "dshp-field__head" },
					h("span", { className: "dshp-field__label" }, props.label),
					props.wide ? null : (props.action || null),
				),
				props.wide ? props.children : null,
				props.hint ? h("p", { className: "dshp-field__hint" }, props.hint) : null,
				props.wide ? (props.action ? h("div", { className: "dshp-field__ops" }, props.action) : null) : null,
			);
		}

		/**
		 * 空态：左对齐的一行说明，不居中、不占固定高度。
		 *
		 * 居中空态在有内容的页面里会与行式排版打架：整页左对齐，中间突然冒出一块居中文字，
		 * 读起来像报错。空态就是「这一节现在没有条目」这一句话，跟其它行一样从左边起。
		 */
		function Empty(props) {
			return h("p", { className: "dshp-empty" },
				props.text,
				props.hint ? h("span", { className: "dshp-empty__hint" }, " · " + props.hint) : null,
			);
		}

		/** 说明行：正文级提示，三级色。 */
		function Hint(props) {
			return h("p", { className: "dshp-hint" }, props.children);
		}

		/** 行内结果提示：kind=idle 时不占位。 */
		function Note(props) {
			const notice = props.notice;
			if (!notice || notice.kind === "idle" || !notice.text) return null;
			return h("p", { className: "dshp-note " + (notice.kind === "error" ? "is-error" : "is-ok") }, notice.text);
		}

		/**
		 * 骨架高度只留三档：一档按几行键值、一档按一个分节、一档按两块叠起来的面。
		 *
		 * 原先五个页签各自写死 48 / 56 / 64 / 72 / 96 / 120 六个数值：相差十几像素肉眼
		 * 分不出来，但改一次「读取中」的长相要翻五个文件，而且没人能说清 64 与 72 为什么不同。
		 * 三档里的 56 / 96 / 120 是原先就有的取值（分别来自诊断尾部、状态与补丁页、健康块），
		 * 48 / 64 / 72 就近归到 56 与 96 —— 骨架只是占位，不承担「内容多高」的承诺。
		 */
		const SKEL_SM = 56;
		const SKEL_MD = 96;
		const SKEL_LG = 120;

		/**
		 * 读取失败的措辞表：键是端点名，值是这个端点失败时该说哪一句。
		 *
		 * 为什么收成一张表：同一个「读取失败」原先在四个文件里各写一份内联小函数
		 * （`err.status` 两份、`err.override` 一份、`audit.err` 两份、技能端点那份带
		 * 404 判定的），改一句措辞要翻四处，抄漏一处也没有症状 —— 页面上只是两条读起来
		 * 略不一样的失败提示。措辞的唯一出处是这张表，`AsyncBlock` 按 key 取。
		 *
		 * `miss` 只有技能端点有：老宿主的 `/dsh-purge/skills` 回 404 / 405（接口还没加载），
		 * 那不是「读坏了」而是「重启后可用」，措辞要换一句。这条判定落在表里，调用点不再各判。
		 */
		const ASYNC_ERROR_TEXT = {
			status: { key: "err.status" },
			override: { key: "err.override" },
			audit: { key: "audit.err" },
			skills: { key: "err.skills", miss: "err.skills.needRestart" },
		};

		/**
		 * 按端点名取失败文案。
		 *
		 * 缺省走 `status`：没写 `errorKey` 的调用点拿到的就是 `err.status` 那一句，
		 * 与收表之前 `AsyncBlock` 的默认行为一致。
		 */
		function asyncErrorText(t, errorKey, message) {
			const entry = ASYNC_ERROR_TEXT[errorKey] || ASYNC_ERROR_TEXT.status;
			const msg = String(message || "");
			if (entry.miss && skillsRouteMissing({ message: msg })) return t(entry.miss);
			return t(entry.key, { error: msg });
		}

		/**
		 * 只读取数的五态外壳：loading / ready / empty / error + retry。
		 *
		 * 为什么要有它：每个页签原先各写一套「骨架 + 失败提示 + 重试按钮」，三处措辞与
		 * 三个骨架高度都不一样，同一个读取失败在页面上长得像三件事。现在五种状态只在
		 * 这里各画一次，页签只回答三件事 —— 空态说什么（`empty`）、读到了画什么
		 * （children）、读失败时用哪一句（`errorKey`，见 `ASYNC_ERROR_TEXT`）。
		 *
		 * 只有读取走这五态：写入的结果归各自的 `busy` / `notice`，混进来一次保存失败就会
		 * 把已经取到的内容打成读取失败。
		 */
		function AsyncBlock(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const resource = props.resource || {};
			const phase = resource.phase || "loading";
			if (phase === "error") {
				const word = asyncErrorText(t, props.errorKey, String(resource.error || ""));
				return h("div", { className: "dshp-actions", style: { justifyContent: "flex-start" } },
					h("p", { className: "dshp-note is-error" }, word),
					h(ActionButton, { tiny: true, onClick: () => { if (resource.retry) resource.retry(); } }, t("btn.retry")),
				);
			}
			if (phase === "loading") {
				return h("div", { className: "dshp-skel", style: { height: props.height || SKEL_MD } });
			}
			if (phase === "empty") return props.empty || h(Empty, { text: t("load.empty") });
			return props.children;
		}

		/**
		 * 状态点：tone ∈ ok | idle | bad。
		 *
		 * 宿主 StateDot 的状态词只有 done / warning / error / idle / ongoing；传别的词不报错，
		 * 只会让圆点失去颜色，所以必须映射。
		 */
		function StatusDot(props) {
			const Dot = nativeP("StateDot");
			if (Dot) {
				const state = props.tone === "ok" ? "done" : props.tone === "bad" ? "error" : "idle";
				return h(Dot, { state: state, size: 8 });
			}
			const color = props.tone === "ok"
				? "var(--dsw-alias-state-success-primary, #3f9a63)"
				: props.tone === "bad"
					? "var(--dsw-alias-state-error-primary, #ef4444)"
					: "var(--dsw-alias-state-idle-primary, #94a3b8)";
			return h("i", {
				className: "dshp-dot",
				"aria-hidden": "true",
				style: { background: color, width: 8, height: 8, borderRadius: "50%", flex: "0 0 auto" },
			});
		}

		/**
		 * 动作按钮：转调宿主 Button（原生 variant / size / 焦点环）。
		 *
		 * 宿主 variant 只有 ghost / primary / outline / toolbar，没有 danger；
		 * 销毁类动作靠 className 交给本插件样式补 —— 宿主不给危险动作用专门的配色。
		 */
		function ActionButton(props) {
			const Button = nativeP("Button");
			if (Button) {
				return h(Button, {
					variant: props.primary ? "primary" : "outline",
					size: props.tiny ? "sm" : "md",
					className: props.danger ? "dshp-btn-danger" : undefined,
					disabled: props.disabled,
					onClick: props.onClick,
					title: props.title,
				}, props.children);
			}
			return h("button", {
				type: "button",
				className: "dshp-btn" + (props.primary ? " is-primary" : "") + (props.danger ? " is-danger" : "") + (props.tiny ? " is-tiny" : ""),
				disabled: props.disabled,
				onClick: props.onClick,
				title: props.title,
			}, props.children);
		}

		/** 可选展开的行头：一行一节，点开看明细。 */
		function DisclosureHead(props) {
			const Chevron = nativeP("IconChevronDownOutlineRegular");
			return h("button", {
				type: "button",
				className: "dshp-disc__head",
				"aria-expanded": props.open ? "true" : "false",
				"aria-controls": props.bodyId,
				onClick: props.onToggle,
			},
				props.leading || null,
				h("span", { className: "dshp-disc__title" }, props.title),
				props.meta ? h("span", { className: "dshp-disc__meta" }, props.meta) : null,
				h("span", { className: "dshp-disc__gap" }),
				Chevron
					? h(Chevron, { size: 14, className: "dshp-disc__chev" + (props.open ? " is-open" : "") })
					: h("span", { className: "dshp-disc__chev" + (props.open ? " is-open" : "") }, props.open ? "▾" : "▸"),
			);
		}
