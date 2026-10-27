/**
lib/client-src/settings/patches-tab.js — 补丁页签：按服务端算好的 layerRows 逐层展开。

为什么不做分组：分组与「空层不渲染」在 lib/layer-rows.js 里已定死并有单测；
片段里再判一次，早晚会跟服务端判得不一样。这里只负责画与展开。

数据从页面传入，不自己请求：自己再取一次会让同一屏出现两套时刻不同的快照，
用户点开一层看到的计数可能与状态页签的摘要对不上，而且没人为这种不一致负责。
读取的四个相位（骨架 / 失败 + 重试 / 空态 / 内容）由 `AsyncBlock` 统一画，本文件只管内容。

版式用共用的 Section / DisclosureHead：标题行右侧给总数，每层一行、点开就地展开明细。
旧实现在这里自带面板与表格，与整页的行式排版不是一套。

## 分母

分节的数与摘要的数都是 `display` 口径（按展示行）：同一条清洗的升级链并成一行，
`na` 整条不出现。所以标题行下面注明「共 N 个展示行」—— 与「补丁号 66 条」不是一个
分母，不标名就会变成同屏两个都像真的数字。`raw` 口径只在诊断页的「判据口径」那一行出现。

从「设置页里的一节」改成页签时只换了外框：原来挂在分节上的锚点 id 去掉了 —— 页签壳
自己带面板 id，页内锚点导航已删；取数与渲染一行未动。

本文件不是 ES 模块，正文逐字节内联进 client.js。
*/

		function PatchesPanel(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const resource = props.resource || null;
			const state = resource && resource.data ? resource.data : null;
			const [open, setOpen] = useState({});
			const rows = state && Array.isArray(state.layerRows) ? state.layerRows : [];
			const total = state ? settingsInt(state.patches_total) : 0;

			return h(Section, {
				title: t("section.patches"),
				hint: state ? t("counts.denominator.display", { n: String(total) }) : null,
			},
				h(AsyncBlock, { t: t, resource: resource, height: SKEL_MD },
					rows.length === 0
						? h(Empty, { text: t("patch.empty"), hint: t("patch.empty.hint") })
						: h("div", { className: "dshp-list" },
							rows.map((row) => {
								const expanded = open[row.layer] === true;
								const bodyId = "dshp-layer-" + row.slug;
								/* 一层的 meta 只说这一层自己的数：已生效 / 总数，另加该层里「待应用」与
								   「按设计跳过」的条数。两个数分开列 —— 早先只有一个「跳过」，
								   而服务端把待应用也算进了跳过那一档（按色调判），同一屏于是两个跳过。 */
								const parts = [row.hit + " / " + row.total];
								if (row.pending > 0) parts.push(t("counts.pending") + " " + row.pending);
								if (row.skipped > 0) parts.push(t("counts.skipped") + " " + row.skipped);
								const meta = parts.join(" · ");
								return h("div", { className: "dshp-list__item", key: row.layer },
									h(DisclosureHead, {
										open: expanded,
										bodyId: bodyId,
										title: row.title,
										meta: meta,
										leading: h(StatusDot, { tone: row.tone }),
										onToggle: () => setOpen((prev) => ({ ...prev, [row.layer]: prev[row.layer] !== true })),
									}),
									expanded
										? h("div", { id: bodyId, className: "dshp-disc__body" },
											row.items.map((item) => h("div", { className: "dshp-disc__item", key: String(item.id) },
												h(StatusDot, { tone: item.tone }),
												h("span", { className: "dshp-disc__item-name" }, item.name),
												item.desc ? h("span", { className: "dshp-disc__item-note" }, item.desc) : null,
												item.reason ? h("span", { className: "dshp-disc__item-note" }, item.reason) : null,
												item.error ? h("span", { className: "dshp-disc__item-note" }, item.error) : null,
											)),
										)
										: null,
								);
							}),
						),
				),
			);
		}
