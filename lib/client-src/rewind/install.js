/**
lib/client-src/rewind/install.js — installRewindUi：把回溯按钮挂到宿主座位。

本文件不是 ES 模块，正文逐字节内联进 client.js。
 */

		function installRewindUi(ctx) {
			rewindHost = ctx;
			rewindSessions = ctx.sessions;
			rewindWorkspace = ctx.uiWorkspace || null;
			rewindConversation = ctx.conversation || null;
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-purge-rewind",
				order: 20,
				inject: (sessionId) => ({
					sessionId,
					t: ctx.locale.bind(NS),
				}),
			}, RewindSafe));
			ctx.effect(() => installRewindWatch(ctx), "dsh-purge: rewind watch");
		}
