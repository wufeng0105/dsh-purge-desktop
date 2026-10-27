/**
 * lib/client-src/welcome-helpers.js — 用户须知的存储键与读写助手，单列以免重建时丢掉。
 * 用户须知（WelcomeNotice）的 localStorage 读写助手 + 它的存储键。
 *
 * ## 为什么这个文件存在
 *
 * 这段代码原本**只存在于生成物 client.js 里**，没有任何源文件：
 *   生成链的模板里没有它，lib/redteam/client.js 里也没有它。
 *
 * 所以它不是「改了源忘了同步」的漂移，而是**从未存在过的源**。任何人从源
 * 重建 client.js，它就消失，而 test/client-bundle.test.mjs 当时的探针
 * （只探 function Panel(）抓不到。
 *
 * ## 作用域约定（本文件不是 ES 模块，是生成时被内联的片段）
 *
 * 依赖 client.js 的闭包作用域：window。
 * 缩进刻意保持两个 tab，与注入点一致 —— 逐字节可复现是硬要求。
 */

		const WELCOME_KEY = "dsh-purge-user-notice-v1";
		function readWelcomeAck() {
			try { return window.localStorage.getItem(WELCOME_KEY) === "1"; } catch { return false; }
		}
		function writeWelcomeAck() {
			try { window.localStorage.setItem(WELCOME_KEY, "1"); } catch { /* ignore */ }
		}
