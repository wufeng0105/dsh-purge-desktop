/**
lib/client-src/settings/p1-section.js — 只负责把设置页挂到宿主座位上。

为什么薄：页面结构在 page.js，原语在 ui.js，分节各自成文件。
这里多一行，都会让「座位注册」和「页面实现」互相牵制。
 */

		function PurgeSettingsSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			translate = t;
			return h(SettingsPage, { t });
		}
