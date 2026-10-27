/**
lib/client-src/settings/host.js — 重启流程（等待回执、桌面端掉线判定）。

为什么不再带主题探测与根组件：浮层删掉之后，清洗页由设置页座位直接渲染，
不再需要一个自己猜深浅色、自己盯 DOM 属性变化的根组件 —— 颜色改由宿主变量承担。
本文件不是 ES 模块，正文逐字节内联进 client.js。
 */

		function reopenAfterRestart() {
			window.location.reload();
		}

		/* 重启轮询链最长活 90 秒，且它的自然终点是 reload（成功）或超时。
			热替换装载新闭包后，旧闭包的链没有组件卸载点可挂 —— 与 dock/auth.js
			同理，用 window epoch 让旧闭包的 timer 与迟到回包自停。 */
		const RESTART_EPOCH = (window.__dshPurgeRestartEpoch = (window.__dshPurgeRestartEpoch || 0) + 1);
		const restartChainStale = () => RESTART_EPOCH !== window.__dshPurgeRestartEpoch;

		function waitForRestart(setNotice, setBusy, t) {
			const started = Date.now();
			// 必须先看到旧进程掉线，再等新进程就绪；否则同进程立刻 200 会被当成「重启成功」又弹重启。
			let sawDown = false;
			const ping = () => {
				if (restartChainStale()) return;
				fetch(apiUrl(PURGE_STATUS_PATH), { cache: "no-store", credentials: "same-origin" })
					.then((r) => (r.ok ? r.json() : Promise.reject()))
					.then((d) => {
						if (restartChainStale()) return;
						if (!sawDown) {
							retry();
							return;
						}
						if (d && d.ok && d.ready !== false) reopenAfterRestart();
						else retry();
					})
					.catch(() => {
						if (restartChainStale()) return;
						sawDown = true;
						retry();
					});
			};
			const retry = () => {
				if (restartChainStale()) return;
				if (Date.now() - started > 90000) {
					setNotice({ kind: "error", text: t("restart.timeout") });
					setBusy(false);
					return;
				}
				setTimeout(ping, 500);
			};
			setTimeout(ping, 800);
		}

		let restartOnce = false;

		function restartDsh(setNotice, setBusy, t, surface) {
			if (restartOnce) return;
			const surf = surface || clientGuessSurface() || "desktop";
			const desktop = surf === "desktop" || clientGuessSurface() === "desktop";
			restartOnce = true;
			setBusy(true);
			setNotice({ kind: "ok", text: hostText(t, "restarting", surf) });
			const stop = (error) => {
				restartOnce = false;
				setNotice({ kind: "error", text: error ? t("restart.fail", { error }) : t("restart.notStarted") });
				setBusy(false);
			};
			let sawDrop = false;
			const watch = setTimeout(() => {
				if (sawDrop) return;
				stop("");
			}, 25000);
			fetch("/dsh-purge/restart", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
				.then((r) => r.json())
				.then((d) => {
					if (!d.ok) throw new Error(d.error || "restart failed");
					const next = (d && d.surface) || surf;
					const full = next === "desktop" || (d && d.fullApp) || desktop;
					if (full && d.already) {
						setNotice({ kind: "ok", text: hostText(t, "restarting", next) });
						return;
					}
					if (full && d.restarting === false) {
						clearTimeout(watch);
						stop(d.error || "not started");
						return;
					}
					setNotice({ kind: "ok", text: hostText(t, "restarting", next) });
					if (full) return;
					clearTimeout(watch);
					restartOnce = false;
					waitForRestart(setNotice, setBusy, t);
				})
				.catch((e) => {
					const msg = String((e && e.message) || e || "");
					const dropped = /failed to fetch|networkerror|load failed/i.test(msg) || e.name === "TypeError";
					if (dropped && desktop) {
						sawDrop = true;
						clearTimeout(watch);
						return;
					}
					clearTimeout(watch);
					stop(msg || "restart failed");
				});
		}
