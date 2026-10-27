/**
lib/client-src/main/drill-copy.js — 演练台文案的极简内联渲染器：只认粗体与行内代码。

## 为什么需要它

`lib/client-src/i18n.js` 里有一批 `drill.*` 文案带 Markdown 风格的强调标记（`**这么写**`、
`` `这么写` ``）。它们原先被当纯文本塞进节点，于是界面上直接出现裸星号与裸反引号 ——
「同一靶标**同时最多 3 个执行智能体**」这种句子看起来像坏了。

渲染器只做两件事，别的一概不管：**粗体**与`行内代码`。不引 Markdown 库（本仓库零前端依赖），
也不认链接/列表/标题 —— 文案是我们自己写的，多一种语法就多一处没人维护的边角。

## 顺序是判据，不是风格

**先转义 `&`、`<`、`>`，再做替换**。反过来（先替换再转义）会把 `<strong>` 自己转义掉，
更糟的是 `<script>` 会以标签形态进 DOM。转义在这一层做，所以调用方拿到的是安全的 HTML 字符串；
`RichCopy` 用 `dangerouslySetInnerHTML` 挂上去是安全的，安全边界就在这个函数的第一个语句。

## 为什么在 client-src 而不是 lib/redteam

渲染器是**界面**的事，不认识演练台的任何数据；放在外壳片段里，浮动窗与主区两种形态共用同一份，
也不会因为演练台自己拆文件而跟着搬家。它由 `function` 声明引入闭包，装配顺序不影响调用
（函数声明提升），所以占位符位置只按可读性排。
 */

		/** 文案 → HTML 字符串：先转义，再把 `代码` 与 **粗体** 换成标签。 */
		function copyToHtml(text) {
			const escaped = String(text === undefined || text === null ? "" : text)
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
			return escaped
				.replace(/`([^`]+)`/g, (match, code) => "<code>" + code + "</code>")
				.replace(/\*\*([^*]+)\*\*/g, (match, bold) => "<strong>" + bold + "</strong>");
		}

		/**
		 * 一行带轻标记的文案。
		 *
		 * `className` 用来挂版式（例如注意块、说明行），渲染器本身不管样式。
		 */
		function RichCopy(props) {
			const cls = props && props.className ? props.className : "";
			return h("span", {
				className: cls === "" ? "rt-copy" : "rt-copy " + cls,
				dangerouslySetInnerHTML: { __html: copyToHtml(props && props.text) },
			});
		}
