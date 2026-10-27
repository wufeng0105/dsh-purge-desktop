/**
lib/client-src/design/components.js — 原语层：按钮、字段、开关、徽章、状态点、空态、骨架、弹层

## 为什么单独一份

同一套原语在历史上被三代样式各写了一遍：按钮有 34px 高的一版与 28px 高的一版，
输入框既是「外框」又是「容器」，空态既居中又左对齐。它们落在同一份样式串里时，
后写的总是静默压过先写的那条，没人能一眼看出哪条在生效。原语收成一层之后，
「一个按钮长什么样」只在这里回答，布局片段只决定它摆在哪儿。

## 收录口径

只收能独立渲染的控件、容器原语与状态表达：按钮三层、字段与输入、开关、徽章、
状态点、空态、骨架、提示条、面板与折叠分组、弹层与浮层卡片。页面壳、行栅格、
页签栏、工具栏归布局层。
每个选择器只写一遍：同一选择器两代并存时取后写那份的取值，并把前写里没被同名属性覆盖的
声明一并带过来 —— 直接删掉另一份会连「本来在生效、只是没人覆盖」的声明一起删掉，那是改观感。
跨选择器的先后仍然是级联顺序，别在这里重排。
 */

		const PURGE_CSS_COMPONENTS = `.dshp-switch{display:inline-flex;border:1px solid var(--dshp-line);border-radius:999px;overflow:hidden;background:var(--dshp-paper)}
.dshp-switch button{appearance:none;border:0;background:transparent;color:var(--dshp-mute);font:12px/1 var(--dshp-sans);padding:6px 14px;cursor:pointer}
.dshp-switch button.is-on{background:var(--dshp-accent-soft);color:var(--dshp-ink)}
.dshp-switch button:focus-visible{outline:2px solid var(--dshp-accent);outline-offset:-2px}
.dshp-panel{border:1px solid var(--dshp-line);background:var(--dshp-paper);border-radius:10px;padding:18px 18px 16px}
.dshp-kicker{font-family:var(--dshp-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dshp-mute);margin:0 0 4px}
.dshp-group{border:1px solid var(--dshp-line);margin:0 0 8px;background:var(--dshp-bg);border-radius:8px;overflow:hidden}
.dshp-count{font-family:var(--dshp-mono);font-size:12px;color:var(--dshp-mute)}
.dshp-table{width:100%;border-collapse:collapse;font-size:12.5px}
.dshp-table th{text-align:left;font-weight:500;font-size:11px;letter-spacing:.06em;color:var(--dshp-mute);padding:7px 12px;border-bottom:1px solid var(--dshp-line)}
.dshp-table td{padding:8px 12px;border-bottom:1px solid var(--dshp-line);vertical-align:middle}
.dshp-table tr:last-child td{border-bottom:0}
.dshp-table tr.is-on td{background:var(--dshp-accent-soft)}
.dshp-id{font-family:var(--dshp-mono);opacity:.75;width:42px}
.dshp-field:focus,.dshp-area:focus{outline:none;border-color:var(--dshp-accent);box-shadow:0 0 0 3px var(--dshp-accent-soft)}
.dshp-field:disabled,.dshp-area:disabled{opacity:.5}
.dshp-restart-card .dshp-modal-ops{display:flex;justify-content:flex-end;gap:10px}
.dshp-restart-card .dshp-btn{min-height:38px;padding:0 16px;font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary,var(--dshp-c-text));background:var(--dsw-alias-bg-layer-2,var(--dshp-c-bg-card));border:1px solid var(--dsw-alias-border-l1,var(--dshp-c-border))}
.dshp-cwd-badge{font-family:var(--dshp-mono);font-size:10px;letter-spacing:.04em;text-transform:uppercase;padding:1px 7px;border-radius:99px;border:1px solid var(--dshp-line);color:var(--dshp-mute);line-height:1.6}
.dshp-auth-mask{position:fixed;inset:0;z-index:var(--dshp-z-auth);isolation:isolate;background:color-mix(in srgb, var(--dshp-c-scrim) 62%, transparent);display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:auto}
.dshp-env-gate{z-index:var(--dshp-z-gate)}
.dshp-auth-modal{width:min(680px,100%);max-height:min(88vh,820px);display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--dsw-alias-border-l1,var(--dshp-c-border));border-radius:12px;background:var(--dsw-alias-bg-layer-1,var(--dshp-c-bg-page));color:var(--dsw-alias-label-primary,var(--dshp-c-text-muted))}
.dshp-auth-modal h2{margin:0;font-size:16px;font-weight:600}
.dshp-auth-warn{padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dshp-c-warn) 16%,transparent);border:1px solid color-mix(in srgb,var(--dshp-c-warn) 42%,transparent);color:var(--dsw-alias-label-primary,var(--dshp-c-text));font-size:13px;line-height:1.55}
.dshp-auth-legal{overflow:auto;height:300px;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,var(--dshp-c-border));border-radius:8px;background:var(--dshp-c-bg-page);font-size:13px;line-height:1.55}
.dshp-auth-legal h3{margin:14px 0 4px;font-size:13px}
.dshp-auth-legal h3:first-child{margin-top:0}
.dshp-auth-legal p{margin:0 0 8px}
.dshp-auth-checks{display:flex;flex-direction:column;gap:8px;font-size:13px}
.dshp-auth-checks label{display:flex;gap:8px;align-items:flex-start}
.dshp-auth-checks label.locked{opacity:.45}
.dshp-auth-ops{display:flex;justify-content:flex-end;gap:8px}
.dshp-auth-ops button{appearance:none;border:1px solid var(--dsw-alias-border-l1,var(--dshp-c-border));background:transparent;color:inherit;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
.dshp-auth-ops button.primary{background:var(--dshp-c-bg-page);border-color:var(--dshp-c-border)}
.dshp-auth-ops button:disabled{opacity:.45;cursor:default}
.dshp-icon-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-border)) 45%,transparent);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:13px/1 inherit;white-space:nowrap;flex:0 0 auto}
.dshp-icon-btn:hover{border-color:var(--dsw-alias-brand-primary,var(--dshp-c-border));background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-bg-page)) 12%,transparent);color:var(--dsw-alias-label-primary,currentColor)}
.dshp-icon-btn.on{border-color:var(--dsw-alias-brand-primary,var(--dshp-c-border));color:var(--dsw-alias-brand-primary,var(--dshp-c-text-muted));background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-bg-page)) 16%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-bg-page)) 28%,transparent)}
.dshp-hbtn{appearance:none;display:inline-flex;flex:0 0 auto;align-items:center;gap:6px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-border)) 55%,transparent);background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:12px/1 inherit;padding:5px 10px;border-radius:8px;white-space:nowrap}
.dshp-hbtn:hover{border-color:var(--dsw-alias-brand-primary,var(--dshp-c-border));background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-bg-page)) 12%,transparent);color:var(--dsw-alias-label-primary,currentColor)}
.dshp-hbtn.on{border-color:var(--dsw-alias-brand-primary,var(--dshp-c-border));color:var(--dsw-alias-brand-primary,var(--dshp-c-text-muted));background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-bg-page)) 18%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-bg-page)) 32%,transparent)}
.dshp-tab-chip{display:inline-flex;align-items:flex-end;flex:0 0 auto}
.dshp-tab-btn{appearance:none;position:relative;border:none;background:transparent;cursor:pointer;padding:0 0 9px;font:500 13px/16px inherit;color:var(--dsw-alias-label-tertiary,currentColor);white-space:nowrap}
.dshp-tab-btn:hover{color:var(--dsw-alias-label-primary,currentColor)}
.dshp-tab-btn.on{color:var(--dsw-alias-brand-primary,var(--dshp-c-text-muted))}
.dshp-tab-btn.on:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,var(--dshp-c-bg-page))}
.dshp-badge{display:inline-flex;align-items:center;padding:1px 7px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#f4f1ea));color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted));font-size:11px;line-height:1.6;white-space:nowrap;font-variant-numeric:tabular-nums}
/* 字段：标签 + 控件 + 说明。wide 时控件换到下一行占满。 */
.dshp-field{box-sizing:border-box;font:13px/1.55 var(--dshp-mono);background:var(--dshp-bg);color:var(--dshp-ink);border:1px solid var(--dshp-line);border-radius:8px;width:auto;min-width:140px;display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border))}
.dshp-field:last-child{border-bottom:0}
.dshp-field__head{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}
.dshp-field__label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,var(--dshp-c-text))}
.dshp-field__hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted))}
.dshp-field__ops{display:flex;align-items:center;gap:8px;margin-top:2px}
/* 空态：左对齐的一行，不居中、不占固定高度。 */
.dshp-empty{padding:28px 12px;text-align:center;margin:8px 0 0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted))}
.dshp-empty__hint{color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted))}

/* 说明与结果提示 */
.dshp-hint{margin:6px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted))}
.dshp-note{display:block;margin:8px 0 0;font-size:12px;line-height:1.5}
.dshp-note.is-ok{color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}
.dshp-note.is-error{color:var(--dsw-alias-state-error-primary,var(--dshp-c-danger))}
.dshp-conclusion{margin:12px 0 0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}
.dshp-btn-danger{background:transparent;border-color:color-mix(in srgb,var(--dshp-bad) 40%,var(--dshp-line));color:var(--dsw-alias-state-error-primary,var(--dshp-c-danger))!important}
.dshp-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:28px;min-height:34px;padding:0 10px;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l3,var(--dshp-c-border));background:transparent;color:var(--dsw-alias-label-primary,var(--dshp-c-text));font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .15s var(--dshp-ease),opacity .15s var(--dshp-ease)}
.dshp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dshp-fill))}
.dshp-btn:disabled{opacity:.4;cursor:not-allowed}
.dshp-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dshp-accent));outline-offset:1px}
.dshp-btn.is-primary{background:var(--dsw-alias-button-primary-fill,var(--dshp-accent-soft));color:var(--dsw-alias-label-primary-foreground,var(--dshp-c-text));border-color:transparent}
.dshp-btn.is-danger{color:var(--dsw-alias-state-error-primary,var(--dshp-c-danger));border-color:var(--dsw-alias-border-l3,var(--dshp-c-border))}

/* 输入：与宿主 SettingsValueField 的输入同尺寸。 */
.dshp-input{box-sizing:border-box;width:100%;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l3,var(--dshp-c-border));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,transparent));color:var(--dsw-alias-label-primary,var(--dshp-c-text));font:inherit;font-size:12px;line-height:1.5}
.dshp-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,var(--dshp-accent))}
.dshp-area{box-sizing:border-box;width:100%;min-height:120px;padding:8px 10px;resize:vertical;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l3,var(--dshp-c-border));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,transparent));color:var(--dsw-alias-label-primary,var(--dshp-c-text));font:12.5px/1.6 var(--dshp-mono)}
.dshp-area:focus{outline:none;border-color:var(--dsw-alias-brand-primary,var(--dshp-accent))}

/* 骨架屏 */
.dshp-skel{height:12px;background-size:200% 100%;border-radius:var(--dsw-radius-sm,6px);background:var(--dshp-fill);animation:dshp-pulse 1.2s ease-in-out infinite}
.dshp-link{appearance:none;padding:0;border:0;background:none;color:var(--dsw-alias-label-primary,var(--dshp-c-text));font:inherit;font-size:12px;line-height:1.5;cursor:pointer;text-decoration:underline;text-underline-offset:2px;text-decoration-color:var(--dsw-alias-border-l2,var(--dshp-c-border))}
.dshp-link:hover{text-decoration-color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}
.dshp-link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dshp-accent));outline-offset:2px;border-radius:2px}
.dshp-dot{display:inline-block;flex:0 0 auto;border-radius:50%}
/* 模态：宿主之外唯一需要自带容器的场景。 */
.dshp-modal-bg{position:fixed;inset:0;z-index:var(--dshp-z-modal);isolation:isolate;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--dshp-c-scrim)}
.dshp-modal{width:min(420px,100%);display:flex;flex-direction:column;gap:12px;padding:20px;border:1px solid var(--dshp-line);border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-2,var(--dshp-c-bg-card));color:var(--dsw-alias-label-primary,var(--dshp-c-text));box-shadow:var(--dsw-elevation-prominent)}
.dshp-modal h4{margin:0;font-family:var(--dshp-display);font-size:15px;font-weight:600;line-height:1.5}
.dshp-modal p{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}
.dshp-modal-ops{display:flex;justify-content:flex-end;gap:8px}
.dshp-restart-mask{position:fixed;inset:0;z-index:var(--dshp-z-restart);isolation:isolate;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dshp-c-scrim);font-family:"Yu Gothic UI","Hiragino Sans GB","Source Han Sans SC","Microsoft YaHei UI",system-ui,sans-serif}
.dshp-restart-card{width:min(420px,100%);box-sizing:border-box;display:flex;flex-direction:column;gap:14px;padding:22px;border:1px solid var(--dsw-alias-border-l1,var(--dshp-c-border));border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-2,var(--dshp-c-bg-card));color:var(--dsw-alias-label-primary,var(--dshp-c-text));box-shadow:var(--dsw-elevation-prominent)}
.dshp-restart-card h4{margin:0;font-family:inherit;font-size:16px;font-weight:600;line-height:1.5;color:inherit}
.dshp-restart-card p{margin:0;font-size:13px;font-weight:500;line-height:1.6;color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}

/* 空态：左对齐、限宽（一行说明别拉满 1400px）、最多一个动作。路径不进正文。 */
.dshp-root--main .rt-empty,.rt-full .rt-empty{text-align:left;max-width:68ch;margin:0;padding:var(--dshp-sp-4) 0;font-size:var(--dshp-fs-body);line-height:1.7;color:var(--dsw-alias-label-secondary)}
.rt-empty__action{margin-top:var(--dshp-sp-3)}
.rt-empty__path{margin-top:var(--dshp-sp-2);font-family:var(--dshp-mono);font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
/* 「注意」块：替代原先的警告符号文案。带边框是为了和正文分开，不用彩色底。 */
.rt-caution{display:flex;gap:var(--dshp-sp-2);align-items:baseline;padding:var(--dshp-sp-3) var(--dshp-sp-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:var(--dshp-fs-meta);line-height:1.7;color:var(--dsw-alias-label-secondary)}
.rt-caution__label{flex:none;font-weight:600;color:var(--dsw-alias-state-warn-primary)}
/* 数据密集页的表格原语：发丝线分隔、不套卡片；列宽由 tableColumns 生成（表头/行/展开行同一份）。 */
.rt-grid{display:flex;flex-direction:column;min-width:0}
.rt-grid__head,.rt-grid__row{display:grid;gap:8px;align-items:center;height:32px;padding:0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.rt-grid__head{height:36px;border-bottom-color:var(--dsw-alias-border-l1)}
/* 数字列靠右对齐到单元格末端（列宽由列定义给，末列不吃剩余空间） */
.rt-grid__row .rt-grid__cell--num,.rt-grid__head .rt-grid__cell--num{justify-self:end}
.rt-grid__row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rt-grid__row.is-clickable{cursor:pointer}
.rt-grid__row:last-child{border-bottom:0}
.rt-grid__cell{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
.rt-grid__cell--head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary)}
.rt-grid__cell--num{font-family:var(--dshp-mono);font-variant-numeric:tabular-nums;text-align:right}
.rt-grid__extra{grid-column:1/-1;min-width:0;padding:2px 0 10px}
.rt-prose{max-width:68ch;line-height:1.65}
.rt-prose p,.rt-prose li{line-height:1.65}
.rt-prose code,.rt-prose pre{font-family:var(--dshp-mono);font-size:.92em}
.rt-prose pre,.rt-prose .rt-code{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px 10px;overflow:auto}
/* 选中态用强调色左边线，不用色块 */
.rt-seg.on,.rt-item.on,.rt-sess.on{border-left:2px solid var(--dsw-alias-brand-primary)}
/* 字段：标签在上，控件与提示同一条基线 */
.rt-field{display:flex;flex-direction:column;gap:var(--dshp-sp-2);min-width:0}
.rt-field__label{font-size:var(--dshp-fs-meta);font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-field__row{display:flex;align-items:center;gap:var(--dshp-sp-2);flex-wrap:wrap;min-width:0}
.rt-field__hint{font-size:var(--dshp-fs-meta);color:var(--dsw-alias-label-tertiary)}
.rt-field__err{font-size:var(--dshp-fs-meta);color:var(--dsw-alias-state-error-primary)}
/* 状态行：状态点 + 名称 + 现状 + 右侧动作 */
.rt-status{display:flex;flex-direction:column}
.rt-status__row{display:flex;align-items:center;gap:var(--dshp-sp-2);padding:var(--dshp-sp-2) 0;border-bottom:1px solid var(--dsw-alias-border-l2);min-width:0}
.rt-status__row:last-child{border-bottom:0}
.rt-status__dot{flex:none;width:8px;height:8px;border-radius:50%}
.rt-status__dot--ok{background:var(--dsw-alias-state-success-primary)}
.rt-status__dot--warn{background:var(--dsw-alias-state-warn-primary)}
.rt-status__dot--idle{background:var(--dsw-alias-state-idle-primary)}
.rt-status__name{flex:none;font-size:var(--dshp-fs-body);font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-status__detail{flex:1 1 auto;min-width:0;font-size:var(--dshp-fs-meta);color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-status__action{flex:none}
/* 徽章三档：只用宿主语义状态 token，不自己造色名 */
.rt-badge{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:11px;line-height:1.6;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.rt-badge--ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);color:var(--dsw-alias-state-success-primary)}
.rt-badge--warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);color:var(--dsw-alias-state-warn-primary)}
.rt-badge--idle{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
/* ── 按钮三层（主区）─────────────────────────────────────────────────
   一屏只该有一个主操作；底色取自 accent token 与页面底色混合 —— 主题的 accent 接近黑，
   直接铺就是两个黑块（刷新 + 保存）平级。这里把它压到「有颜色但不是纯黑」，层级靠
   底色/边框/无边框三层区分，而不是靠谁更黑。 */
.dshp-root--main .rt-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:34px;padding:0 14px;border-radius:8px;font-size:var(--dshp-fs-body);font-weight:500;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.dshp-root--main .rt-btn:hover{border-color:var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.dshp-root--main .rt-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshp-root--main .rt-btn:disabled{opacity:.45;cursor:default;background:transparent}
.dshp-root--main .rt-btn.rt-btn-primary{border-color:transparent;font-weight:600;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-bg-layer-1)}
.dshp-root--main .rt-btn.rt-btn-primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 84%,var(--dsw-alias-bg-layer-1))}
/* 文字操作：无边框、无底色，hover 才有一层很浅的底 */
.dshp-root--main .rt-btn.rt-btn-text{border-color:transparent;background:transparent;padding:0 8px;color:var(--dsw-alias-label-secondary)}
.dshp-root--main .rt-btn.rt-btn-text:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-primary)}
`;
