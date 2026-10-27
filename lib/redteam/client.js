/**
 * lib/redteam/client.js — 演练台浏览器侧的手写 bundle，由构建脚本抽成工厂片段。
 * 演练台 —— 浏览器侧（手写 bundle）
 *
 * 格式与外壳的模块加载器一致：window.__ModuleLoader__.load({ id, factory })。
 * 源文件由 scripts/build-client.mjs 抽成工厂片段，嵌进根目录 client.js（id: dsh-purge）。
 * 本文件不再作为独立浏览器模块加载；id 仅作源码占位，便于 build 脚本定位 factory。
 * 基座外无依赖：只用平台 seed 里的 react 与 ctx.slots。
 */
window.__ModuleLoader__.load({
  id: 'dsh-purge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /*
     * 演练台自己是一块浮动窗：position:fixed，用 left/top/width/height 放。
     * 不给官方 frame 加 padding，不改官方输入框的宽度。嵌在清洗面板里时走 .rt-embedded。
     */
    const CSS = `
.rt-dock{position:fixed;top:12px;right:12px;z-index:20;display:flex;flex-direction:column;box-sizing:border-box;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dshp-c-bg-page)) 52%,transparent);
  backdrop-filter:blur(20px) saturate(1.3);-webkit-backdrop-filter:blur(20px) saturate(1.3);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,var(--dshp-c-border)) 70%,transparent);
  border-radius:12px;
  box-shadow:0 18px 48px color-mix(in srgb,var(--dshp-c-bg-page) 28%,transparent);pointer-events:auto;color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.5}
.rt-dock.rt-embedded{position:relative;inset:auto;width:100%;height:100%;max-width:none;border:0;border-radius:0;box-shadow:none;background:transparent!important;backdrop-filter:none;-webkit-backdrop-filter:none}
.rt-grip,.rt-resize-r,.rt-resize-b,.rt-resize-c{position:absolute;z-index:3;touch-action:none}
.rt-grip{left:-3px;top:0;bottom:0;width:8px;cursor:ew-resize;background:transparent}
.rt-resize-r{right:-3px;top:0;bottom:14px;width:8px;cursor:ew-resize}
.rt-resize-b{left:8px;right:14px;bottom:-3px;height:8px;cursor:ns-resize}
.rt-resize-c{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize}
.rt-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-title{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px;white-space:nowrap}
.rt-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.rt-spacer{flex:1}
.rt-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;
  border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.rt-btn:hover{border-color:var(--dsw-alias-border-l2)}
.rt-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dshp-c-text-muted)}
.rt-btn-primary:hover{opacity:.9}
.rt-btn:disabled{opacity:.5;cursor:default}
.rt-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:6px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-tab{padding:8px 10px 7px;border-radius:0;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary);
  display:inline-flex;align-items:center;gap:5px;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent}
.rt-tab:hover{color:var(--dsw-alias-label-primary)}
.rt-tab.on{color:var(--dsw-alias-label-primary);background:transparent;font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,var(--dshp-c-border))}
/* 未读红点：该页签有新内容（新资产/新漏洞/新得分/新步骤…），点开看过就消失 */
.rt-tab-dot{width:7px;height:7px;border-radius:50%;background:var(--dshp-c-bg-card);flex:none;
  box-shadow:0 0 0 2px color-mix(in srgb, var(--dshp-c-bg-card) 22%, transparent)}
.rt-body{flex:1;min-height:0;display:flex;flex-direction:column}
.rt-split{flex:1;min-height:0;display:flex}
.rt-side{width:200px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.rt-seg{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-seg:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-seg.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-seg-cidr{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.rt-seg-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-toolbar{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;align-items:center}
.rt-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:inherit;
  border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;outline:none;min-width:0}
.rt-input:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-input option,.rt-eng-select option{background:var(--dsw-alias-bg-layer-1,var(--dshp-c-bg-page));color:var(--dsw-alias-label-primary,var(--dshp-c-text-muted))}
.rt-eng-select{color:var(--dsw-alias-label-primary,var(--dshp-c-text-muted));background:var(--dsw-alias-bg-layer-2,var(--dshp-c-bg-page))}
.rt-table{flex:1;overflow:auto}
.rt-row{display:grid;grid-template-columns:150px 74px 104px 1.15fr 1fr;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;cursor:pointer;font-size:12.5px}
.rt-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;position:sticky;top:0;
  background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-row.head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-mono{font-family:ui-monospace,Menlo,monospace}
.rt-tag{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;margin-right:4px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-tag-passive{color:var(--dshp-c-accent);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-accent) 10%, transparent)}
.rt-tag-active{color:var(--dshp-c-warn);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-warn) 10%, transparent)}
.rt-tag-live{color:var(--dshp-c-brand);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-brand) 10%, transparent)}
.rt-tag-warn{color:var(--dshp-c-danger);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-danger) 10%, transparent)}
/* 纪律提示条：不满足交付要求（非冰蝎/哥斯拉马、没有 suo5 隧道）时顶在区块最上方 */
.rt-hint{border-radius:6px;padding:7px 9px;margin-bottom:8px;font-size:11.5px;line-height:1.6;
  border:1px dashed color-mix(in srgb, var(--dshp-c-border) 53%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 6%, transparent);color:var(--dsw-alias-label-primary)}
.rt-hint b{color:var(--dshp-c-text-muted)}
.rt-tag-dead{color:var(--dsw-alias-label-secondary)}
.rt-expand{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-kv{display:flex;gap:8px;margin-bottom:3px;align-items:baseline}
.rt-kv b{color:var(--dsw-alias-label-primary);font-weight:600;min-width:64px;flex:none}
/* 图谱视图已移除（见 AssetsTab：资产关系由「域名维度」与 redteam_attack_path 工具承担） */
.rt-pane{flex:1;min-height:0;overflow:auto;padding:12px}
.rt-card{border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,var(--dshp-c-border)) 75%,transparent);border-radius:8px;padding:10px;margin-bottom:10px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,var(--dshp-c-bg-page)) 48%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.rt-card h4{margin:0 0 6px;font-size:13px}
.rt-textarea{width:100%;min-height:260px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);
  color:inherit;border-radius:6px;padding:8px;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;
  line-height:1.6;resize:vertical;outline:none;box-sizing:border-box}
.rt-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-list{width:210px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-item{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-item:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-item.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-item-name{font-weight:600;font-size:12.5px}
.rt-item-desc{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.rt-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 10px}
.rt-foot{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;
  color:var(--dsw-alias-label-secondary);display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.rt-icon-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:inherit;border-radius:6px;padding:6px 8px;cursor:pointer;font-family:inherit;font-size:12.5px}
.rt-icon-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-icon-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-hbtn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;border-radius:6px;
  padding:2px 8px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px}
.rt-hbtn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-hbtn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-test{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-test-testing{color:var(--dshp-c-text);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
.rt-test-tested{color:var(--dshp-c-text);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
.rt-test-blocked{color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-card);border-color:var(--dshp-c-border)}
.rt-test-abandoned{color:var(--dshp-c-text-muted);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
.rt-test-no_surface{color:var(--dshp-c-text-muted);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
.rt-scope-testing{color:var(--dshp-c-text);background:var(--dshp-c-bg-card)}
.rt-pri{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap}
.rt-pri-high{color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-card)}
.rt-pri-medium{color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-page)}
.rt-pri-low{color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-card)}
.rt-score-row{display:grid;grid-template-columns:16px 62px minmax(0,1fr) 116px 66px;gap:8px;padding:7px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-score-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-score-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-score-detail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
/* 得分目标按合并版的 8 个类别分组：类别头 + 组内按分值升序 */
.rt-score-group{display:flex;align-items:center;gap:8px;padding:7px 10px 5px;margin-top:2px;
  font-size:12px;font-weight:600;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.rt-score-group:first-child{border-top:none}
.rt-score-group .rt-sg-sub{font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary)}
/* ── 会话与入口：每张卡片分「标题行 / 关键事实 / 可用命令 / 备注」四段，避免一行糊在一起 ── */
.rt-sess-facts{display:flex;flex-direction:column;gap:2px;margin-top:5px}
.rt-sess-fact{display:flex;gap:6px;font-size:11.5px;line-height:1.5}
.rt-sess-fact>b{flex:none;min-width:62px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-sess-fact>span{min-width:0;overflow-wrap:anywhere}
.rt-sess-cmd{margin-top:6px}
.rt-sess-cmd>b{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px;font-weight:600}
.rt-sess-fold{margin-top:6px;font-size:11.5px}
.rt-sess-fold>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);user-select:none}
.rt-sess-fold>summary:hover{color:var(--dsw-alias-label-primary)}
.rt-score-row .rt-scope{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rt-score-form{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}
.rt-score-form input,.rt-score-form select{width:100%;box-sizing:border-box}
.rt-vrow{display:grid;grid-template-columns:62px minmax(0,1fr) 132px 108px 74px 52px;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-vrow:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-vrow.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-vdetail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-vdetail .rt-kv{margin-bottom:4px}
.rt-actions{display:flex;gap:6px;margin-top:6px}
.rt-section{padding:8px 10px 2px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-link{color:var(--dsw-alias-brand-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-link:hover{text-decoration:underline}
.rt-full{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;
  border-top:3px solid var(--dsw-alias-brand-primary)}
.rt-full .rt-head{padding:12px 18px}
.rt-full .rt-tabs{padding:10px 18px 0;gap:6px;flex-wrap:wrap}
.rt-full .rt-side{width:260px}
.rt-full .rt-list{width:280px}
.rt-full .rt-row{grid-template-columns:190px 90px 130px 1.4fr 1.2fr}
.rt-full .rt-vrow{grid-template-columns:80px minmax(0,1.6fr) 200px 150px 90px 64px}
.rt-full .rt-pane{padding:18px}
.rt-full .rt-textarea{min-height:60vh}
.rt-full .rt-foot{padding:10px 18px;font-size:12px}
.rt-full .rt-body{max-width:1400px;width:100%;margin:0 auto;flex:1;min-height:0;display:flex;flex-direction:column}
.rt-chain{flex:1;overflow:auto;padding:10px 12px}
.rt-step{display:flex;gap:10px;padding:8px 6px;border-left:2px solid var(--dsw-alias-border-l1);margin-left:6px}
.rt-step:last-child{border-left-color:transparent}
.rt-step-dot{width:22px;height:22px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-page);margin-left:-13px}
.rt-step-body{min-width:0}
.rt-step-title{font-weight:600;font-size:13px}
.rt-step-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-word}
.rt-stage-recon{background:var(--dshp-c-info)}
.rt-stage-vuln{background:var(--dshp-c-warn)}
.rt-stage-exploit{background:var(--dshp-c-danger)}
.rt-stage-access{background:var(--dshp-c-brand)}
.rt-stage-pivot{background:var(--dshp-c-accent)}
.rt-stage-data{background:var(--dshp-c-info)}
.rt-stage-other{background:var(--dshp-c-bg-page)}
.rt-step-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.rt-step-time{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto;white-space:nowrap}
.rt-step-detail{font-size:12px;margin-top:5px;white-space:pre-wrap;word-break:break-word;
  border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 2px 9px;line-height:1.6}
.rt-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:1px 7px;border-radius:5px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);margin:4px 5px 0 0;max-width:100%}
.rt-chip>i{font-style:normal;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.rt-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.rt-stage-tag{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;color:var(--dshp-c-text-muted);font-weight:600}
.rt-st-recon{background:var(--dshp-c-bg-card)}.rt-st-vuln{background:var(--dshp-c-bg-page)}.rt-st-exploit{background:var(--dshp-c-bg-card)}
.rt-st-access{background:var(--dshp-c-bg-page)}.rt-st-pivot{background:var(--dshp-c-bg-card)}.rt-st-data{background:var(--dshp-c-bg-page)}.rt-st-other{background:var(--dshp-c-bg-page)}
.rt-sev{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;border:1px solid transparent}
.rt-sev-critical{color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-page)}.rt-sev-high{color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-card)}
.rt-sev-medium{color:var(--dshp-c-text);background:var(--dshp-c-bg-card)}.rt-sev-low{color:var(--dshp-c-text);background:var(--dshp-c-bg-card)}
.rt-sev-info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.rt-dot-on{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dshp-c-bg-page);box-shadow:0 0 0 3px color-mix(in srgb, var(--dshp-c-scrim) 20%, transparent)}
.rt-dot-off{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dshp-c-bg-card);box-shadow:0 0 0 3px color-mix(in srgb, var(--dshp-c-scrim) 20%, transparent)}
.rt-dot-unk{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dshp-c-bg-card);box-shadow:0 0 0 3px color-mix(in srgb, var(--dshp-c-scrim) 20%, transparent)}
.rt-sess-grid{display:grid;grid-template-columns:1fr;gap:8px;padding:10px 12px}
.rt-sess{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;background:var(--dsw-alias-bg-layer-2)}
.rt-sess-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-sess-title{font-weight:600;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
.rt-sess-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-code{font-family:ui-monospace,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 5px;cursor:pointer;word-break:break-all}
.rt-code:hover{border-color:var(--dsw-alias-brand-primary)}
.rt-evi{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;margin-top:8px}
.rt-evi-head{display:flex;align-items:center;gap:8px;padding:5px 9px;background:var(--dsw-alias-bg-layer-2);
  font-size:11.5px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-evi-body{margin:0;padding:9px 11px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;
  white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-base)}
.rt-evi-body.req{max-height:220px}
.rt-hl-req{color:var(--dshp-c-text);font-weight:600}
.rt-hl-res{color:var(--dshp-c-text);font-weight:600}
.rt-gain{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:12px;
  color:var(--dshp-c-text);background:var(--dshp-c-bg-card);border:1px solid color-mix(in srgb, var(--dshp-c-border) 33%, transparent)}
.rt-total{font-size:20px;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.rt-sidehead{padding:7px 8px 2px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);
  display:flex;align-items:center;gap:5px}
.rt-sidehead-btn{cursor:pointer;outline:none;padding:6px 6px 5px;border-radius:5px;user-select:none}
.rt-sidehead-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-sidehead-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-scope{display:inline-block;padding:0 4px;border-radius:3px;font-size:10px;font-weight:700;line-height:15px;flex:none}
.rt-scope-internal{color:var(--dshp-c-text);background:var(--dshp-c-bg-card)}
.rt-scope-external{color:var(--dshp-c-text);background:var(--dshp-c-bg-card)}
.rt-hits{display:flex;flex-direction:column;gap:6px;margin-top:7px}
.rt-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border);border-radius:6px;
  padding:7px 9px;background:var(--dsw-alias-bg-layer-2)}
.rt-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-hit-idx{width:16px;height:16px;border-radius:50%;background:var(--dshp-c-bg-page);color:var(--dshp-c-text-muted);font-size:10.5px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-hit-target{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12px;word-break:break-all}
.rt-hit-time{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-hit-evi{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:6px 8px;margin-top:5px}
.rt-hit-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.rt-cred{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border);border-radius:6px;
  padding:8px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:7px}
.rt-cred-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-cred-host{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-secret{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;background:var(--dshp-c-bg-card);color:var(--dshp-c-text);
  border:1px solid color-mix(in srgb, var(--dshp-c-border) 40%, transparent);border-radius:5px;padding:6px 9px;margin-top:6px;white-space:pre-wrap;word-break:break-all;
  user-select:all;cursor:text}
.rt-secret-none{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-state-error-primary);
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 9px;margin-top:6px}
.rt-cred-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:5px;word-break:break-word}
.rt-stage-score{background:var(--dshp-c-brand)}
.rt-counted{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;color:var(--dshp-c-text);background:var(--dshp-c-bg-card);border:1px solid color-mix(in srgb, var(--dshp-c-border) 33%, transparent);border-radius:9px;padding:0 7px}
.rt-scorepts{font-size:11.5px;font-weight:700;color:var(--dshp-c-brand);background:var(--dshp-c-brand);border:1px solid color-mix(in srgb, var(--dshp-c-border) 33%, transparent);
  border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-livebar{display:flex;align-items:center;gap:7px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-live-dot{width:8px;height:8px;border-radius:50%;background:var(--dshp-c-bg-page);flex:none;animation:rt-pulse 1.6s ease-in-out infinite}
.rt-live-dot.idle{background:var(--dshp-c-bg-card);animation:none}
@keyframes rt-pulse{{0%,100%opacity:1;box-shadow:0 0 0 0 color-mix(in srgb, var(--dshp-c-scrim) 40%, transparent)}{50%opacity:.5;box-shadow:0 0 0 5px color-mix(in srgb, var(--dshp-c-scrim) 0%, transparent)}}
.rt-live-body{padding:8px 12px 2px;max-height:44vh;overflow:auto}
.rt-atest{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border);border-radius:6px;
  padding:7px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:6px}
.rt-atest.past{border-left-color:var(--dshp-c-border);opacity:.85}
.rt-atest-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-atest-ip{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-atest-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-atest-notes{font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:4px;padding:5px 7px;margin-top:4px;max-height:76px;overflow:auto}
.rt-concl{display:flex;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-concl-i{display:inline-flex;align-items:baseline;gap:4px;padding:2px 8px;border-radius:6px;cursor:pointer;
  border:1px solid transparent}
.rt-concl-i:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i.on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i b{font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:700}
.rt-concl-i>span{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.rt-more{color:var(--dsw-alias-brand-primary);font-size:11.5px;cursor:pointer;user-select:none;margin-top:4px;display:inline-block}
.rt-more:hover{text-decoration:underline}
.rt-subtabs{display:flex;gap:4px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center}
.rt-subtab{padding:4px 10px;border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-subtab.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}
.rt-sevbar{width:3px;border-radius:2px;align-self:stretch;flex:none;margin-right:2px}
/* ── 折叠层次体系 ─────────────────────────────────────────────────────────────
   L1 折叠头 .rt-sec   ：通栏、无圆角无边框、左色条、深底 —— 永远是dt('drill.d1')的
   L2 内容卡 .rt-atest/.rt-hit/.rt-cred/.rt-evi：内缩、有边框、圆角 —— 立起来
   L3 详情/长文本 .rt-clip-body / .rt-evi-body ：无边框、最浅、等宽
   L4 子项容器 .rt-sec-body：左缩进 + 竖引导线，表明dt('drill.d2')
   ──────────────────────────────────────────────────────────────────────────── */
.rt-sec-wrap{margin:0}
.rt-sec{display:flex;align-items:center;gap:8px;padding:7px 12px 7px 9px;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-border-l2);
  border-top:1px solid var(--dsw-alias-border-l1);user-select:none;outline:none}
.rt-sec:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-sec:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-sec.flat{cursor:default}
.rt-sec.flat:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-sec-caret{flex:none;width:11px;font-size:10px;color:var(--dsw-alias-label-secondary);text-align:center}
.rt-sec-title{font-weight:600;font-size:13px;white-space:nowrap}
.rt-sec-count{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-sec-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-sec-right{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.rt-sec.t-stage{border-left-color:var(--dshp-c-border)}
.rt-sec.t-target{border-left-color:var(--dshp-c-border)}
.rt-sec.t-folder{border-left-color:var(--dshp-c-border)}
.rt-sec.t-test{border-left-color:var(--dshp-c-border)}
.rt-sec.t-queue{border-left-color:var(--dshp-c-border)}
.rt-sec.t-past{border-left-color:var(--dshp-c-border)}
.rt-sec-body{margin-left:12px;border-left:1px solid var(--dsw-alias-border-l1);padding:7px 0 3px 10px}
.rt-sec-body>.rt-atest:last-child,.rt-sec-body>.rt-hit:last-child{margin-bottom:2px}
/* 长文本折叠（L3）：默认预览 2 行并渐隐，展开后限高滚动 */
.rt-clip{margin-top:6px}
.rt-clip-head{display:flex;align-items:center;gap:6px}
.rt-clip-label{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:600}
.rt-clip-body{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:5px;padding:6px 8px;margin-top:3px}
.rt-clip:not(.open) .rt-clip-body{max-height:46px;overflow:hidden;
  -webkit-mask-image:linear-gradient(180deg,var(--dshp-c-text) 55%,transparent);mask-image:linear-gradient(180deg,var(--dshp-c-text) 55%,transparent)}
.rt-clip.open .rt-clip-body{max-height:340px;overflow:auto}
.rt-flow{padding:10px 12px 16px}
.rt-flow-start,.rt-flow-end{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:4px 0}
.rt-flow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-flow-link{display:flex;align-items:center;gap:8px;padding:3px 0 3px 10px}
.rt-flow-arrow{color:var(--dsw-alias-border-l2);font-size:11px;flex:none}
.rt-flow-action{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-action.inferred{opacity:.7;font-style:italic}
.rt-flow-node{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border);border-radius:8px;
  padding:8px 11px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-flow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-flow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-flow-node.overflow{border-left-color:var(--dshp-c-border);opacity:.75}
.rt-flow-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-flow-idx{width:18px;height:18px;border-radius:50%;background:var(--dshp-c-bg-page);color:var(--dshp-c-text-muted);font-size:11px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-flow-node.overflow .rt-flow-idx{background:var(--dshp-c-bg-card)}
.rt-flow-name{font-weight:600;font-size:13px}
.rt-flow-pts{margin-left:auto;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;font-weight:700;color:var(--dshp-c-text);
  background:var(--dshp-c-bg-card);border:1px solid color-mix(in srgb, var(--dshp-c-border) 33%, transparent);border-radius:10px;padding:0 8px;white-space:nowrap}
.rt-flow-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-flow-times{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-flow-target{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;margin-top:4px;word-break:break-all;
  color:var(--dsw-alias-label-secondary)}
.rt-flow-gain{font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-detail{margin-top:7px;padding-top:7px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-hflow-wrap{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
.rt-hflow{display:flex;align-items:center;gap:0;padding:16px 12px;overflow-x:auto;flex-wrap:nowrap}
.rt-hflow-item{display:flex;align-items:center;flex:none}
.rt-hflow-start,.rt-hflow-end{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding:0 4px}
.rt-hflow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-hflow-arrow{color:var(--dsw-alias-border-l2);padding:0 5px;font-size:13px;flex:none}
.rt-hflow-node{display:flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);
  border-left:3px solid var(--dshp-c-border);border-radius:7px;padding:5px 8px;background:var(--dsw-alias-bg-layer-2);
  cursor:pointer;white-space:nowrap;outline:none}
.rt-hflow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-hflow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-hflow-node.overflow{border-left-color:var(--dshp-c-border);opacity:.72}
.rt-hflow-node.open{border-color:var(--dsw-alias-brand-primary)}
.rt-hflow-pts{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:700;color:var(--dshp-c-text);background:var(--dshp-c-bg-card);
  border-radius:8px;padding:0 6px}
.rt-hflow-node.overflow .rt-hflow-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.rt-hflow-name{font-size:11.5px}
.rt-hflow-n{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rt-rep-list{padding:10px 12px 14px}
.rt-rep-tools{display:flex;gap:6px;justify-content:flex-end;margin-bottom:8px}
.rt-rep{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border);border-radius:8px;
  padding:9px 11px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-2)}
.rt-rep-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-rep-idx{font-size:15px;color:var(--dshp-c-text);font-weight:700;flex:none}
.rt-rep-name{font-weight:600;font-size:13px}
.rt-rep-meta{font-size:12px;margin-top:4px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.rt-rep-meta b{color:var(--dsw-alias-label-primary);font-weight:600;margin-right:2px}
.rt-rep-missing{font-size:11.5px;color:var(--dsw-alias-state-error-primary);margin-top:6px;
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 8px}
.rt-rep-req{margin-top:7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden}
.rt-rep-req-head{display:flex;align-items:center;gap:7px;padding:4px 8px;font-size:11.5px;font-weight:600;
  background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-rep-http{margin:0;padding:8px 10px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-base)}
/* ── 报告里的「这一步怎么来的」：动作步骤 / 命令 / 凭据 / 隧道 ───────────── */
.rt-rep-trace{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:8px 10px;
  background:var(--dsw-alias-bg-base)}
.rt-rep-trace-head{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.rt-rep-trace-title{font-weight:600;font-size:12.5px}
.rt-rep-trace-how{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.rt-rep-step{border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 6px 9px;margin-bottom:6px}
.rt-rep-step-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rt-rep-step-no{width:17px;height:17px;border-radius:50%;background:var(--dsw-alias-brand-primary);color:var(--dshp-c-text-muted);
  font-size:10.5px;display:flex;align-items:center;justify-content:center;flex:none}
.rt-rep-step-title{font-weight:600;font-size:12.5px}
.rt-rep-step-detail{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-rep-step-cmd{font-size:11.5px;margin-top:4px;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap}
.rt-rep-step-cmd .rt-mono{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);
  border-radius:5px;padding:2px 6px;word-break:break-all}
.rt-rep-step-result{font-size:11.5px;margin-top:3px;word-break:break-word}
.rt-rep-src{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-rep-src-title{font-weight:600;font-size:12px;margin-bottom:3px}
/* ── 全链路攻击路径图 ─────────────────────────────────────────────── */
.rt-ap{padding:10px 12px 18px;overflow:auto}
.rt-ap-stage{margin-bottom:2px}
.rt-ap-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-left:4px solid var(--dshp-c-border);border-top:1px solid var(--dsw-alias-border-l1);border-radius:6px 6px 0 0}
.rt-ap-no{width:20px;height:20px;border-radius:5px;color:var(--dshp-c-text-muted);font-size:11px;font-weight:700;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-ap-name{font-weight:700;font-size:13.5px}
.rt-ap-en{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:.3px}
.rt-ap-phase{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-goal{display:flex;align-items:baseline;gap:8px;padding:6px 10px 6px 9px;font-size:12px;
  border-left:4px solid var(--dshp-c-border);background:var(--dsw-alias-bg-layer-1)}
.rt-ap-goal-tag{font-size:10.5px;font-weight:700;border:1px solid;border-radius:4px;padding:0 5px;white-space:nowrap;flex:none}
.rt-ap-result{padding:7px 10px 3px;border-left:4px solid transparent}
.rt-ap-result-head{display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap}
.rt-ap-pts{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:700;color:var(--dshp-c-text);background:var(--dshp-c-bg-card);
  border:1px solid color-mix(in srgb, var(--dshp-c-border) 33%, transparent);border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-ap-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
/* 按服务封顶/自建而不计分的命中：分值标灰（+0），避免看着像又加了分 */
.rt-ap-pts.uncounted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-ap-nth{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border);border-radius:6px;
  padding:6px 9px;margin-bottom:5px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-ap-hit:hover{border-color:var(--dsw-alias-border-l2)}
.rt-ap-hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-ap-hit.overflow{border-left-color:var(--dshp-c-border);opacity:.75}
.rt-ap-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-ap-hit-name{font-weight:600;font-size:12.5px}
.rt-ap-hit-target{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);
  margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}
.rt-ap-act{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.rt-ap-act.inferred{font-style:italic;opacity:.75}
.rt-ap-none{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:2px 0 4px}
.rt-ap-trans{display:flex;align-items:center;gap:7px;padding:2px 0 2px 14px}
.rt-ap-trans-t{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 横向路径图 */
.rt-ap-h{display:flex;align-items:stretch;padding:10px 12px 14px;overflow-x:auto;flex:1;min-height:0}
.rt-ap-col{display:flex;align-items:stretch;flex:none}
.rt-ap-col-arrow{align-self:center;color:var(--dsw-alias-border-l2);padding:0 6px;font-size:12px;flex:none}
.rt-hcol{width:228px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);
  border-top:3px solid var(--dshp-c-border);border-radius:7px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.rt-hcol-goal{font-size:11px;color:var(--dsw-alias-label-secondary);padding:5px 8px;line-height:1.45;
  border-bottom:1px solid var(--dsw-alias-border-l1);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-hcol-body{padding:6px 8px;flex:1;min-height:0;overflow:auto}
.rt-hcol-hit{display:flex;align-items:center;gap:5px;font-size:11px;margin-bottom:3px}
.rt-hcol-hit.off{opacity:.6}
.rt-hcol-pts{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;font-weight:700;color:var(--dshp-c-text);background:var(--dshp-c-bg-card);
  border-radius:7px;padding:0 5px;flex:none}
.rt-hcol-hit.off .rt-hcol-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.rt-hcol-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-hcol-none{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-hcol-secs{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}
.rt-hcol-sec{font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);
  border-radius:4px;padding:0 4px}
.rt-hcol-attck{font-family:ui-monospace,Menlo,monospace;font-size:9.5px;color:var(--dsw-alias-label-secondary);
  padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-ap-cum{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-sub{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:6px 0 3px}
.rt-ap-assets,.rt-ap-tunnels{display:flex;flex-direction:column;gap:3px}
.rt-ap-asset{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 6px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.rt-ap-tunnel{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border)}
.rt-hcol-sub{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;gap:5px;align-items:center}
.rt-hcol-sub.off{opacity:.6}
.rt-hit-row{display:flex;flex-wrap:wrap;align-items:center;gap:2px 7px;font-size:11.5px;padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
/* 资产与内容都自适应换行：长域名/长口令/长结果一律换行显示，不截断成省略号 */
.rt-hit-asset{font-family:ui-monospace,Menlo,monospace;font-weight:600;flex:0 1 auto;max-width:100%;
  overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt{flex:1 1 100%;color:var(--dsw-alias-label-primary);line-height:1.55;
  white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt.none{color:var(--dsw-alias-state-error-primary)}
.rt-hit-row .rt-hit-time{flex:none;margin-left:auto}
/* 自己注册/自建的账号：留痕但不计分，整行压暗 */
.rt-hit-row.self-created{opacity:.72;border-left:3px solid color-mix(in srgb, var(--dshp-c-border) 53%, transparent)}
/* 同一资产同一端口的重复账号/库权限：服务已拿满，不计分（只作留痕） */
.rt-hit-row.service-capped{opacity:.72;border-left:3px solid color-mix(in srgb, var(--dshp-c-border) 53%, transparent)}
.rt-hit-row.service-capped .rt-hit-idx{background:var(--dshp-c-bg-page)}
.rt-rep-group{margin-bottom:14px}
.rt-rep-stage{display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:7px;
  background:var(--dsw-alias-bg-layer-2);border-left:4px solid var(--dshp-c-border);border-radius:6px;
  cursor:pointer;outline:none;user-select:none}
.rt-rep-stage:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-rep-stage:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-rep-no{width:20px;height:20px;border-radius:5px;color:var(--dshp-c-text-muted);font-size:11px;font-weight:700;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-rep-stage-name{font-weight:700;font-size:13px}
.rt-rep-stage-n{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 折叠后仍要能一眼看到"这一阶段拿了多少分"，所以分数留在头上 */
.rt-rep-pts{font-size:11px;font-weight:600;padding:1px 6px;border-radius:5px;border:1px solid transparent;flex:none}
.rt-rep-body{padding-left:6px}
/* ── 知识库（POC/EXP） ──────────────────────────────────────────── */
.rt-kb-filter{display:flex;align-items:center;gap:7px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 知识库归类总览：一行标签，点一下按该类筛选 */
.rt-kb-cats{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 知识库分组标题（按归类分组时每组一条） */
.rt-kb-cat{display:flex;align-items:center;gap:7px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-bottom:1px solid var(--dsw-alias-border-l1);position:sticky;top:0;z-index:1}
.rt-kb-cat-name{font-weight:600;font-size:12.5px}
/* 技能可用性徽章（技能库页签） */
.rt-avail{display:inline-block;padding:0 5px;border-radius:4px;font-size:10.5px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-avail-available{color:var(--dshp-c-text);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
.rt-avail-broken{color:var(--dshp-c-text-muted);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
.rt-avail-unknown{color:var(--dshp-c-text-muted);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
/* 版本 / 更新弹窗 */
.rt-modal{position:fixed;inset:0;z-index:200;background:color-mix(in srgb, var(--dshp-c-scrim) 45%, transparent);display:flex;align-items:center;justify-content:center}
.rt-modal-box{width:min(560px,92vw);max-height:80vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;font-size:12.5px;line-height:1.7;
  box-shadow:0 18px 48px color-mix(in srgb, var(--dshp-c-scrim) 35%, transparent);color:var(--dsw-alias-label-primary)}
.rt-modal-box .rt-kv b{min-width:76px}
.rt-kb-check{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}
.rt-kb{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;margin:0 0 8px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2)}
.rt-kb.open{border-color:var(--dsw-alias-brand-primary)}
.rt-kb-head{display:flex;align-items:center;gap:7px;padding:7px 9px;cursor:pointer;outline:none;flex-wrap:wrap}
.rt-kb-head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-kb-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-kb-title{font-weight:600;font-size:12.5px;overflow-wrap:anywhere}
.rt-kb-kind{font-size:10px;font-weight:700;letter-spacing:.4px;padding:1px 5px;border-radius:4px;
  color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-page);flex:none}
.rt-kb-kind.k-exp{background:var(--dshp-c-bg-card)}
.rt-kb-kind.k-poc{background:var(--dshp-c-bg-page)}
.rt-kb-kind.k-template{background:var(--dshp-c-bg-card)}
.rt-kb-kind.k-script{background:var(--dshp-c-bg-page)}
.rt-kb-kind.k-payload{background:var(--dshp-c-bg-page)}
.rt-kb-sub{font-size:11px;color:var(--dsw-alias-label-secondary);padding:0 9px 7px;overflow-wrap:anywhere}
.rt-kb-body{padding:0 9px 9px}
.rt-kb-actions{display:flex;gap:6px;margin:7px 0}
.rt-kb-body .rt-kv span{overflow-wrap:anywhere;word-break:break-word}
/* 本机 nuclei 模板命中：路径要能完整看到（复制成命令直接跑） */
.rt-kb-tpl{margin-top:12px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px}
.rt-kb-tpl-row{display:flex;align-items:center;gap:7px;font-size:11.5px;padding:3px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
.rt-kb-tpl-path{flex:0 1 auto;font-weight:600;overflow-wrap:anywhere}
.rt-kb-tpl-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rt-md{flex:1;overflow:auto;margin:0;padding:14px 16px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;
  line-height:1.65;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-base)}
.rt-weblink{display:block;font-size:11.5px;margin-top:1px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-shots{margin:8px 0 4px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;
  background:var(--dsw-alias-bg-layer-1)}
.rt-shots-head{display:flex;align-items:baseline;gap:8px;font-size:11.5px;margin-bottom:6px}
.rt-shots-n{color:var(--dsw-alias-label-secondary)}
.rt-shot-row{display:flex;gap:8px;flex-wrap:wrap}
.rt-shot{display:flex;flex-direction:column;gap:3px;max-width:220px}
.rt-shot-thumb{border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dshp-c-bg-page);
  object-fit:contain;display:block;width:auto;max-width:216px}
.rt-shot-loading{display:flex;align-items:center;justify-content:center;width:150px;font-size:11px;
  color:var(--dsw-alias-label-secondary)}
.rt-shot-cap{display:flex;align-items:center;gap:5px;font-size:10.5px;overflow-wrap:anywhere}
.rt-shot-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.rt-shot-zoom{position:fixed;inset:0;z-index:9999;background:color-mix(in srgb, var(--dshp-c-scrim) 82%, transparent);display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:10px;cursor:zoom-out;padding:18px}
.rt-shot-zoom img{max-width:96vw;max-height:86vh;border-radius:6px;box-shadow:0 18px 48px color-mix(in srgb, var(--dshp-c-scrim) 50%, transparent)}
.rt-shot-zoom-cap{color:var(--dshp-c-text-muted);font-size:12px;text-align:center;max-width:90vw;overflow-wrap:anywhere}`    /* ---------------------------------------------------------- 桥接与状态 */
    /** 是否在「全面浏览」独立窗口里（URL hash 标记，复用同一套界面代码）。 */
    const isFullWindow = () => {
      try { return String(window.location.hash || '') === '#redteam-full' } catch { return false }
    }

    /* 非 2xx / 非 JSON 响应（宿主 502、网关错误页、代理拦截）必须变成结构化失败，
       不能靠 res.json() 直接抛 SyntaxError —— 那让调用方的 catch 只拿到
       "Unexpected token <"，看不出状态码。这里把状态码与正文前 120 字带出来。 */
    /* 打开本地目录：只传语义 kind，路径由服务端算（白名单在 /dsh-purge/open）。 */
    const openDir = (kind) => fetch('/dsh-purge/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind }),
    }).then((res) => res.json()).catch(() => ({ ok: false }))

    const api = (req) => fetch('/redteam/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    }).then(async (res) => {
      const text = await res.text().catch(() => '')
      let data = null
      try { data = text ? JSON.parse(text) : null } catch {
        return { ok: false, error: res.status + ' non-json: ' + String(text).slice(0, 120) }
      }
      if (!res.ok) {
        return Object.assign({}, data || {}, {
          ok: false,
          error: (data && (data.error || data.message)) || (res.status + ' ' + res.statusText),
        })
      }
      return data
    })

    let ui = { open: true, tab: 'assets' }
    const subs = new Set()
    const setUI = (patch) => {
      ui = Object.assign({}, ui, patch)
      const snap = Object.assign({}, ui)
      for (const f of Array.from(subs)) {
        try { f(snap) } catch { /* ignore subscriber errors */ }
      }
    }
    /* 保留导出。面板尺寸只写在自己的元素上，不再改官方 frame 的宽度。 */
    let dockWidthTag = null
    const setDockWidth = () => {}
    const useUI = () => {
      const [st, setSt] = React.useState(() => Object.assign({}, ui))
      React.useEffect(() => {
        const f = (snap) => setSt(Object.assign({}, snap || ui))
        subs.add(f)
        setSt(Object.assign({}, ui))
        return () => { subs.delete(f) }
      }, [])
      return st
    }

    /* 知识库归类（与 core.js 的 POC_CATEGORIES 一致；面板按它分组） */
    const POC_CAT_NAME = {
      rce: dt('drill.d3'), deserialization: dt('drill.d4'), 'file-upload': dt('drill.d5'),
      sqli: dt('drill.d6'), unauthorized: dt('drill.d7'), 'auth-bypass': dt('drill.d8'),
      'weak-password': dt('drill.d9'), ssrf: 'SSRF', xxe: 'XXE',
      'path-traversal': dt('drill.d10'), 'info-leak': dt('drill.d11'),
      privesc: dt('drill.d12'), tunnel: dt('drill.d13'), other: dt('drill.d14'),
    }
    const POC_CAT_ORDER = Object.keys(POC_CAT_NAME)
    /* 角色 code → 中文（报告/知识库都要标"谁发现的"） */
    const ROLE_LABEL = {
      plan: dt('drill.d15'), recon: dt('drill.d16'), assess: dt('drill.d17'),
      'vuln-scan': dt('drill.d18'), exploit: dt('drill.d19'), internal: dt('drill.d20'),
    }

    const fmt = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—')
    const shotCache = new Map()
    const shotLoading = new Map()
    const shotSrc = (eng, id) => shotCache.get(eng + ':' + id) || null
    const loadShot = (eng, id) => {
      const key = eng + ':' + id
      if (shotCache.has(key) || shotLoading.has(key)) return
      const p = api({ op: 'shotData', engagement: eng, id: id }).then((r) => {
        shotCache.set(key, r && r.base64 ? 'data:' + (r.mime || 'image/png') + ';base64,' + r.base64 : '')
        shotLoading.delete(key)
        const snap = Object.assign({}, ui)
        for (const f of Array.from(subs)) {
          try { f(snap) } catch { /* ignore subscriber errors */ }
        }
      }).catch(() => { shotLoading.delete(key) })
      shotLoading.set(key, p)
    }
    const SHOT_KIND = { screenshot: dt('drill.d21'), card: dt('drill.d22') }
    const ShotImage = ({ eng, shot, height }) => {
      const [zoom, setZoom] = React.useState(false)
      const src = shotSrc(eng, shot.id)
      if (src === null) { loadShot(eng, shot.id); }
      const card = shot.kind === 'card'
      return h('div', { className: 'rt-shot' },
        src === null
          ? h('div', { className: 'rt-shot-thumb rt-shot-loading', style: { height: (height || 96) + 'px' } }, dt('drill.d23'))
          : h('img', {
              className: 'rt-shot-thumb', src: src, alt: shot.label || (dt('drill.d24') + shot.id),
              style: { height: (height || 96) + 'px', cursor: 'zoom-in' },
              onClick: () => setZoom(true),
            }),
        h('div', { className: 'rt-shot-cap' },
          h('span', { className: 'rt-tag ' + (card ? 'rt-tag-warn' : 'rt-tag-live'), title: card
            ? dt('drill.d25')
            : dt('drill.d21') }, SHOT_KIND[shot.kind] || shot.kind || dt('drill.d26')),
          h('span', { className: 'rt-shot-label', title: shot.label || shot.note || '' },
            shot.label || shot.target || ('#' + shot.id))),
        zoom
          ? h('div', { className: 'rt-shot-zoom', onClick: () => setZoom(false) },
              h('img', { src: src, alt: shot.label || '' }),
              h('div', { className: 'rt-shot-zoom-cap' }, (shot.label || shot.target || '')
                + (card ? [dt('drill.k30001')] : '')
                + (shot.captured_at ? '　·　' + fmt(shot.captured_at) : '')
                + dt('drill.d27')))
          : null)
    }
    const ShotStrip = ({ eng, shots, total, title }) => {
      const list = shots || []
      if (list.length === 0) return null
      return h('div', { className: 'rt-shots' },
        h('div', { className: 'rt-shots-head' },
          h('b', null, title || dt('drill.d28')),
          h('span', { className: 'rt-shots-n' }, dt('drill.d29') + list.length + dt('drill.d30')
            + (total && total > list.length ? dt('drill.d31') + total + [dt('drill.k30002')] : ''))),
        h('div', { className: 'rt-shot-row' }, list.map((sh) => h(ShotImage, { key: 'sh' + sh.id, eng: eng, shot: sh }))))
    }
    /** 发现时间在列表里只留「月-日 时:分」：整行宽度紧张，完整时间进悬浮提示 */
    const fmtShort = (s) => {
      const t = String(s || '').replace('T', ' ')
      return t.length >= 16 ? t.slice(5, 16) : (t || '—')
    }
    const provLabel = (p) => (p === 'passive' ? [dt('drill.k30003')] : p === 'active' ? [dt('drill.k30004')] : dt('drill.d32'))

    /**
     * 给「可点击但不是 <button>」的元素补上键盘可达性，返回可直接展开进 props 的对象。
     *
     * 为什么需要：面板里大量用 div/span 当按钮（表格行、页签、结论条、C 段条目…），
     * 它们鼠标能点、键盘完全够不着 —— 而这类元素此前有 16 处是各写各的，
     * 写法还不一致（有的只有 role、有的漏了 Space 键）。
     * 统一到一个工厂后，新增可点击元素只要 `...clickable(fn, { label })` 就有完整语义。
     *
     * 注意：**不要**用它包真正的 `<button>`（原生按钮自带全部语义）。
     * @param onActivate - 激活回调（鼠标点击 / Enter / Space 都走它）。
     * @param options - `{ label?, expanded? }`：label 进 aria-label，expanded 进 aria-expanded。
     * @returns props 片段：role / tabIndex / onClick / onKeyDown / aria-*
     */
    const clickable = (onActivate, options = {}) => {
      const props = {
        role: 'button',
        tabIndex: 0,
        onClick: onActivate,
        onKeyDown: (e) => {
          /* Enter 与 Space 是按钮的标准激活键；Space 还要阻止页面滚动 */
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onActivate(e)
          }
        },
      }
      if (options.label !== undefined) props['aria-label'] = String(options.label)
      if (options.expanded !== undefined) props['aria-expanded'] = options.expanded ? 'true' : 'false'
      return props
    }

    /**
     * 复制文本到剪贴板，**返回真实的成功与否**。
     *
     * clipboard API 在非安全上下文（http + 非 localhost）、页面失焦、权限被拒时都会
     * 返回被拒绝的 Promise —— 同步 try/catch 抓不到，于是界面会显示"已复制"而剪贴板是空的。
     * 这里 await 真实结果，并在不可用时退回 execCommand('copy')（老浏览器/非安全上下文仍可用）。
     * @param text - 要复制的文本。
     * @returns Promise<boolean>
     */
    const copyText = async (text) => {
      const value = text === undefined || text === null ? '' : String(text)
      if (value === '') return false
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch (e) { /* 落到下面的兜底方案 */ }
      /* 兜底：临时 textarea + execCommand —— 非安全上下文里唯一还能用的办法 */
      try {
        const ta = document.createElement('textarea')
        ta.value = value
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        const okFlag = document.execCommand('copy')
        document.body.removeChild(ta)
        return okFlag === true
      } catch (e) { return false }
    }

    /**
     * 复制并给出**如实**的界面反馈（成功/失败文案统一）。
     * @param text - 要复制的文本。
     * @param label - 成功时提示里显示的名字。
     * @param onResult - 可选回调：`(ok, message) => void`；不传时返回 Promise<boolean>。
     */
    const copyWithFeedback = async (text, label, onResult) => {
      const okFlag = await copyText(text)
      const message = okFlag ? dt('drill.d33') + label : dt('drill.d34')
      if (typeof onResult === 'function') onResult(okFlag, message)
      return okFlag
    }

    function ProvTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, dt('drill.d32'))
      return h('span', { className: 'rt-tag rt-tag-' + props.p }, provLabel(props.p))
    }

    const TEST_LABEL = { untested: dt('drill.d35'), testing: dt('drill.d36'), tested: dt('drill.d37'), blocked: dt('drill.d38'), abandoned: dt('drill.d39'), no_surface: dt('drill.d40') }
    const PRI_LABEL = { high: dt('drill.d41'), medium: dt('drill.d42'), low: dt('drill.d43') }

    /** 资产易打性徽章。 */
    function PriTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, dt('drill.d44'))
      return h('span', { className: 'rt-pri rt-pri-' + props.p, title: props.title || '' }, PRI_LABEL[props.p] || props.p)
    }

    /** 资产测试状态徽章。 */
    function TestTag(props) {
      const st = props.s || 'untested'
      return h('span', { className: 'rt-test rt-test-' + st }, TEST_LABEL[st] || st)
    }

    /* ---------------------------------------------------------- 资产测绘 */
    function AssetsTab(props) {
      const eng = props.engagement
      const snapshot = props.snapshot
      const refreshKey = props.refreshKey || 0
      const onRefresh = props.onRefresh
      const [view, setView] = React.useState('list')
      const [cidr, setCidr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [service, setService] = React.useState('')
      const [port, setPort] = React.useState('')
      const [prov, setProv] = React.useState('')
      const [testStatus, setTestStatus] = React.useState('')
      const [priority, setPriority] = React.useState('')
      const [scope, setScope] = React.useState('')
      const [assetState, setAssetState] = React.useState('')
      const [sort, setSort] = React.useState('priority')
      const [showAll, setShowAll] = React.useState(null)
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [] })
      const [domains, setDomains] = React.useState(null)
      const [web, setWeb] = React.useState(null)
      const [openId, setOpenId] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      /* 左侧「外网 C 段 / 内网 C 段」两组各自折叠，状态按靶标记住 */
      const sideCollapse = useCollapse('assets-side:' + eng)
      const seq = React.useRef(0)
      const onData = props.onData

      React.useEffect(() => {
        if (!eng) return
        const my = ++seq.current
        setState((s) => Object.assign({}, s, { loading: true, error: null }))
        api({
          op: 'assets', engagement: eng, cidr: cidr || undefined, q: qApplied || undefined,
          service: service || undefined, port: port || undefined,
          provenance: prov || undefined, test_status: testStatus || undefined,
          priority: priority || undefined, scope: scope || undefined,
          state: assetState || undefined, sort: sort, limit: 400,
        }).then((r) => {
          if (my !== seq.current) return
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || dt('drill.d45'), total: 0, items: [] })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [] })
          /* C 段/统计可能因本轮采集新增：让外层重新拉一次快照，左侧分类立即更新 */
          if (onData) onData()
        }, (e) => {
          if (my === seq.current) setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [] })
        })
      }, [eng, cidr, qApplied, service, port, prov, testStatus, priority, scope, assetState, sort, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'domain') return
        setDomains(null)
        api({ op: 'domains', engagement: eng, cidr: cidr || undefined })
          .then((r) => setDomains((r && r.items) || []), () => setDomains([]))
      }, [eng, view, cidr, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'web') return
        setWeb(null)
        api({ op: 'web', engagement: eng, cidr: cidr || undefined })
          .then((r) => setWeb((r && r.items) || []), () => setWeb([]))
      }, [eng, view, cidr, refreshKey])


      const toggleRow = (id) => {
        if (openId === id) { setOpenId(null); setDetail(null); return }
        setOpenId(id)
        setDetail(null)
        api({ op: 'asset', engagement: eng, id: id }).then((r) => {
          if (r && r.ok && r.asset) setDetail(r.asset)
        }, () => {})
      }

      const segs = (snapshot && snapshot.segments) || []

      const sideChildren = []
      sideChildren.push(h('div', Object.assign({
        key: 'all', className: 'rt-seg' + (cidr === null && view !== 'testing' ? ' on' : ''),
      }, clickable(() => { setView('list'); setCidr(null) }, { label: dt('drill.d46'), expanded: cidr === null && view !== 'testing' })),
        h('div', { className: 'rt-seg-cidr' }, dt('drill.d46')),
        h('div', { className: 'rt-seg-meta' }, segs.length + dt('drill.d47'))))
      sideChildren.push(h('div', Object.assign({
        key: 'testing', className: 'rt-seg' + (view === 'testing' ? ' on' : ''),
        title: dt('drill.d48'),
      }, clickable(() => { setView('testing'); setCidr(null) }, { label: dt('drill.d49'), expanded: view === 'testing' })),
        h('div', { className: 'rt-seg-cidr', style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
          h('span', { className: 'rt-scope rt-scope-testing', title: dt('drill.d50') }, dt('drill.d51')),
          h('span', { style: { flex: 1 } }, dt('drill.d49'))),
        h('div', { className: 'rt-seg-meta' }, dt('drill.d52'))))
      /* C 段按内外网分组：先外网（互联网可达，通常是入口）再内网（打进去之后才看得到） */
      const segBlock = (title, list, kind) => {
        /* 外网 / 内网两组各自可折叠（状态按靶标记住），默认展开 */
        const open = sideCollapse.isOpen('scope:' + kind, true)
        const toggle = sideCollapse.toggle('scope:' + kind, true)
        const out = [h('div', {
          key: 'h' + kind, className: 'rt-sidehead rt-sidehead-btn',
          role: 'button', tabIndex: 0, 'aria-expanded': open ? 'true' : 'false',
          title: (open ? [dt('drill.k30005')] : dt('drill.d53')) + dt('drill.d54'),
          onClick: () => { setView('list'); toggle() },
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView('list'); toggle(e) } },
        },
          h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
          h('span', { className: 'rt-scope rt-scope-' + kind }, kind === 'internal' ? [dt('drill.k30006')] : dt('drill.d55')),
          h('span', null, title + ' · ' + list.length + dt('drill.d56')),
          h('span', { className: 'rt-spacer' }),
          h('span', { style: { fontWeight: 400 } }, list.reduce((n, x) => n + (x.assets || 0), 0) + dt('drill.d57')))]
        if (!open) return out
        for (const s of list) {
          /* 一段一行：只给 C 段 + 资产数（端口数不再占位，归属与存活放进悬浮提示） */
          out.push(h('div', Object.assign({
            key: s.cidr, className: 'rt-seg' + (cidr === s.cidr ? ' on' : ''),
            title: (s.org || dt('drill.d58')) + dt('drill.d59') + (s.live || 0) + '/' + (s.assets || 0) + dt('drill.d60'),
          }, clickable(() => { setView('list'); setCidr(s.cidr) },
            { label: dt('drill.d61') + s.cidr, expanded: cidr === s.cidr && view !== 'testing' })),
            h('div', { className: 'rt-seg-cidr', style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
              h('span', { className: 'rt-scope rt-scope-' + kind }, kind === 'internal' ? [dt('drill.k30007')] : dt('drill.d62')),
              h('span', { style: { flex: 1 } }, s.cidr),
              h('span', { className: 'rt-seg-meta', style: { margin: 0, whiteSpace: 'nowrap' } },
                s.assets + dt('drill.d60')))))
        }
        return out
      }
      const segExternal = segs.filter((x) => x.scope !== 'internal')
      const segInternal = segs.filter((x) => x.scope === 'internal')
      if (segExternal.length) sideChildren.push(...segBlock(dt('drill.d63'), segExternal, 'external'))
      if (segInternal.length) sideChildren.push(...segBlock(dt('drill.d64'), segInternal, 'internal'))
      const side = h('div', { className: 'rt-side' }, sideChildren)

      const toolbar = h('div', { className: 'rt-toolbar' },
        h('input', {
          className: 'rt-input', style: { flex: '1 1 150px' }, placeholder: dt('drill.d65'),
          value: q, onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') setQApplied(q) },
        }),
        h('button', { className: 'rt-btn', onClick: () => setQApplied(q) }, dt('drill.d66')),
        h('input', {
          className: 'rt-input', style: { width: '78px' }, placeholder: dt('drill.d67'),
          value: service, onChange: (e) => setService(e.target.value),
        }),
        h('input', {
          className: 'rt-input', style: { width: '60px' }, placeholder: dt('drill.d68'),
          value: port, onChange: (e) => setPort(e.target.value),
        }),
        h('select', { className: 'rt-input', value: scope, onChange: (e) => setScope(e.target.value) },
          h('option', { value: '' }, dt('drill.d69')),
          h('option', { value: 'external' }, dt('drill.d70')),
          h('option', { value: 'internal' }, dt('drill.d71'))),
        h('select', { className: 'rt-input', value: prov, onChange: (e) => setProv(e.target.value), title: dt('drill.d72') },
          h('option', { value: '' }, dt('drill.d73')),
          h('option', { value: 'passive' }, dt('drill.d74')),
          h('option', { value: 'active' }, dt('drill.d75'))),
        h('select', { className: 'rt-input', value: priority, onChange: (e) => setPriority(e.target.value) },
          h('option', { value: '' }, dt('drill.d76')),
          h('option', { value: 'high' }, dt('drill.d77')),
          h('option', { value: 'medium' }, dt('drill.d78')),
          h('option', { value: 'low' }, dt('drill.d79'))),
        h('select', { className: 'rt-input', value: testStatus, onChange: (e) => setTestStatus(e.target.value) },
          h('option', { value: '' }, dt('drill.d80')),
          h('option', { value: 'untested' }, dt('drill.d35')),
          h('option', { value: 'testing' }, dt('drill.d36')),
          h('option', { value: 'tested' }, dt('drill.d37')),
          h('option', { value: 'blocked' }, dt('drill.d38')),
          h('option', { value: 'abandoned' }, dt('drill.d39')),
          h('option', { value: 'no_surface' }, dt('drill.d40'))),
        h('div', { className: 'rt-spacer' }),
        h('button', { className: 'rt-btn', title: dt('drill.d81'), onClick: () => { if (onRefresh) onRefresh() } }, dt('drill.d82')),
        h('button', { className: 'rt-btn' + (view === 'list' ? ' rt-btn-primary' : ''), onClick: () => setView('list') }, dt('drill.d83')),
        h('button', { className: 'rt-btn' + (view === 'timeline' ? ' rt-btn-primary' : ''), title: dt('drill.d84'), onClick: () => setView('timeline') }, dt('drill.d85')),
        h('button', { className: 'rt-btn' + (view === 'domain' ? ' rt-btn-primary' : ''), onClick: () => setView('domain') }, dt('drill.d86')),
        h('button', { className: 'rt-btn' + (view === 'web' ? ' rt-btn-primary' : ''), onClick: () => setView('web') }, 'Web'))

      /* ── 结论行：一屏看清家底，数字点一下就是筛选 ───────────────────── */
      const tests = (snapshot && snapshot.tests) || {}
      const snapStats = (snapshot && snapshot.stats) || {}
      const noFilter = !testStatus && !priority && !scope && !prov && !assetState && !cidr
      const conclItem = (key, label, value, active, onClick) => h('span', Object.assign({
        key: key, className: 'rt-concl-i' + (active ? ' on' : ''), title: dt('drill.d87'),
      }, clickable(onClick, { label: dt('drill.d88') + label + dt('drill.d89') + (value || 0) + '）', expanded: active })),
        h('b', null, String(value || 0)), h('span', null, label))
      const toggleTest = (v) => { setTestStatus((cur) => (cur === v ? '' : v)); setAssetState('') }
      const conclusion = h('div', { className: 'rt-concl' },
        conclItem('all', dt('drill.d90'), snapStats.assets, noFilter, () => {
          setTestStatus(''); setPriority(''); setScope(''); setProv(''); setAssetState(''); setCidr(null)
        }),
        conclItem('live', dt('drill.d91'), snapStats.liveAssets, assetState === 'live', () => { setAssetState((v) => (v === 'live' ? '' : 'live')); setTestStatus('') }),
        conclItem('untested', dt('drill.d92'), tests.untested, testStatus === 'untested', () => toggleTest('untested')),
        conclItem('testing', dt('drill.d36'), tests.testing, testStatus === 'testing', () => toggleTest('testing')),
        conclItem('tested', dt('drill.d93'), tests.tested, testStatus === 'tested', () => toggleTest('tested')),
        conclItem('giveup', dt('drill.d94'), (tests.abandoned || 0) + (tests.blocked || 0), testStatus === 'abandoned,blocked', () => toggleTest('abandoned,blocked')),
        h('div', { className: 'rt-spacer' }),
        h('select', {
          className: 'rt-input', value: sort, onChange: (e) => setSort(e.target.value),
          title: dt('drill.d95'),
        },
          h('option', { value: 'priority' }, dt('drill.d96')),
          h('option', { value: 'todo' }, dt('drill.d97')),
          h('option', { value: 'discovered' }, dt('drill.d98')),
          h('option', { value: 'ports' }, dt('drill.d99')),
          h('option', { value: 'ip' }, dt('drill.d100'))))

      const head = h('div', { className: 'rt-row head' },
        h('span', null, 'IP'), h('span', null, dt('drill.d101')), h('span', null, dt('drill.d102')),
        h('span', null, dt('drill.d103')), h('span', null, dt('drill.d104')))

      const rowNodes = []
      for (const it of state.items) {
        const openPorts = it.ports.filter((p) => p.state === 'open')
        const portText = openPorts.map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ') || '—'
        const fpText = it.fingerprints.map((f) => [f.vendor, f.product, f.version].filter(Boolean).join(' ')).join(' / ') || '—'
        /* 端口最多列 3 个，其余用 +N；主被动来源不再占列，进详情 */
        const shownPorts = openPorts.slice(0, 3).map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ')
        const morePorts = openPorts.length > 3 ? ' +' + (openPorts.length - 3) : ''
        rowNodes.push(h('div', Object.assign({
          key: 'r' + it.id, className: 'rt-row',
        }, clickable(() => toggleRow(it.id), { label: dt('drill.d105') + it.ip, expanded: openId === it.id })),
          h('span', { className: 'rt-mono', style: { display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' } },
            h('span', {
              className: 'rt-scope rt-scope-' + (it.scope === 'internal' ? 'internal' : 'external'),
            }, it.scope === 'internal' ? [dt('drill.k30007')] : dt('drill.d62')),
            h('span', {
              title: it.state === 'live' ? [dt('drill.k30008')] : String(it.state),
              style: {
                width: 7, height: 7, borderRadius: '50%', flex: 'none', marginTop: 4,
                background: it.state === 'live' ? 'var(--dsw-alias-state-success-primary, #10b981)' : 'var(--dsw-alias-state-idle-primary, #94a3b8)',
              },
            }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, it.ip),
            /* 发现时间挂在 IP 下面一行：IP 列宽度有限，不另开列（列宽一改整表要跟着调） */
            h('span', {
              style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
              title: dt('drill.d106') + (it.discovered_at ? fmt(it.discovered_at) : dt('drill.d107'))
                + (it.last_seen ? dt('drill.d108') + fmt(it.last_seen) : ''),
            }, it.discovered_at ? fmtShort(it.discovered_at) : dt('drill.d109'))),
          h('span', null, h(PriTag, { p: it.priority, title: it.potential || '' })),
          h('span', null, h(TestTag, { s: it.test_status }),
            it.blocked_count ? h('span', { className: 'rt-tag', style: { color: 'var(--dsw-alias-state-error-primary, #ef4444)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 33%, transparent)', marginLeft: 4 } }, dt('drill.d110') + it.blocked_count) : null),
          h('span', { title: portText }, (shownPorts || '—') + morePorts),
          h('span', { title: fpText }, fpText.length > 30 ? fpText.slice(0, 30) + '…' : fpText)))

        if (openId !== it.id) continue
        const d = detail && detail.id === it.id ? detail : null
        const portRows = []
        const fpRows = []
        const obsRows = []
        if (d) {
          for (const p of (d.ports || [])) {
            if (p.state !== 'open') continue
            portRows.push(h('div', { key: 'p' + p.port, className: 'rt-kv' },
              h('b', { className: 'rt-mono' }, p.port + '/' + p.proto),
              h('span', null, [p.service, p.product, p.version].filter(Boolean).join(' ') || dt('drill.d111')),
              p.url ? h('a', { className: 'rt-link', href: p.url, target: '_blank', rel: 'noreferrer', title: p.url }, p.title ? p.title : p.url) : null,
              h(ProvTag, { p: p.provenance })))
          }
          for (const f of (d.fingerprints || [])) {
            fpRows.push(h('div', { key: 'f' + (f.product || '') + (f.version || '') + (f.evidence || ''), className: 'rt-kv' },
              h('b', null, f.category || '—'),
              h('span', null, [f.vendor, f.product, f.version].filter(Boolean).join(' ') + (f.evidence ? '（' + f.evidence + '）' : '')),
              h(ProvTag, { p: f.provenance })))
          }
          for (const o of (d.observations || []).slice(0, 8)) {
            obsRows.push(h('div', { key: 'o' + (o.attr || '') + (o.value || '') + (o.collected_at || ''), className: 'rt-kv' },
              h('b', null, o.attr || '—'),
              h('span', null, (o.value || '') + ' · ' + (o.tool || dt('drill.d112')) + ' · ' + fmt(o.collected_at)),
              h(ProvTag, { p: o.provenance })))
          }
        }
        /* 详情分三层：3 行必读 → 「展开全部」后才是溯源、原始记录与备注全文 */
        const all = showAll === it.id
        const noteLines = d && d.test_notes ? d.test_notes.split('\n').filter(Boolean) : []
        const inner = d
          ? h('div', null,
              /* 必读三行 */
              h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d113')), h('span', null,
                h(TestTag, { s: d.test_status }),
                d.blocked_count ? h('span', { className: 'rt-tag', style: { marginLeft: 6, color: 'var(--dsw-alias-state-error-primary, #ef4444)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 33%, transparent)' } }, dt('drill.d114') + d.blocked_count + dt('drill.d115')) : null,
                h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } },
                  (d.test_updated_at ? fmt(d.test_updated_at) : dt('drill.d116')) + (d.test_updated_by ? ' · ' + d.test_updated_by : '')))),
              h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d117')), h('span', null,
                h(PriTag, { p: d.priority }),
                h('span', { style: { marginLeft: 8 } }, d.potential || dt('drill.d118')),
                d.assess_reason ? h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } }, d.assess_reason) : null)),
              h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d119')), h('span', null,
                d.test_surface || (portRows.length ? [dt('drill.k30009')] : dt('drill.d120')),
                d.scope ? h('span', { className: 'rt-scope rt-scope-' + (d.scope === 'internal' ? 'internal' : 'external'), style: { marginLeft: 8 } },
                  d.scope === 'internal' ? [dt('drill.k30010')] : dt('drill.d63')) : null)),
              h('span', Object.assign({ className: 'rt-more' },
                clickable(() => setShowAll(all ? null : it.id), { label: all ? [dt('drill.k30011')] : dt('drill.d121'), expanded: all })),
                all ? [dt('drill.k30012')] : dt('drill.d122')),
              all ? h('div', null,
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d123')), h('span', null, (d.names || []).map((n) => n.name).join(', ') || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d85')),
                  h('span', { title: dt('drill.d124') }, fmt(d.discovered_at)),
                  h('b', { style: { minWidth: 0, marginLeft: 8 } }, dt('drill.d125')), h('span', null, fmt(d.last_seen)),
                  h('b', { style: { minWidth: 0, marginLeft: 8 } }, dt('drill.d126')), h('span', null, fmt(d.first_seen))),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d127')), h('span', null, d.segment_cidr)),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d117')), h('span', null,
                  (d.priority || dt('drill.d118')) + (d.potential ? dt('drill.d128') + d.potential : '')
                  + (d.assess_reason ? dt('drill.d129') + d.assess_reason : '')
                  + (d.assessed_at ? '（' + fmt(d.assessed_at) + '）' : ''))),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d130')), h('span', null,
                  dt('drill.d131') + (d.passive || 0) + dt('drill.d132') + (d.active || 0))),
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, dt('drill.d103')),
                h('div', null, portRows.length ? portRows : '—'),
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, dt('drill.d104')),
                h('div', null, fpRows.length ? fpRows : '—'),
                noteLines.length
                  ? h(Clip, { key: 'notes', label: dt('drill.d133') + noteLines.length + dt('drill.d134'), text: noteLines.join('\n') })
                  : null,
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, dt('drill.d135')),
                h('div', null, obsRows.length ? obsRows : '—'))
                : null)
          : h('div', null, dt('drill.d136'))
        rowNodes.push(h('div', {
          key: 'd' + it.id, className: 'rt-row',
          style: { cursor: 'default', gridTemplateColumns: tableColumns([{ key: 'full' }]) },
        }, h('div', { className: 'rt-expand' }, inner)))
      }

      const listPane = h('div', { className: 'rt-table' }, head, rowNodes,
        !state.loading && !state.items.length ? h('div', { className: 'rt-empty' }, dt('drill.d137')) : null)

      /* 域名维度：域名 → 关联资产 */
      const domainPane = h('div', { className: 'rt-table' },
        domains === null ? h('div', { className: 'rt-empty' }, dt('drill.d136'))
          : domains.length
          ? domains.map((g) => h('div', { key: g.domain },
              h('div', { className: 'rt-section', style: { padding: '8px 10px 4px' } },
                h('a', { className: 'rt-link', href: 'http://' + g.domain, target: '_blank', rel: 'noreferrer' }, g.domain),
                h('span', { className: 'rt-tag', style: { marginLeft: 8 } }, g.count + dt('drill.d138'))),
              g.assets.map((a) => h('div', {
                key: String(g.domain) + '\u0000' + a.id + '\u0000' + a.ip, className: 'rt-row',
                style: { gridTemplateColumns: tableColumns([{ key: 'ip', width: 150 }, { key: 'segment', width: 130 }, { key: 'state', width: 70 }, { key: 'names' }]), cursor: 'pointer' },
                onClick: () => { setView('list'); setQ(''); setQApplied(a.ip) },
              },
                h('span', { className: 'rt-mono' }, a.ip),
                h('span', { className: 'rt-mono' }, a.segment),
                h('span', null, h('span', { className: 'rt-tag rt-tag-' + (a.state === 'live' ? 'live' : 'dead') }, a.state === 'live' ? [dt('drill.k30008')] : a.state)),
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, (a.names || []).join(', '))))))
          : h('div', { className: 'rt-empty' }, cidr ? [dt('drill.k30013')] : dt('drill.d139')))

      /* Web 资产：标题 + 可直接点击的 URL */
      const webPane = h('div', null,
        h(TableGrid, {
          columns: [
            { key: 'url', label: dt('drill.d140'), width: '1.6fr' },
            { key: 'title', label: dt('drill.d141'), width: '1.2fr' },
            { key: 'endpoint', label: dt('drill.d142'), width: 130 },
            { key: 'service', label: dt('drill.d67'), width: 110 },
          ],
          rows: (web || []).map((w) => {
            const url = w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port))
            return {
              key: 'w' + w.port_id,
              cells: [
                h('a', { className: 'rt-link rt-mono', href: url, target: '_blank', rel: 'noreferrer', title: url }, url),
                h('span', { title: w.title || '' }, w.title || '—'),
                h('span', { className: 'rt-mono' }, w.ip + ' · ' + w.segment_cidr),
                h('span', { style: { fontSize: 11 } }, [w.service, w.product, w.version].filter(Boolean).join(' ')),
              ],
            }
          }),
        }),
        web === null ? h('div', { className: 'rt-empty' }, dt('drill.d136'))
          : (!web.length ? h('div', { className: 'rt-empty' }, cidr ? [dt('drill.k30014')] : dt('drill.d143')) : null))


      let pane = listPane
      if (view === 'testing') pane = h(TestingTab, { engagement: eng, refreshKey: refreshKey })
      else if (view === 'domain') pane = domainPane
      else if (view === 'web') pane = webPane
      /* 发现时间视图自带滚动容器，直接放进 rt-main 的 flex 里 */
      else if (view === 'timeline') pane = h(DiscoveryView, { engagement: eng, refreshKey: refreshKey })

      return h('div', { className: 'rt-split' }, side,
        h('div', { className: 'rt-main' }, view === 'testing' ? null : toolbar,
          conclusion,
          state.error ? h('div', { className: 'rt-err' }, state.error) : null,
          pane))
    }

    /* ---------------------------------------------------------- 资产发现时间线 */
    /**
     * 资产发现时间线：什么时候发现了什么、哪天收了多少。
     * 注意：这个组件曾在"移除图谱视图"时被连带删掉 —— 删除区间的结束标记选得太宽
     *    （图谱画布的收尾与它挨着），bundle 自检的 "client.js 有资产「发现时间」视图"
     *    因此变红。恢复时把插入点固定成"资产测绘注释块之前"，避免再被别的删除波及。
     */
    function DiscoveryView(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [day, setDay] = React.useState('')
      React.useEffect(() => {
        if (!eng) return
        setData(null)
        api({ op: 'discoveryTimeline', engagement: eng, limit: 200 })
          .then((r) => { if (!r || r.ok === false) setErr((r && r.error) || dt('drill.d144')); else { setErr(null); setData(r) } },
            (e) => setErr(String((e && e.message) || e)))
      }, [eng, refreshKey])
      if (err) return h('div', { className: 'rt-pane' }, h('div', { className: 'rt-err' }, err))
      if (!data) return h('div', { className: 'rt-empty' }, dt('drill.d136'))
      const recent = (data.recent || []).filter((a) => day === '' || String(a.discovered_at || '').slice(0, 10) === day)
      return h('div', { className: 'rt-pane', style: { flex: 1, minHeight: 0 } },
        h('div', { className: 'rt-card' },
          h('h4', null, dt('drill.d145')),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            dt('drill.d146') + ((data.span && data.span.total) || 0) + dt('drill.d147')
            + (data.span && data.span.first ? fmt(data.span.first) : '—')
            + dt('drill.d148') + (data.span && data.span.last ? fmt(data.span.last) : '—')
            + dt('drill.d149'))),
        (data.days || []).length === 0 ? h('div', { className: 'rt-empty' }, dt('drill.d150')) : null,
        h('div', { className: 'rt-card' },
          h('h4', null, dt('drill.d151'), day
            ? h('span', Object.assign({ className: 'rt-tag', style: { marginLeft: 6, cursor: 'pointer' } },
                clickable(() => setDay(''), { label: dt('drill.d152') + day })), dt('drill.d153') + day)
            : null),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            (data.days || []).map((d) => h('div', Object.assign({
              key: d.day, className: 'rt-seg' + (day === d.day ? ' on' : ''), style: { marginBottom: 0, cursor: 'pointer' },
              title: d.day + dt('drill.d154') + d.assets + dt('drill.d155') + d.internal + dt('drill.d156') + d.external + '）',
            }, clickable(() => setDay(day === d.day ? '' : d.day),
              { label: dt('drill.d157') + d.day + dt('drill.d158'), expanded: day === d.day })),
              h('div', { className: 'rt-seg-cidr' }, d.day),
              h('div', { className: 'rt-seg-meta' }, d.assets + dt('drill.d159') + d.internal + dt('drill.d160') + d.external))))),
        h('div', { className: 'rt-card' },
          h('h4', null, day ? day + dt('drill.d161') + recent.length + '）' : dt('drill.d162') + recent.length + '）'),
          recent.length === 0 ? h('div', { className: 'rt-empty' }, dt('drill.d163')) : null,
          recent.map((a) => h('div', { key: a.id, className: 'rt-kv' },
            h('b', { className: 'rt-mono', style: { minWidth: 110 } },
              h('span', { className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external'), style: { marginRight: 4 } },
                a.scope === 'internal' ? [dt('drill.k30007')] : dt('drill.d62')),
              a.ip),
            h('span', { style: { minWidth: 132, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
              a.discovered_at ? fmt(a.discovered_at) : dt('drill.d164')),
            h('span', { style: { flex: 1 } }, (a.primary_name || '—') + (a.open_ports ? ' · ' + a.open_ports + [dt('drill.k30015')] : '')),
            h(PriTag, { p: a.priority })))))
    }

    /* ---------------------------------------------------------- 智能体提示词 */
    function PromptsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [roles, setRoles] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        /* 无靶标也允许：服务端回内置默认，不再报 engagement required */
        api(eng ? { op: 'prompts', engagement: eng } : { op: 'prompts' }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d165') }); return }
          setRoles(r.roles || [])
          if (r.roles && r.roles.length) setActive((cur) => cur || r.roles[0].role)
          if (r.builtin) setMsg({ ok: dt('drill.d166') })
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }, [eng, refreshKey])

      React.useEffect(() => {
        const r = roles.find((x) => x.role === active)
        if (r) setDraft(r.content || '')
      }, [active, roles])

      const save = () => {
        if (!eng) { setMsg({ err: dt('drill.d167') }); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'savePrompt', engagement: eng, role: active, content: draft }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d168') }); return }
          setRoles((list) => list.map((x) => (x.role === active
            ? Object.assign({}, x, { content: draft, updated_at: new Date().toISOString() })
            : x)))
          setMsg({ ok: dt('drill.d169') })
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 老靶标的提示词是旧版模板；这里可以把当前角色（或全部）恢复成内置最新版 */
      const reset = (all) => {
        if (!eng) { setMsg({ err: dt('drill.d170') }); return }
        setBusy(true); setMsg(null)
        api({ op: 'resetPrompts', engagement: eng, role: all ? undefined : active }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d171') }); return }
          setMsg({ ok: dt('drill.d172') + (r.reset || []).join('、') })
          api({ op: 'prompts', engagement: eng }).then((rr) => {
            if (rr && rr.ok) {
              setRoles(rr.roles || [])
              const cur2 = (rr.roles || []).find((x) => x.role === active)
              if (cur2) setDraft(cur2.content || '')
            }
          }, () => {})
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const cur = roles.find((x) => x.role === active)
      const items = roles.map((r) => h('div', Object.assign({
        key: r.role, className: 'rt-item' + (active === r.role ? ' on' : ''),
      }, clickable(() => { setActive(r.role); setMsg(null) },
        { label: dt('drill.d173') + r.title + dt('drill.d174'), expanded: active === r.role })),
        h('div', { className: 'rt-item-name' }, r.title),
        h('div', { className: 'rt-item-desc' }, (r.content || '').replace(/[#*`]/g, '').slice(0, 60) || dt('drill.d175'))))

      return h('div', { className: 'rt-split' },
        h('div', { className: 'rt-list' }, items),
        h('div', { className: 'rt-main' },
          h('div', { className: 'rt-toolbar' },
            h('span', { style: { fontWeight: 600 } }, cur ? cur.title : dt('drill.d176')),
            h('span', { className: 'rt-tag' }, dt('drill.d177') + fmt(cur && cur.updated_at)),
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', disabled: busy || !active, title: dt('drill.d178'),
              onClick: () => reset(false),
            }, dt('drill.d179')),
            h('button', {
              className: 'rt-btn', disabled: busy, title: dt('drill.d180'),
              onClick: () => reset(true),
            }, dt('drill.d181')),
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !active, onClick: save }, busy ? [dt('drill.k30016')] : dt('drill.d182'))),
          msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
          h('div', { className: 'rt-pane' },
            h('textarea', {
              className: 'rt-textarea', value: draft, spellCheck: false,
              onChange: (e) => setDraft(e.target.value),
              placeholder: dt('drill.d183'),
            }),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 6 } },
              dt('drill.d184') + (active || 'role') + dt('drill.d185')))))
    }

    /* ---------------------------------------------------------- 技能库（DSH 原生） */
    function SkillsTab(props) {
      const refreshKey = props.refreshKey || 0
      const [items, setItems] = React.useState([])
      const [meta, setMeta] = React.useState({})
      const [err, setErr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [srcOnly, setSrcOnly] = React.useState(false)
      const [active, setActive] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [brokenOnly, setBrokenOnly] = React.useState(false)

      /* refresh=true 跳过后端 30 秒可用性缓存（技能正文/环境变量可能刚改过） */
      const load = (force) => {
        setBusy(true)
        api({ op: 'skillCatalog', refresh: force === true }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null)
          setMeta(r || {})
          setItems(r.items || [])
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [refreshKey])

      const open = (skill) => {
        const name = skill && skill.name
        const key = (skill && skill.library ? skill.library : 'redteam') + ':' + name
        if (active === key) { setActive(null); setDetail(null); return }
        setActive(key)
        setDetail(null)
        api({ op: 'skillRead', name: name, library: skill.library || 'redteam' }).then((r) => {
          if (r && r.ok) setDetail(r)
          else setErr((r && r.error) || dt('drill.d165'))
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const needle = q.trim().toLowerCase()
      let filtered = needle
        ? items.filter((s) => (s.name + ' ' + s.description + ' ' + s.whenToUse).toLowerCase().indexOf(needle) >= 0)
        : items
      if (srcOnly) filtered = filtered.filter((s) => s.library !== 'official' && s.fromPlugin === true)
      if (brokenOnly) filtered = filtered.filter((s) => s.library !== 'official' && (s.availability === 'broken' || s.availability === 'unknown'))
      /* 目录聚合：一眼看出"这么多技能是哪来的"（本项目/别的插件/自带根…） */
      const dirs = (meta.byDir || []).filter((d) => d.n > 0).slice(0, 6)
      const availSummary = meta.availability ? meta.availability.summary : null
      const needRestart = err !== null && String(err).indexOf('unknown op') >= 0

      const renderSkill = (s) => h('div', Object.assign({
        key: (s.library || 'redteam') + ':' + s.name, className: 'rt-item' + (active === ((s.library || 'redteam') + ':' + s.name) ? ' on' : ''),
      }, clickable(() => open(s), { label: dt('drill.d186') + s.name, expanded: active === ((s.library || 'redteam') + ':' + s.name) })),
        h('div', { className: 'rt-item-name' }, s.name,
          s.modelInvocable === false ? h('span', { className: 'rt-tag', style: { marginLeft: 6 } }, dt('drill.d187')) : null,
          s.library === 'official'
            ? h('span', { className: 'rt-tag', style: { marginLeft: 6 }, title: dt('drill.d188') }, dt('drill.d189'))
            : h('span', {
              className: 'rt-badge rt-badge--' + (s.availability === 'available' ? 'ok' : s.availability === 'broken' ? 'warn' : 'idle'),
              style: { marginLeft: 6 },
              title: (s.availability === 'available'
                ? dt('drill.d190')
                : (s.problems || []).join('\n') || dt('drill.d32')),
            }, s.availability === 'available' ? [dt('drill.k30017')] : s.availability === 'broken' ? [dt('drill.k30018')] : dt('drill.d32')),
        h('div', { className: 'rt-item-desc' }, s.description || dt('drill.d191')),
        h('div', { className: 'rt-kb-sub' },
          [s.source ? dt('drill.d192') + s.source : null,
            s.fromPlugin ? [dt('drill.k30019')] : null,
            s.provider ? s.provider : null,
            s.dir ? s.dir : null].filter(Boolean).join(' · ')),
        (s.problems || []).length > 0 && s.availability !== 'available' && s.library !== 'official'
          ? h('div', { className: 'rt-caution' },
              h('span', { className: 'rt-caution__label' }, dt('drill.note')),
              h('span', null, String(s.problems[0]).slice(0, 60)))
          : null))
      const redteamRows = filtered.filter((s) => s.library !== 'official').map(renderSkill)
      const officialRows = filtered.filter((s) => s.library === 'official').map(renderSkill)
      const listItems = []
      if (redteamRows.length > 0) {
        listItems.push(h('div', { key: 'head-redteam', className: 'rt-kb-sub', style: { margin: '8px 0 4px', fontWeight: 600 } }, dt('drill.d193')))
        listItems.push.apply(listItems, redteamRows)
      }
      if (officialRows.length > 0) {
        listItems.push(h('div', { key: 'head-official', className: 'rt-kb-sub', style: { margin: '8px 0 4px', fontWeight: 600 } }, dt('drill.d194')))
        listItems.push.apply(listItems, officialRows)
      }

      return h('div', { className: 'rt-split' },
        h('div', { className: 'rt-list' },
          h('input', {
            className: 'rt-input', style: { width: '100%', marginBottom: 8, boxSizing: 'border-box' },
            placeholder: dt('drill.d195'), value: q, onChange: (e) => setQ(e.target.value),
          }),
          h('label', { className: 'rt-kb-check', style: { display: 'flex', margin: '0 0 6px' } },
            h('input', { type: 'checkbox', checked: srcOnly, onChange: (e) => setSrcOnly(e.target.checked) }),
            dt('drill.d196') + (meta.fromPlugin || 0) + dt('drill.d197')),
          availSummary && (availSummary.broken > 0 || availSummary.unknown > 0)
            ? h('label', {
                className: 'rt-kb-check', style: { display: 'flex', margin: '0 0 8px' },
                title: dt('drill.d198'),
              },
                h('input', { type: 'checkbox', checked: brokenOnly, onChange: (e) => setBrokenOnly(e.target.checked) }),
                dt('drill.d199') + ((availSummary.broken || 0) + (availSummary.unknown || 0)) + dt('drill.d197'))
            : null,
          availSummary
            ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 } },
                h('span', { className: 'rt-avail rt-avail-available' }, dt('drill.d200') + (availSummary.available || 0)),
                availSummary.broken > 0 ? h('span', { className: 'rt-avail rt-avail-broken' }, dt('drill.d201') + availSummary.broken) : null,
                availSummary.unknown > 0 ? h('span', { className: 'rt-avail rt-avail-unknown' }, dt('drill.d202') + availSummary.unknown) : null,
                h('span', Object.assign({
                  className: 'rt-tag', style: { cursor: 'pointer' },
                  title: dt('drill.d203'),
                }, clickable(() => load(true), { label: dt('drill.d204') })), dt('drill.d205')))
            : null,
          /* 库归属与可用性计数：数字大、标签小（原来是一段「红队 N 个 · 官方 M 个」的说明句） */
          h(StatRow, {
            groups: [
              {
                key: 'libraries',
                items: [
                  { key: 'redteam', label: dt('drill.d193'), value: (meta.libraries && meta.libraries.redteam) || 0 },
                  { key: 'official', label: dt('drill.d189'), value: (meta.libraries && meta.libraries.official) || 0 },
                  { key: 'broken', label: dt('drill.k30018'), value: availSummary ? (availSummary.broken || 0) : 0 },
                ],
              },
            ],
          }),
          items.length > 100 ? h('div', { style: { marginTop: 3 } },
            dt('drill.d208') + (meta.fromPlugin || 0) + dt('drill.d197')) : null,
          listItems),
        h('div', { className: 'rt-main' },
          h('div', { className: 'rt-toolbar' },
            h('span', { style: { fontWeight: 600 } }, detail ? detail.name : dt('drill.d209')),
            h('div', { className: 'rt-spacer' }),
            h('button', { className: 'rt-btn', disabled: busy, onClick: () => load(true) }, busy ? [dt('drill.k30020')] : dt('drill.d82'))),
          err
            ? (needRestart
                ? h('div', { className: 'rt-empty' }, dt('drill.d210'))
                : h('div', { className: 'rt-err' }, err))
            : null,
          detail
            ? h('div', { className: 'rt-pane' },
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d211')), h('span', null, detail.description || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d212')), h('span', null, detail.whenToUse || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d130')), h('span', null, (detail.provider || '—') + ' / ' + (detail.source || '—'))),
                (() => {
                  const s2 = items.find((x) => ((x.library || 'redteam') + ':' + x.name) === active)
                  if (!s2) return null
                  if (s2.library === 'official') {
                    return h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d213')), h('span', null, dt('drill.d214')))
                  }
                  const avail = s2.availability || 'unknown'
                  return h('div', null,
                    h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d215')),
                      h('span', { className: 'rt-avail rt-avail-' + avail },
                        avail === 'available' ? [dt('drill.k30017')] : avail === 'broken' ? [dt('drill.k30021')] : dt('drill.d216'))),
                    (s2.problems || []).length > 0
                      ? h('div', { className: 'rt-kv' }, h('b', null, avail === 'available' ? [dt('drill.k30022')] : dt('drill.d217')),
                          h('span', null, s2.problems.map((x, i) => h('div', { key: 'p' + i }, '· ' + x))))
                      : null,
                    (s2.needs_user || []).length > 0
                      ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d218')),
                          h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } },
                            s2.needs_user.map((x, i) => h('div', { key: 'n' + i }, '· ' + x))))
                      : null)
                })(),
                detail.path ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d219')), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, detail.path)) : null,
                h('pre', { className: 'rt-md', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, maxHeight: '52vh' } }, detail.content || dt('drill.d175')))
            : h('div', { className: 'rt-pane' },
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
                  meta.note || dt('drill.d220')),
                availSummary
                  ? h('div', { style: { fontSize: 12, marginBottom: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                      h('span', { className: 'rt-avail rt-avail-available' }, dt('drill.d200') + (availSummary.available || 0)),
                      availSummary.broken > 0 ? h('span', { className: 'rt-avail rt-avail-broken' }, dt('drill.d201') + availSummary.broken) : null,
                      availSummary.unknown > 0 ? h('span', { className: 'rt-avail rt-avail-unknown' }, dt('drill.d202') + availSummary.unknown) : null,
                      h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                        '（' + (meta.availability && meta.availability.cached ? [dt('drill.k30023')] : dt('drill.d221'))
                        + (meta.availability && meta.availability.checked_at ? fmt(meta.availability.checked_at) : '—') + '）'))
                  : null,
                meta.availability && (meta.availability.broken || []).length > 0
                  ? h('div', { className: 'rt-hint' },
                      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, dt('drill.d222')),
                      meta.availability.broken.slice(0, 12).map((b) => h('div', { key: b.name },
                        '· ' + b.name + (b.problems && b.problems.length ? ' — ' + b.problems[0] : ''))))
                  : null,
                (meta.byDir || []).slice(0, 6).map((d) => h('div', { key: d.key, className: 'rt-mono', style: { fontSize: 11, marginBottom: 2, overflowWrap: 'anywhere' } },
                  d.n + dt('drill.d223') + d.key)),
                (meta.byDir || []).length > 6
                  ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                      dt('drill.d224') + ((meta.byDir || []).length - 6) + dt('drill.d225') + items.length + dt('drill.d226'))
                  : null,
                h(EmptyState, {
                  text: filtered.length ? dt('drill.t40skillsFiltered') : dt('drill.t40skillsEmpty'),
                  path: filtered.length ? null : ((meta.byDir || [])[0] || {}).key || null,
                  action: filtered.length
                    ? h('button', {
                        className: 'rt-btn',
                        onClick: () => { setQ(''); setSrcOnly(false); setBrokenOnly(false) },
                      }, dt('drill.t40clearFilter'))
                    : null,
                })))
      )
    }

    /* ---------------------------------------------------------- 漏洞战果 */
    const SEV_LABEL = { critical: dt('drill.d228'), high: dt('drill.d229'), medium: dt('drill.d230'), low: dt('drill.d231'), info: dt('drill.d232') }
    const STATUS_LABEL = { candidate: dt('drill.d233'), confirmed: dt('drill.d234'), 'false-positive': dt('drill.d235'), exploited: dt('drill.d236'), fixed: dt('drill.d237') }
    const sevClass = (s) => 'rt-sev rt-sev-' + (SEV_LABEL[s] ? s : 'info')


    /** 目标归并：按「scheme://host:port」聚合，避免带路径的 URL 把分组打散。 */
    function targetKeyOf(v) {
      const t = String(v.target || '').trim()
      if (t !== '') {
        const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(t)
        if (url) return url[1]
        const head = /^([^\s/?#]+)/.exec(t)
        if (head) return head[1]
        return t
      }
      return v.asset_ip || dt('drill.d238')
    }

    /* ---------------------------------------------------------- 证据渲染 */
    /** 把一段原始 HTTP 报文按「请求行/状态行 + 头 + 体」着色，便于人眼扫读。 */
    function HttpBlock(props) {
      const text = String(props.text || '')
      if (!text) return null
      const lines = text.split(/\r?\n/)
      const nodes = lines.map((ln, i) => {
        let cls = null
        if (i === 0 && /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE)\s/.test(ln)) cls = 'rt-hl-req'
        else if (i === 0 && /^HTTP\//.test(ln)) cls = 'rt-hl-res'
        else if (/^[A-Za-z0-9-]+:/.test(ln)) {
          const name = ln.split(':')[0].toLowerCase()
          if (name === 'host' || name === 'cookie' || name === 'authorization' || name === 'content-type') cls = 'rt-hl-req'
        }
        return h('div', { key: 'l' + i, className: cls || undefined }, ln === '' ? '\u00a0' : ln)
      })
      return h('pre', { className: 'rt-evi-body' + (props.compact ? ' req' : '') }, nodes)
    }

    /** 漏洞详情里的证据区：结构化证据文本 + 该漏洞的原始 HTTP 请求/响应记录。 */
    function detailEvidence(v) {
      const evi = String(v.evidence || '').trim()
      const looksHttp = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|HTTP\/)/m.test(evi) || /\n[A-Za-z-]+: /.test(evi)
      const blocks = []
      if (evi) {
        blocks.push(h('div', { key: 'ev', className: 'rt-evi' },
          h('div', { className: 'rt-evi-head' }, dt('drill.d239'),
            h('span', { className: 'rt-tag' }, looksHttp ? [dt('drill.k30024')] : dt('drill.d240')),
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
              onClick: (e) => { e.stopPropagation(); copyText(evi) },
            }, dt('drill.d241'))),
          looksHttp ? h(HttpBlock, { text: evi }) : h('pre', { className: 'rt-evi-body' }, evi)))
      }
      const http = v.http_evidence || []
      for (const e of http) {
        blocks.push(h('div', { key: 'h' + e.id, className: 'rt-evi' },
          h('div', { className: 'rt-evi-head' },
            e.label || dt('drill.d242'),
            h('span', { className: 'rt-tag' }, (e.method || '') + ' ' + (e.status === null || e.status === undefined ? '' : e.status)),
            h('div', { className: 'rt-spacer' }),
            h('span', { style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, fmt(e.captured_at || e.created_at))),
          e.request ? h('div', null,
            h('div', { className: 'rt-evi-head', style: { borderTop: 'none' } }, dt('drill.d243')),
            h(HttpBlock, { text: e.request, compact: true })) : null,
          e.response ? h('div', null,
            h('div', { className: 'rt-evi-head' }, dt('drill.d244')),
            h(HttpBlock, { text: e.response })) : null,
          e.note ? h('pre', { className: 'rt-evi-body', style: { maxHeight: 80 } }, e.note) : null))
      }
      if (blocks.length === 0) {
        blocks.push(h('div', { key: 'none', className: 'rt-kv' }, h('b', null, dt('drill.d26')),
          h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, dt('drill.d245'))))
      }
      return h('div', { key: 'eviwrap' }, blocks)
    }

    function FindingsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [sev, setSev] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [], stats: null })
      const [creds, setCreds] = React.useState([])
      const [accesses, setAccesses] = React.useState([])
      const [files, setFiles] = React.useState([])
      const [openId, setOpenId] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      /* 子页签：漏洞 / 凭据 / 访问会话（凭据不再铺在漏洞页底部） */
      const [subTab, setSubTab] = React.useState('vulns')
      /* 默认按目标聚合：322 条平铺没法读，先看"哪台被打下什么" */
      const [grouped, setGrouped] = React.useState(true)
      const collapse = useCollapse('findings:' + eng)

      const load = () => {
        if (!eng) return
        api({
          op: 'vulns', engagement: eng, severity: sev || undefined,
          status: status || undefined, q: qApplied || undefined, limit: 200,
        }).then((r) => {
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || dt('drill.d45'), total: 0, items: [], stats: null })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [], stats: r.stats || null })
        }, (e) => setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [], stats: null }))
        api({ op: 'credentials', engagement: eng }).then((r) => setCreds((r && r.items) || []), () => {})
        api({ op: 'access', engagement: eng }).then((r) => setAccesses((r && r.items) || []), () => {})
        api({ op: 'attackFiles', engagement: eng }).then((r) => setFiles((r && r.items) || []), () => {})
      }
      React.useEffect(load, [eng, sev, status, qApplied, refreshKey])

      const setVulnStatus = (id, next) => {
        setMsg(null)
        api({ op: 'updateVuln', engagement: eng, id: id, patch: { status: next } }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d246') }); return }
          setMsg({ ok: dt('drill.d247') + (STATUS_LABEL[next] || next) + '」' })
          load()
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const stats = (state.stats && state.stats.bySeverity) ? state.stats : { bySeverity: {}, byStatus: {} }
      const needRestart = state.error !== null && String(state.error).indexOf('unknown op') >= 0

      const allFiles = (files || []).flatMap((g) => (g.files || []).map((f) => Object.assign({ target: g.target }, f)))
      const filesByVuln = new Map()
      const orphanFiles = []
      for (const f of allFiles) {
        const vid = f.vuln_id === null || f.vuln_id === undefined ? null : Number(f.vuln_id)
        if (vid === null) { orphanFiles.push(f); continue }
        if (!filesByVuln.has(vid)) filesByVuln.set(vid, [])
        filesByVuln.get(vid).push(f)
      }

      /* ── 结论行：只给结论，数字点一下就是筛选 ─────────────────────── */
      const concl = (key, label, value, active, onClick) => h('span', Object.assign({
        key: key, className: 'rt-concl-i' + (active ? ' on' : ''), title: dt('drill.d87'),
      }, clickable(onClick, { label: dt('drill.d88') + label + dt('drill.d89') + (value || 0) + '）', expanded: active })),
        h('b', null, String(value || 0)), h('span', null, label))
      const conclusion = h('div', { className: 'rt-concl' },
        concl('conf', dt('drill.d234'), (stats.byStatus.confirmed || 0), status === 'confirmed', () => setStatus((v) => (v === 'confirmed' ? '' : 'confirmed'))),
        concl('exp', dt('drill.d236'), (stats.byStatus.exploited || 0), status === 'exploited', () => setStatus((v) => (v === 'exploited' ? '' : 'exploited'))),
        concl('crit', dt('drill.d228'), (stats.bySeverity.critical || 0), sev === 'critical', () => setSev((v) => (v === 'critical' ? '' : 'critical'))),
        concl('high', dt('drill.d229'), (stats.bySeverity.high || 0), sev === 'high', () => setSev((v) => (v === 'high' ? '' : 'high'))),
        concl('med', dt('drill.d230'), (stats.bySeverity.medium || 0), sev === 'medium', () => setSev((v) => (v === 'medium' ? '' : 'medium'))),
        concl('gain', dt('drill.d248'), (stats.withGained || 0), false, () => {}),
        h('div', { className: 'rt-spacer' }),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          dt('drill.d249') + (stats.targetGroups || 0) + dt('drill.d250')))

      const head = h('div', { className: 'rt-vrow head' },
        h('span', null, dt('drill.d251')), h('span', null, dt('drill.d252')), h('span', null, dt('drill.d253')),
        h('span', null, dt('drill.d254')), h('span', null, dt('drill.d255')), h('span', null, dt('drill.d256')))

      /* 单条漏洞（行 + 展开详情），聚合视图与平铺视图共用 */
      const vulnRows = (v, compact) => {
        const out = []
        const gainedList = String(v.gained || '').split(/[、,;，；]/).map((x) => x.trim()).filter(Boolean)
        const open = openId === v.id
        out.push(h('div', {
          key: 'v' + v.id, className: 'rt-vrow', role: 'button', tabIndex: 0,
          style: compact
            ? { cursor: 'pointer', gridTemplateColumns: tableColumns([{ key: 'sev', width: 58 }, { key: 'title' }, { key: 'gained', width: 104 }, { key: 'conf', width: 68 }]) }
            : { cursor: 'pointer' },
          onClick: () => setOpenId(open ? null : v.id),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(open ? null : v.id) } },
        },
          h('span', null, h('span', { className: sevClass(v.severity) }, SEV_LABEL[v.severity] || v.severity)),
          h('span', { title: v.title || '' }, h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'), (v.cve ? v.cve + ' ' : '') + (v.title || '')),
          compact ? null : h('span', { className: 'rt-mono', title: v.target || '' }, v.target || v.asset_ip || '—'),
          h('span', { title: v.gained || '' },
            gainedList.length
              ? h('span', { className: 'rt-gain', style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' } }, gainedList[0] + (gainedList.length > 1 ? ' +' + (gainedList.length - 1) : ''))
              : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '—')),
          h('span', null, h('span', { className: 'rt-tag' }, STATUS_LABEL[v.status] || v.status)),
          compact ? null : h('span', null, v.confidence === null || v.confidence === undefined ? '—' : Math.round(v.confidence * 100) + '%')))
        if (openId !== v.id) return out
        out.push(h('div', {
          key: 'vd' + v.id, className: 'rt-vrow',
          style: { cursor: 'default', gridTemplateColumns: tableColumns([{ key: 'full' }]) },
        }, h('div', { className: 'rt-vdetail' },
          h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d254')),
            gainedList.length
              ? h('span', null, gainedList.map((g, gi) => h('span', { key: 'g' + gi, className: 'rt-gain', style: { marginRight: 6 } }, g)))
              : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                  dt('drill.d257'))),
          h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d253')), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, v.target || '—')),
          h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d142')), h('span', null, (v.asset_ip || '—') + ' · ' + (v.segment_cidr || ''))),
          h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d130')), h('span', null, (v.source || '—') + ' · ' + (v.found_by_agent || '—') + ' · ' + fmt(v.found_at))),
          detailEvidence(v),
          (() => {
            const mine = filesByVuln.get(Number(v.id)) || []
            return h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d258')),
              mine.length
                ? h('span', null, mine.map((f, fi) => h('div', { key: 'af' + fi, style: { marginBottom: 3 } },
                    '· ' + (f.kind ? '[' + f.kind + '] ' : '') + (f.name || dt('drill.d259'))
                    + (f.description ? ' — ' + f.description : ''),
                    h('div', { className: 'rt-mono', style: { fontSize: 11, marginLeft: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, f.path || ''))))
                : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                    dt('drill.d260')))
          })(),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'confirmed') } }, dt('drill.d261')),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'exploited') } }, dt('drill.d236')),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'false-positive') } }, dt('drill.d235')),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'fixed') } }, dt('drill.d237'))))))
        return out
      }

      const rows = []
      if (grouped) {
        /* 按目标聚合成组：先看"哪台被打下什么"，再点进去看具体漏洞 */
        const groups = new Map()
        for (const v of state.items) {
          const key = targetKeyOf(v)
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(v)
        }
        const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
        const list = Array.from(groups.entries()).map(([key, vs]) => ({
          key,
          vulns: vs,
          top: vs.slice().sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))[0],
          gained: Array.from(new Set(vs.flatMap((v) => String(v.gained || '').split(/[、,;，；]/).map((x) => x.trim()).filter(Boolean)))),
          exploited: vs.filter((v) => v.status === 'exploited').length,
        })).sort((a, b) => (SEV_RANK[a.top.severity] ?? 9) - (SEV_RANK[b.top.severity] ?? 9) || b.vulns.length - a.vulns.length)
        for (const g of list) {
          const key = 'target:' + g.key
          const defOpen = false
          rows.push(h(Section, {
            key: 'sec:' + g.key, tone: 'target',
            title: g.key,
            count: g.vulns.length + dt('drill.d262'),
            sub: [
              SEV_LABEL[g.top.severity] || g.top.severity,
              g.exploited ? dt('drill.d263') + g.exploited : null,
              g.top.asset_ip && g.top.asset_ip !== g.key ? dt('drill.d264') + g.top.asset_ip : null,
            ].filter(Boolean).join(' · '),
            right: g.gained.length
              ? g.gained.slice(0, 2).join(' / ') + (g.gained.length > 2 ? ' +' + (g.gained.length - 2) : '')
              : dt('drill.d265'),
            open: collapse.isOpen(key, defOpen),
            onToggle: collapse.toggle(key, defOpen),
          }, g.vulns.map((v) => vulnRows(v, true))))
        }
        if (!list.length && !state.loading && !state.error) {
          rows.push(h('div', { key: 'none', className: 'rt-empty' }, dt('drill.d266')))
        }
      } else {
        for (const v of state.items) rows.push(...vulnRows(v))
      }

      const toolbar = h('div', { className: 'rt-toolbar' },
        h('input', {
          className: 'rt-input', style: { flex: '1 1 140px' }, placeholder: dt('drill.d267'),
          value: q, onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') setQApplied(q) },
        }),
        h('button', { className: 'rt-btn', onClick: () => setQApplied(q) }, dt('drill.d66')),
        h('select', { className: 'rt-input', value: sev, onChange: (e) => setSev(e.target.value) },
          h('option', { value: '' }, dt('drill.d268')),
          h('option', { value: 'critical' }, dt('drill.d228')),
          h('option', { value: 'high' }, dt('drill.d229')),
          h('option', { value: 'medium' }, dt('drill.d230')),
          h('option', { value: 'low' }, dt('drill.d231')),
          h('option', { value: 'info' }, dt('drill.d232'))),
        h('select', { className: 'rt-input', value: status, onChange: (e) => setStatus(e.target.value) },
          h('option', { value: '' }, dt('drill.d269')),
          h('option', { value: 'candidate' }, dt('drill.d233')),
          h('option', { value: 'confirmed' }, dt('drill.d234')),
          h('option', { value: 'exploited' }, dt('drill.d236')),
          h('option', { value: 'false-positive' }, dt('drill.d235')),
          h('option', { value: 'fixed' }, dt('drill.d237'))))

      const credSection = h('div', null,
        h('div', { className: 'rt-section' }, dt('drill.d270') + creds.length + (creds.length ? [dt('drill.k30025')] : '')),
        creds.length
          ? h('div', { style: { padding: '4px 10px 0' } }, creds.map((c) => h('div', { key: 'c' + c.id, className: 'rt-cred' },
              h('div', { className: 'rt-cred-head' },
                h('span', { className: 'rt-cred-host' }, c.host),
                c.username ? h('span', { className: 'rt-tag' }, c.username) : null,
                h('span', { className: 'rt-tag rt-tag-passive' }, c.secret_type || 'password'),
                c.privilege ? h('span', { className: 'rt-tag rt-tag-active' }, c.privilege) : null,
                h('div', { className: 'rt-spacer' }),
                h('button', {
                  className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                  onClick: (e) => { e.stopPropagation(); copyText(String(c.secret_value || '')) },
                }, dt('drill.d241'))),
              c.secret_value
                ? h('div', { className: 'rt-secret', title: dt('drill.d271') }, c.secret_value)
                : h('div', { className: 'rt-secret-none' }, dt('drill.d272')),
              h('div', { className: 'rt-cred-meta' },
                [c.source ? dt('drill.d192') + c.source : null,
                  c.tool ? dt('drill.d273') + c.tool : null,
                  c.secret_ref ? dt('drill.d24') + c.secret_ref : null,
                  c.found_by_agent ? 'by ' + c.found_by_agent : null,
                  c.found_at ? fmt(c.found_at) : null].filter(Boolean).join(' · ')),
              c.note ? h('div', { className: 'rt-cred-meta' }, dt('drill.d274') + c.note) : null)))
          : h('div', { className: 'rt-empty' }, dt('drill.d275')))

      const accessSection = h('div', null,
        h('div', { className: 'rt-section' }, dt('drill.d276') + accesses.length),
        accesses.length
          ? accesses.map((a) => h('div', { key: 'a' + a.id, className: 'rt-vrow', style: { cursor: 'default', gridTemplateColumns: tableColumns([{ key: 'host' }, { key: 'user', width: 110 }, { key: 'method', width: 80 }, { key: 'priv', width: 80 }, { key: 'note' }]) } },
              h('span', { className: 'rt-mono' }, a.host),
              h('span', null, a.username || '—'),
              h('span', null, h('span', { className: 'rt-tag rt-tag-active' }, a.method || '—')),
              h('span', null, a.privilege || '—'),
              h('span', { className: 'rt-mono', title: a.session_ref || '' }, a.session_ref || '—')))
          : h('div', { className: 'rt-empty' }, dt('drill.d277')))

      const subTabBtn = (key, label, n) => h('span', Object.assign({
        className: 'rt-subtab' + (subTab === key ? ' on' : ''),
      }, clickable(() => setSubTab(key), { label: label + '（' + n + '）', expanded: subTab === key })),
      label + ' ' + n)

      return h('div', { className: 'rt-main' }, toolbar, conclusion,
        h('div', { className: 'rt-subtabs' },
          subTabBtn('vulns', dt('drill.d278'), state.total || 0),
          subTabBtn('files', dt('drill.d258'), allFiles.length),
          subTabBtn('creds', dt('drill.d279'), creds.length),
          subTabBtn('access', dt('drill.d280'), accesses.length),
          h('div', { className: 'rt-spacer' }),
          grouped ? h('button', {
            className: 'rt-btn', title: dt('drill.d281'),
            onClick: () => collapse.setAll((state.items || []).map((v) => 'target:' + targetKeyOf(v)), true),
          }, dt('drill.d282')) : null,
          grouped ? h('button', {
            className: 'rt-btn', title: dt('drill.d283'),
            onClick: () => collapse.setAll((state.items || []).map((v) => 'target:' + targetKeyOf(v)), false),
          }, dt('drill.d284')) : null,
          h('button', {
            className: 'rt-btn' + (grouped ? ' rt-btn-primary' : ''),
            title: grouped ? [dt('drill.k30026')] : dt('drill.d285'),
            onClick: () => setGrouped((g) => !g),
          }, grouped ? [dt('drill.k30027')] : dt('drill.d286'))),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        needRestart ? h('div', { className: 'rt-empty' }, dt('drill.d210')) : null,
        state.error && !needRestart ? h('div', { className: 'rt-err' }, state.error) : null,
        subTab === 'files'
          ? h('div', { className: 'rt-body', style: { overflow: 'auto' } },
              h('div', { className: 'rt-hint', style: { marginBottom: 8 } },
                dt('drill.d287')
                + (orphanFiles.length ? dt('drill.d288') + orphanFiles.length + [dt('drill.k30028')] : '')),
              h(AttackFilesTab, { engagement: eng, refreshKey: refreshKey }))
          : subTab === 'creds'
          ? h('div', { className: 'rt-body', style: { overflow: 'auto' } }, credSection)
          : subTab === 'access'
            ? h('div', { className: 'rt-body', style: { overflow: 'auto' } }, accessSection)
            : h('div', null, grouped ? null : head,
                h(TableGrid, {
                  /* 整行托管：漏洞行是可展开的 `.rt-vrow` 网格（自带列宽与详情行），
                     这里只把「一堆行 + 空态」交给原语，列模板仍是同一个生成器给的。 */
                  head: false,
                  columns: [{ key: 'row' }],
                  rows: rows.map((node, index) => ({ key: 'fv' + index, cells: [node] })),
                  empty: !state.loading && !state.items.length && !state.error
                    ? h(EmptyState, { text: dt('drill.d266') })
                    : null,
                })))
    }

    /* ---------------------------------------------------------- 攻击链 */
    const STAGE_LABEL = { recon: dt('drill.d16'), vuln: dt('drill.d18'), exploit: dt('drill.d19'), access: dt('drill.d289'), pivot: dt('drill.d290'), data: dt('drill.d291'), other: dt('drill.d292') }

    /* ---------------------------------------------------------- 攻击链（五阶段） */
    /**
     * 按攻击面位置串成一条链：
     * ① 信息收集 → ② 互联网资产权限 → ③ 边界突破 → ④ 内网资产权限 → ⑤ 靶标权限。
     * 每阶段只讲两件事：这一步拿到多少分（累计多少）、涉及的资产/隧道是哪些。
     * A = 竖向链（详细）；B = 横向链（一屏看完）。
     */
    function ChainTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [view, setView] = React.useState('A')
      const [openId, setOpenId] = React.useState(null)

      const load = () => {
        if (!eng) return
        setLoading(true)
        api({ op: 'scoreChain', engagement: eng }).then((r) => {
          setLoading(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null); setData(r)
        }, (e) => { setLoading(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const stages = (data && data.stages) || []
      const summary = (data && data.summary) || null
      const toggle = (id) => setOpenId((cur) => (cur === id ? null : id))
      const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥']

      /* 单次得分的详情 */
      const hitDetail = (x) => h('div', { className: 'rt-flow-detail' },
        h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d253')), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, x.target || '—')),
        x.asset_ip ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d142')), h('span', { className: 'rt-mono' }, x.asset_ip)) : null,
        x.vuln_title ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d293')), h('span', null, [x.vuln_cve, x.vuln_title].filter(Boolean).join(' '))) : null,
        h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d294')), h('span', null,
          dt('drill.d295') + x.nth_of_point + dt('drill.d296') + (x.points || 0) + dt('drill.d297'))),
        h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d298')), h('span', null, fmt(x.recorded_at) + (x.recorded_by ? ' · ' + x.recorded_by : ''))),
        x.evidence ? h(Clip, { label: dt('drill.d299'), text: x.evidence }) : null)

      const hitRow = (x) => h('div', {
        key: 'h' + x.id,
        className: 'rt-ap-hit' + (openId === x.id ? ' open' : ''),
        role: 'button', tabIndex: 0,
        onClick: () => toggle(x.id),
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(x.id) } },
      },
        h('div', { className: 'rt-ap-hit-head' },
          h('span', { className: 'rt-ap-pts' + (x.counted ? '' : ' uncounted'), title: x.capped_reason || undefined },
            '+' + (x.counted ? (x.points || 0) : 0)),
          h('span', { className: 'rt-ap-hit-name' }, x.point_name),
          x.capped ? h('span', { className: 'rt-tag rt-tag-warn', title: x.capped_reason || dt('drill.d300') }, dt('drill.d301')) : null,
          x.nth_of_point > 1 ? h('span', { className: 'rt-ap-nth' }, dt('drill.d302') + x.nth_of_point + dt('drill.d115')) : null,
          h('span', { className: 'rt-ap-hit-target' }, x.target || x.asset_ip || '—')),
        x.action
          ? h('div', { className: 'rt-ap-act' + (x.action_inferred ? ' inferred' : '') },
              dt('drill.d303') + (x.action.title || dt('drill.d304')) + (x.action_inferred ? [dt('drill.k30029')] : ''))
          : null,
        openId === x.id ? hitDetail(x) : null)

      /* 资产行（信息收集阶段 / 各阶段涉及资产） */
      const assetRow = (a) => h('div', { key: 'a' + a.id, className: 'rt-ap-asset' },
        h('span', { className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external') },
          a.scope === 'internal' ? [dt('drill.k30007')] : dt('drill.d62')),
        h('span', { className: 'rt-mono', style: { fontWeight: 600 } }, a.ip),
        a.segment_cidr ? h('span', { className: 'rt-ap-nth' }, a.segment_cidr) : null,
        h('span', { className: 'rt-ap-nth' }, dt('drill.d305') + (a.open_ports || 0)),
        a.vulns ? h('span', { className: 'rt-ap-nth' }, dt('drill.d306') + a.vulns) : null,
        a.priority ? h('span', { className: 'rt-tag' }, dt('drill.d307') + a.priority) : null,
        h('div', { className: 'rt-spacer' }),
        h('span', { className: 'rt-ap-pts' }, '+' + (a.points || 0) + dt('drill.d297')),
        h('span', { className: 'rt-ap-nth' }, (a.hits || 0) + dt('drill.d115')))

      /* 攻击链只讲"打到哪了、拿了多少分"：不展示打法要点与工具清单，
         那些是执行细节，混在链路里会淹没得分与资产信息。 */

      /* ── A：竖向攻击链 ─────────────────────────────────────────── */
      const stageA = (st, i) => {
        const isRecon = st.code === 'recon'
        const body = []
        if (isRecon) {
          body.push(h('div', { key: 'at', className: 'rt-ap-sub' }, dt('drill.d308') + st.assetCount + dt('drill.d60')))
          body.push(h('div', { key: 'al', className: 'rt-ap-assets' },
            st.assets.length ? st.assets.map(assetRow) : h('div', { className: 'rt-ap-none' }, dt('drill.d309'))))
        } else {
          body.push(h('div', { key: 'ht', className: 'rt-ap-sub' },
            dt('drill.d310') + st.hits + dt('drill.d115') + (st.points ? ' · +' + st.points + [dt('drill.k30030')] : '')))
          body.push(h('div', { key: 'hl', className: 'rt-ap-hits rt-timeline' },
            st.items.length ? st.items.map(hitRow) : h('div', { className: 'rt-ap-none' }, dt('drill.d311'))))
          if (st.code === 'boundary') {
            const selfOnly = (st.tunnels_self_only || []).length
            body.push(h('div', { key: 'tt', className: 'rt-ap-sub' },
              dt('drill.d312') + st.tunnels.length + dt('drill.d313') + (selfOnly ? dt('drill.d314') + selfOnly + [dt('drill.k30031')] : '')))
            if (selfOnly && st.tunnels.length === 0) {
              body.push(h('div', { key: 'tw', className: 'rt-ap-none' },
                dt('drill.d315')))
            }
            body.push(h('div', { key: 'tl', className: 'rt-ap-tunnels' },
              st.tunnels.length
                ? st.tunnels.map((t) => h('div', { key: 't' + t.id, className: 'rt-ap-tunnel' },
                    h('span', { className: 'rt-tag rt-tag-passive' }, t.kind || 'tunnel'),
                    h('span', { className: 'rt-mono', style: { fontWeight: 600 } }, t.listen || '—'),
                    h('span', {
                      className: 'rt-tag ' + (t.status === 'active' ? 'rt-tag-live' : ''),
                      style: t.status === 'active' ? {} : { opacity: .7 },
                    }, t.status === 'active' ? [dt('drill.k30017')] : (t.status || dt('drill.d32'))),
                    h('span', { className: 'rt-ap-nth', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
                      dt('drill.d316') + (t.reach || '—'))))
                : h('div', { className: 'rt-ap-none' }, dt('drill.d317'))))
          }
          if (st.assets.length && st.code !== 'boundary') {
            body.push(h('div', { key: 'at', className: 'rt-ap-sub' }, dt('drill.d318') + st.assetCount + dt('drill.d60')))
            body.push(h('div', { key: 'al', className: 'rt-ap-assets rt-timeline' }, st.assets.map(assetRow)))
          }
        }

        return h('div', { key: 'st' + st.code, className: 'rt-ap-stage' },
          h('div', { className: 'rt-ap-head', style: { borderLeftColor: st.color } },
            h('span', { className: 'rt-ap-no', style: { background: st.color } }, CIRCLED[i] || ('0' + (i + 1))),
            h('span', { className: 'rt-ap-name' }, st.name),
            st.subtitle ? h('span', { className: 'rt-ap-en' }, st.subtitle) : null,
            h('div', { className: 'rt-spacer' }),
            st.points > 0 ? h('span', { className: 'rt-ap-pts', style: { background: st.color + '22', color: st.color, borderColor: st.color + '66' } }, '+' + st.points) : null,
            h('span', { className: 'rt-ap-cum' }, dt('drill.d319') + st.cumulative + dt('drill.d297'))),
          h('div', { className: 'rt-ap-goal', style: { borderLeftColor: st.color } },
            h('span', { className: 'rt-ap-goal-tag', style: { color: st.color, borderColor: st.color + '66' } }, dt('drill.d320')),
            h('span', null, st.goal)),
          h('div', { className: 'rt-ap-result', style: { borderLeftColor: st.color } }, body),
          i < stages.length - 1
            ? h('div', { className: 'rt-ap-trans' },
                h('span', { className: 'rt-flow-arrow' }, '▼'),
                st.transition ? h('span', { className: 'rt-ap-trans-t' }, st.transition) : null,
                h('span', { className: 'rt-ap-trans-t', style: { marginLeft: 'auto' } }, dt('drill.d319') + st.cumulative + dt('drill.d297')))
            : h('div', { className: 'rt-ap-trans' },
                h('span', { className: 'rt-flow-arrow' }, '▼'),
                h('span', { className: 'rt-ap-trans-t' }, dt('drill.d321') + ((summary && summary.points) || 0) + dt('drill.d297'))))
      }

      /* ── B：横向攻击链（一屏看完） ─────────────────────────────── */
      const stageB = (st, i) => h('div', { key: 'c' + st.code, className: 'rt-ap-col' },
        i > 0 ? h('span', { className: 'rt-ap-col-arrow' }, '▶') : null,
        h('div', { className: 'rt-hcol', style: { borderTopColor: st.color } },
          h('div', { className: 'rt-ap-head', style: { borderLeftColor: st.color, padding: '5px 8px' } },
            h('span', { className: 'rt-ap-no', style: { background: st.color, width: 16, height: 16, fontSize: 10 } }, String(i + 1)),
            h('span', { className: 'rt-ap-name', style: { fontSize: 12 } }, st.name),
            h('div', { className: 'rt-spacer' }),
            h('span', { className: 'rt-ap-cum', style: { fontWeight: 700 } }, st.cumulative)),
          h('div', { className: 'rt-hcol-goal', title: st.goal }, st.goal),
          h('div', { className: 'rt-hcol-body' },
            st.code === 'boundary'
              ? h('div', null,
                  h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, '+' + st.points), h('span', { className: 'rt-hcol-name' }, dt('drill.d322') + st.tunnels.length + dt('drill.d313'))),
                  st.tunnels.slice(0, 3).map((t) => h('div', { key: 't' + t.id, className: 'rt-hcol-sub' }, '▸ ' + (t.kind || '') + ' ' + (t.listen || ''))))
              : st.code === 'recon'
                ? h('div', null,
                    h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, st.assetCount), h('span', { className: 'rt-hcol-name' }, dt('drill.d323'))),
                    st.assets.slice(0, 6).map((a) => h('div', { key: 'a' + a.id, className: 'rt-hcol-sub', title: a.ip + '  +' + a.points + dt('drill.d297') },
                      (a.scope === 'internal' ? [dt('drill.k30032')] : dt('drill.d324')) + a.ip + '  +' + a.points)))
                : h('div', null,
                    h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, '+' + st.points), h('span', { className: 'rt-hcol-name' }, st.hits + dt('drill.d325'))),
                    st.items.slice(0, 6).map((x) => h('div', { key: 'c' + x.id, className: 'rt-hcol-sub', title: x.point_name + '  ' + (x.target || '') },
                      h('span', { className: 'rt-hcol-pts' }, '+' + x.points), h('span', { className: 'rt-hcol-name' }, x.point_name))),
                    st.items.length > 6 ? h('div', { className: 'rt-hcol-none' }, dt('drill.d224') + (st.items.length - 6) + dt('drill.d115')) : null,
                    st.assetCount ? h('div', { className: 'rt-hcol-none' }, dt('drill.d326') + st.assetCount + dt('drill.d327')) : null))))

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, dt('drill.d328')),
          h('span', { className: 'rt-tag', style: { fontSize: 10.5 } }, dt('drill.d329')),
          summary ? h('span', { className: 'rt-tag rt-tag-live' }, dt('drill.d330') + summary.points + dt('drill.d297')) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn' + (view === 'A' ? ' rt-btn-primary' : ''), title: dt('drill.d331'), onClick: () => setView('A') }, dt('drill.d332')),
          h('button', { className: 'rt-btn' + (view === 'B' ? ' rt-btn-primary' : ''), title: dt('drill.d333'), onClick: () => setView('B') }, dt('drill.d334')),
          h('button', { className: 'rt-btn', disabled: loading, onClick: load }, loading ? [dt('drill.k30033')] : dt('drill.d82'))),
        err ? h('div', { className: 'rt-err' }, err) : null,
        !stages.length && !err && data !== null
          ? h(EmptyState, { text: dt('drill.d335'), action: h('button', { className: 'rt-btn', onClick: load }, dt('drill.d82')) })
          : view === 'A'
            ? h('div', { className: 'rt-ap' }, stages.map(stageA))
            : h('div', { className: 'rt-ap-h' }, stages.map(stageB)))
    }

    /* ---------------------------------------------------------- 得分复现报告 */
    /**
     * 报告分组兜底：host 只给平铺条目时，用 scoreChain 的阶段信息把条目按攻击链顺序分组。
     * 依据是两边共同的 score_hit id —— scoreChain 的每条 item 都带 stage_code，
     * scoreReport 的每条 item 带同样的 id。这样即使 host 侧版本较旧或阶段行缺失，
     * 报告页也能正常显示，而不是误报"还没有可交付的成果"。
     */
    function groupByStage(reportItems, chain) {
      const byId = new Map((reportItems || []).map((x) => [x.id, x]))
      const groups = []
      const stageList = (chain && chain.stages) || []
      stageList.forEach((st, si) => {
        const items = (st.items || []).map((x) => byId.get(x.id)).filter(Boolean)
        if (items.length === 0) return
        groups.push({ code: st.code, name: st.name, color: st.color || 'var(--dsw-alias-label-secondary, #64748b)',
          ordinal: st.ordinal || si + 1, points: st.points || 0, cumulative: st.cumulative || 0, items })
      })
      /* scoreChain 完全没有阶段信息时，至少把得分归到「其他」，不要让条目凭空消失 */
      const grouped = new Set(groups.reduce((acc, g) => acc.concat(g.items.map((x) => x.id)), []))
      const rest = (reportItems || []).filter((x) => !grouped.has(x.id))
      if (rest.length > 0) {
        groups.push({ code: 'other', name: dt('drill.d336'), color: 'var(--dsw-alias-label-secondary, #64748b)', ordinal: groups.length + 1,
          points: rest.reduce((n, x) => n + (x.counted ? x.points : 0), 0),
          cumulative: 0, items: rest })
      }
      return groups
    }

    function ReportTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      /* 报告按阶段折叠：默认全开，折叠状态按靶标记住（阶段多时便于逐段交付） */
      const collapse = useCollapse('report:' + eng)

      const load = () => {
        if (!eng) return
        setBusy(true); setMsg(null)
        api({ op: 'scoreReport', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setBusy(false); setErr((r && r.error) || dt('drill.d337')); return }
          /* 老 host 只给平铺条目、不给阶段分组（或阶段行缺失）：自己按攻击链分组，
             否则报告页会误报dt('drill.d338')。分组数据取自 scoreChain。 */
          if ((!r.stages || r.stages.length === 0) && (r.items || []).length > 0) {
            api({ op: 'scoreChain', engagement: eng }).then((c) => {
              setBusy(false); setErr(null); setData(Object.assign({}, r, { stages: groupByStage(r.items, c) }))
            }, () => { setBusy(false); setErr(null); setData(r) })
            return
          }
          setBusy(false); setErr(null); setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      /* 复制结果必须是真实的：clipboard API 失败时（非安全上下文/失焦/被拒）要如实提示，
         否则用户以为复制成功、粘到 Yakit 里是空的。 */
      const copy = (text, label) => copyWithFeedback(text, label, (okFlag, message) => {
        setMsg(okFlag ? { ok: message } : { err: message })
      })
      const download = (text, label) => {
        try {
          const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'report-' + String(label || 'score').replace(/[^\w.\-]/g, '_') + '.md'
          a.click()
          /* 立刻 revoke 会在部分浏览器里让 click 启动的下载断流，延后一拍 */
          setTimeout(() => { try { URL.revokeObjectURL(url) } catch { /* ignore */ } }, 1000)
          setMsg({ ok: dt('drill.d339') + label })
        } catch (e) { setMsg({ err: dt('drill.d340') + ((e && e.message) || e) }) }
      }

      const items = (data && data.items) || []
      const stages = (data && data.stages) || []
      const summary = (data && data.summary) || null
      const mdText = (data && data.markdown) || ''
      const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']

      /* 每项一条，平铺不折叠：目标 → 拿到什么 → 复现请求（可直接粘进 Yakit）→ 响应 */
      const card = (x) => h('div', { key: 'r' + x.id, className: 'rt-rep' },
        h('div', { className: 'rt-rep-head' },
          h('span', { className: 'rt-rep-idx' }, String(x.seq)),
          h('span', { className: 'rt-rep-name' }, x.point_name),
          h('span', { className: 'rt-flow-pts' }, '+' + x.points + dt('drill.d297')),
          x.nth_of_point > 1 ? h('span', { className: 'rt-tag' }, dt('drill.d295') + x.nth_of_point + dt('drill.d115')) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: () => copy((x.requests || []).map((v) => v.request || '').filter(Boolean).join('\n\n'), dt('drill.d302') + x.seq + dt('drill.d341')),
          }, dt('drill.d342'))),
        h('div', { className: 'rt-rep-meta' },
          h('span', null, h('b', null, dt('drill.d343'))), h('span', { className: 'rt-mono' }, x.target || x.asset_ip || '—')),
        x.gained ? h('div', { className: 'rt-rep-meta' }, h('b', null, dt('drill.d344')), h('span', null, x.gained)) : null,
        x.vuln ? h('div', { className: 'rt-rep-meta' }, h('b', null, dt('drill.d345')),
          h('span', null, [x.vuln.cve, x.vuln.title].filter(Boolean).join(' '))) : null,
        x.evidence ? h('div', { className: 'rt-rep-meta' }, h('b', null, dt('drill.d346')),
          h('span', null, String(x.evidence).replace(/\n+/g, ' '))) : null,
        x.recorded_at ? h('div', { className: 'rt-rep-meta' }, h('b', null, dt('drill.d347')),
          h('span', null, fmt(x.recorded_at) + (x.recorded_by ? '（' + (ROLE_LABEL[x.recorded_by] || x.recorded_by) + '）' : ''))) : null,
        h(ShotStrip, { eng: eng, shots: x.shots, total: x.shot_total, title: dt('drill.d28') }),
        /* ── 复现步骤：动作记录（含实际命令与回显）+ 凭据 + 隧道 + WebShell ─────
           报告的交付价值全在这块：账号密码怎么来的、隧道怎么搭的，用户照着就能复现。 */
        h('details', { className: 'rt-rep-trace', open: x.incomplete === true || (x.steps || []).length === 0 },
          h('summary', { className: 'rt-rep-trace-head', style: { cursor: 'pointer' } },
            h('span', { className: 'rt-rep-trace-title' }, dt('drill.d348')),
            (x.steps || []).length ? h('span', { className: 'rt-tag' }, (x.steps || []).length + dt('drill.d349')) : null,
            (x.credentials || []).length ? h('span', { className: 'rt-tag' }, (x.credentials || []).length + dt('drill.d350')) : null,
            (x.tunnels || []).length ? h('span', { className: 'rt-tag' }, (x.tunnels || []).length + dt('drill.d351')) : null,
            x.incomplete ? h('span', { className: 'rt-tag rt-tag-warn' }, dt('drill.d352')) : h('span', { className: 'rt-tag rt-tag-live' }, dt('drill.d353'))),
          h('div', { style: { paddingTop: 6 } },
          x.how ? h('div', { className: 'rt-rep-trace-how' }, x.how) : null,
          (x.steps || []).length === 0
            ? h('div', { className: 'rt-rep-missing' },
                dt('drill.d354'))
            : (x.steps || []).map((s, si) => h('div', { key: 's' + s.id, className: 'rt-rep-step' },
                h('div', { className: 'rt-rep-step-head' },
                  h('span', { className: 'rt-rep-step-no' }, String(si + 1)),
                  h('span', { className: 'rt-rep-step-title' }, s.title || dt('drill.d355')),
                  s.agent ? h('span', { className: 'rt-tag' }, ROLE_LABEL[s.agent] || s.agent) : null,
                  s.stage_code ? h('span', { className: 'rt-tag' }, s.stage_code) : null,
                  s.inferred ? h('span', { className: 'rt-tag' }, dt('drill.d356')) : null,
                  h('div', { className: 'rt-spacer' }),
                  s.recorded_at ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, fmt(s.recorded_at)) : null),
                s.detail ? h('div', { className: 'rt-rep-step-detail' }, s.detail) : null,
                h('div', { className: 'rt-rep-step-cmd' },
                  h('b', null, dt('drill.d357')),
                  s.tool
                    ? h('span', { className: 'rt-mono' }, s.tool)
                    : h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } }, dt('drill.d358'))),
                s.tool ? h('div', { style: { marginTop: 3 } },
                  h('button', {
                    className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                    onClick: () => copy(String(s.tool), dt('drill.d302') + (si + 1) + dt('drill.d359')),
                  }, dt('drill.d360'))) : null,
                s.result ? h('div', { className: 'rt-rep-step-result' }, h('b', null, dt('drill.d346')), String(s.result).replace(/\n+/g, ' ')) : null,
                s.evidence_ref ? h('div', { className: 'rt-rep-step-result' }, h('b', null, dt('drill.d24')), h('span', { className: 'rt-mono' }, s.evidence_ref)) : null)),
          /* 账号密码怎么来的：凭据的来源 + 取得方式 */
          (x.credentials || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, dt('drill.d361')),
                (x.credentials || []).map((c) => h('div', { key: 'c' + c.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, c.host || '—'),
                  h('span', null, (c.username || dt('drill.d362')) + ' / ' + (c.secret_type || 'password')
                    + (c.privilege ? dt('drill.d363') + c.privilege : '')
                    + dt('drill.d364') + (c.source || dt('drill.d365'))
                    + (c.tool ? dt('drill.d366') + String(c.tool).replace(/\n+/g, ' ').slice(0, 160) : '')))))
            : null,
          /* 隧道怎么搭的 */
          (x.tunnels || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, dt('drill.d367')),
                (x.tunnels || []).map((t) => h('div', { key: 't' + t.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, (t.kind || 'socks5') + ' ' + (t.listen || '')),
                  h('span', null, dt('drill.d368') + (t.entry || dt('drill.d369'))
                    + (t.reach ? dt('drill.d370') + t.reach : '')
                    + dt('drill.d371') + (t.entry_kind || dt('drill.d372'))
                    + (t.legit === false ? [dt('drill.k30034')] : '')
                    + (t.status ? ' · ' + t.status : '')
                    + (t.command ? dt('drill.d373') + String(t.command).replace(/\n+/g, ' ').slice(0, 160) : '')))))
            : null,
          (x.webshells || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, dt('drill.d374')),
                (x.webshells || []).map((w) => h('div', { key: 'w' + w.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, w.shell_type || 'shell'),
                  h('span', null, (w.url || '') + (w.pass_key ? dt('drill.d375') + w.pass_key : '')
                    + (w.privilege ? dt('drill.d363') + w.privilege : '') + (w.status ? ' · ' + w.status : '')))))
            : null,
          (x.gaps || []).length ? h('div', { className: 'rt-rep-missing' }, dt('drill.d376') + x.gaps.join('；')) : null),
        (x.requests || []).length === 0
          ? h('div', { className: 'rt-rep-missing' }, dt('drill.d377'))
          : (x.requests || []).map((r, ri) => h('div', { key: 'q' + ri, className: 'rt-rep-req' },
              h('div', { className: 'rt-rep-req-head' },
                h('span', null, dt('drill.d378') + (ri + 1) + (r.source === 'auto' ? [dt('drill.k30035')] : '')),
                h('span', { className: 'rt-tag' }, (r.method || 'GET') + ' ' + (r.status === null || r.status === undefined ? '' : r.status)),
                h('div', { className: 'rt-spacer' }),
                h('button', {
                  className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                  onClick: () => copy(String(r.request || ''), dt('drill.d379') + (ri + 1)),
                }, dt('drill.d380'))),
              h('pre', { className: 'rt-rep-http' }, r.request || ((r.method || 'GET') + ' ' + (r.url || '') + ' HTTP/1.1')),
              r.response ? h('div', null,
                h('div', { className: 'rt-rep-req-head' }, h('span', null, dt('drill.d381'))),
                h('pre', { className: 'rt-rep-http', style: { maxHeight: 160 } }, String(r.response).slice(0, 1600))) : null)),
        x.note ? h('div', { className: 'rt-rep-meta' }, h('b', null, dt('drill.d382')), h('span', null, x.note)) : null))

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, dt('drill.d383')),
          summary ? h('span', { className: 'rt-tag rt-tag-live' }, dt('drill.d321') + summary.points + dt('drill.d297')) : null,
          summary ? h('span', { className: 'rt-tag' }, summary.count + dt('drill.d384')) : null,
          summary ? h('span', { className: 'rt-tag' + (summary.missingRequests ? '' : ' rt-tag-live') },
            summary.withRequests + '/' + summary.count + dt('drill.d385')) : null,
          summary ? h('span', {
            className: 'rt-tag' + (summary.incomplete ? ' rt-tag-warn' : ' rt-tag-live'),
            title: dt('drill.d386'),
          }, dt('drill.d387') + (summary.count - (summary.incomplete || 0)) + '/' + summary.count) : null,
          summary && summary.serviceCappedExcluded
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: (summary.serviceCapped || []).map((x) => (x.service || '') + '｜' + (x.point_name || '')).join('\n')
                  || dt('drill.d388'),
              }, dt('drill.d389') + summary.serviceCappedExcluded)
            : null,
          h('div', { className: 'rt-spacer' }),
          /* 报告只有两个动作：复制 / 导出。报告不会自己变，「重新生成」价值最低（Lead 裁定砍掉）；
             空态里仍保留一个「先生成报告」的主操作，那是没有报告时唯一的出路。 */
          h('button', { className: 'rt-btn', disabled: busy || !mdText, onClick: () => copy(mdText, dt('drill.d390')) }, dt('drill.d391')),
          h('button', { className: 'rt-btn', disabled: busy || !mdText, onClick: () => download(mdText, (data && data.target) || eng) }, dt('drill.d392'))),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          stages.length
            ? h('div', { className: 'rt-rep-list rt-prose' },
                h('div', { className: 'rt-rep-tools' },
                  h('button', { className: 'rt-btn', onClick: () => collapse.setAll(stages.map((s) => 'st:' + s.code), true) }, dt('drill.d282')),
                  h('button', { className: 'rt-btn', onClick: () => collapse.setAll(stages.map((s) => 'st:' + s.code), false) }, dt('drill.d394'))),
                stages.map((st) => {
                  const open = collapse.isOpen('st:' + st.code, true)
                  const toggle = collapse.toggle('st:' + st.code, true)
                  return h('div', { key: 'g' + st.code, className: 'rt-rep-group' },
                    h('div', {
                      className: 'rt-rep-stage', role: 'button', tabIndex: 0,
                      style: { borderLeftColor: st.color },
                      'aria-expanded': open ? 'true' : 'false',
                      onClick: toggle,
                      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e) } },
                    },
                      h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
                      h('span', { className: 'rt-rep-no', style: { background: st.color } }, CIRCLED[st.ordinal - 1] || st.ordinal),
                      h('span', { className: 'rt-rep-stage-name' }, st.name),
                      h('span', { className: 'rt-rep-stage-n' }, st.items.length + dt('drill.d395')),
                      h('div', { className: 'rt-spacer' }),
                      /* 阶段色可能是宿主数据里的 hex，也可能是上面的 token 兜底串——十六进制拼透明度（+'22'）
                         对后者无效，统一走 color-mix，两种输入都成立 */
                      h('span', { className: 'rt-rep-pts', style: { background: 'color-mix(in srgb, ' + st.color + ' 13%, transparent)', color: st.color, borderColor: 'color-mix(in srgb, ' + st.color + ' 40%, transparent)' } },
                        '+' + st.points + dt('drill.d297')),
                      h('span', { className: 'rt-ap-cum' }, dt('drill.d319') + st.cumulative + dt('drill.d297'))),
                    open ? h('div', { className: 'rt-rep-body' }, st.items.map(card)) : null)
                }))
            : (data === null ? h(EmptyState, { text: dt('drill.d136') })
                : h(EmptyState, {
                    text: dt('drill.d396'),
                    action: h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: load }, dt('drill.d393')),
                  }))),
        h('div', { className: 'rt-foot' },
          h('span', null, dt('drill.d398'))))
    }

    /* ---------------------------------------------------------- 攻击文件 */
    const FILE_KIND = { poc: 'POC', exp: 'EXP', script: dt('drill.d399'), wordlist: dt('drill.d400'), other: dt('drill.d292') }

    function AttackFilesTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [folders, setFolders] = React.useState([])
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const collapse = useCollapse('files:' + eng)
      const [detail, setDetail] = React.useState(null)

      const load = () => {
        if (!eng) return
        setBusy(true)
        api({ op: 'attackFiles', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null)
          setFolders(r.items || [])
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const openFile = (f) => {
        if (detail && detail.id === f.id) { setDetail(null); return }
        setDetail(null)
        api({ op: 'readAttackFile', engagement: eng, id: f.id }).then((r) => {
          if (r && r.ok) setDetail(r)
          else setErr((r && r.error) || dt('drill.d165'))
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const rows = []
      for (const folder of folders) {
        const fKey = 'folder:' + folder.folder
        const fileNodes = []
        for (const f of folder.files) {
          fileNodes.push(h('div', {
            key: 'a' + f.id, className: 'rt-vrow', style: { gridTemplateColumns: '18px 1.2fr 60px 1.6fr', cursor: 'pointer' },
            role: 'button', tabIndex: 0,
            onClick: () => openFile(f),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(f) } },
          },
            h('span', { className: 'rt-sec-caret' }, detail && detail.id === f.id ? '▾' : '▸'),
            h('span', { className: 'rt-mono' }, f.name),
            h('span', null, h('span', { className: 'rt-tag rt-tag-active' }, FILE_KIND[f.kind] || f.kind || '—')),
            h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }, title: f.description || '' }, f.description || '—')))
          if (!detail || detail.id !== f.id) continue
          fileNodes.push(h('div', {
            key: 'ad' + f.id, className: 'rt-vrow', style: { cursor: 'default', gridTemplateColumns: '1fr' },
          }, h('div', { className: 'rt-vdetail' },
            h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d401')), h('span', null, detail.evidence || '—')),
            h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d402')), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, detail.path)),
            h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d298')), h('span', null, fmt(detail.created_at) + (detail.created_by ? ' · ' + detail.created_by : ''))),
            h('pre', { className: 'rt-md', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, maxHeight: '40vh', padding: '10px 12px' } }, detail.content || dt('drill.d175')))))
        }
        rows.push(h(Section, {
          key: 'sec:' + folder.folder, tone: 'folder', title: folder.folder + '/',
          count: folder.count + dt('drill.d403'),
          open: collapse.isOpen(fKey, true), onToggle: collapse.toggle(fKey, true),
        }, fileNodes.length ? fileNodes : h('div', { className: 'rt-atest-meta' }, dt('drill.d175'))))
      }

      const total = folders.reduce((n, f) => n + f.count, 0)
      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, dt('drill.d258')),
          h('span', { className: 'rt-tag' }, folders.length + dt('drill.d404') + total + dt('drill.d403')),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? [dt('drill.k30020')] : dt('drill.d82'))),
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-table' },
          rows,
          !folders.length ? h('div', { className: 'rt-empty' }, dt('drill.d405')) : null),
        h('div', { className: 'rt-foot' }, h('span', null, dt('drill.d406'))))
    }

    /* ---------------------------------------------------------- 知识库（POC/EXP，全局共享） */
    /**
     * 知识库页：打 Nday/1day 之前先在这里搜。检索框支持 CVE / 组件 / 关键字 / 正文关键词；
     * 命中就展开拿全文（可直接复制去用），没有就说明要去互联网找或自己搓，验证后回填。
     * 这里是**全局**的：不随靶标切换，一个靶标沉淀的通用 POC 后面所有靶标都能用。
     */
    const POC_KIND_LABEL = { poc: 'POC', exp: 'EXP', script: dt('drill.d399'), template: dt('drill.d407'), payload: dt('drill.d408') }
    const POC_SOURCE_LABEL = { web: dt('drill.d409'), self: dt('drill.d410'), manual: dt('drill.d411'), 'nuclei-template': dt('drill.d412'), kb: dt('drill.d413') }

    function KnowledgeTab(props) {
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [kind, setKind] = React.useState('')
      const [category, setCategory] = React.useState('')
      const [engagement, setEngagement] = React.useState('')
      const [assetTarget, setAssetTarget] = React.useState('')
      const [grouped, setGrouped] = React.useState(true)
      const [verifiedOnly, setVerifiedOnly] = React.useState(false)
      const [openId, setOpenId] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [detailBusy, setDetailBusy] = React.useState(false)
      const [tplOffset, setTplOffset] = React.useState(0)
      const tplPageSize = 40

      const query = (over) => {
        const extra = over || {}
        const offset = Object.prototype.hasOwnProperty.call(extra, 'templateOffset') ? extra.templateOffset : 0
        setTplOffset(offset)
        const params = Object.assign({
          q: q.trim() || undefined,
          kind: kind || undefined,
          category: category || undefined,
          engagement: engagement || undefined,
          asset_target: assetTarget.trim() || undefined,
          verified: verifiedOnly || undefined,
          templateOffset: offset || 0,
          templateLimit: tplPageSize,
        }, extra)
        setBusy(true); setMsg(null)
        api(Object.assign({ op: 'pocSearch' }, params)).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null); setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      /* 首次进入与刷新键变化时拉全量（检索是显式动作，避免边打字边打接口） */
      React.useEffect(() => { query({ q: undefined, kind: undefined, category: undefined, engagement: undefined, asset_target: undefined, verified: undefined }) }, [refreshKey])

      const open = (id) => {
        if (openId === id) { setOpenId(null); setDetail(null); return }
        setOpenId(id); setDetail(null); setDetailBusy(true)
        api({ op: 'pocGet', id: id }).then((r) => {
          setDetailBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d165') }); return }
          setDetail(r)
        }, (e) => { setDetailBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 同报告页：await 真实结果再提示 */
      const copy = (text, label) => copyWithFeedback(text, label, (okFlag, message) => {
        setMsg(okFlag ? { ok: message } : { err: message })
      })
      const useIt = (row) => {
        api({ op: 'pocUse', id: row.id, used_on: dt('drill.d414') }).then(() => {
          setMsg({ ok: dt('drill.d415') + row.title })
          query()
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const stats = (data && data.stats) || { total: 0, verified: 0, reused: 0, byKind: [], bySource: [] }
      const items = (data && data.items) || []
      const tpl = (data && data.templates) || { dir: null, total: 0, matched: 0, offset: 0, items: [], byCategory: [] }
      const tplByCat = new Map((tpl.byCategory || []).map((c) => [c.code, c.n || 0]))
      const catShown = (c) => (c.n || 0) + (tplByCat.get(c.code) || 0)
      const tplItems = tpl.items || []
      const tplMatched = tpl.matched != null ? tpl.matched : tpl.total
      const tplStart = Number(tpl.offset) || 0
      const turnTpl = (next) => {
        const offset = Math.max(0, next)
        setTplOffset(offset)
        query({ templateOffset: offset })
      }

      const card = (x) => {
        const isOpen = openId === x.id
        const d = isOpen && detail && detail.id === x.id ? detail : null
        return h('div', { key: 'p' + x.id, className: 'rt-kb' + (isOpen ? ' open' : '') },
          h('div', {
            className: 'rt-kb-head', role: 'button', tabIndex: 0, 'aria-expanded': isOpen ? 'true' : 'false',
            onClick: () => open(x.id),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(x.id) } },
          },
            h('span', { className: 'rt-sec-caret' }, isOpen ? '▾' : '▸'),
            h('span', { className: 'rt-kb-kind k-' + (x.kind || 'poc') }, POC_KIND_LABEL[x.kind] || x.kind || 'POC'),
            h('span', { className: 'rt-kb-title' }, x.title),
            x.cve ? h('span', { className: 'rt-tag rt-tag-passive' }, x.cve) : null,
            x.component ? h('span', { className: 'rt-tag' }, x.component) : null,
            x.verified === 1
              ? h('span', { className: 'rt-tag rt-tag-live' }, dt('drill.d416'))
              : h('span', { className: 'rt-tag rt-tag-warn' }, dt('drill.d417')),
            h('div', { className: 'rt-spacer' }),
            h('span', { className: 'rt-tag' }, POC_SOURCE_LABEL[x.source] || x.source || '—'),
            x.hit_count ? h('span', { className: 'rt-tag' }, dt('drill.d418') + x.hit_count) : null),
          /* 来源行：归类 · 影响版本 · 建立时间 · 来源靶标 · 发现资产 —— 一条知识"什么时候、
             在哪个单位的哪台资产上发现的"一眼可见 */
          h('div', { className: 'rt-kb-sub' },
            [x.category ? dt('drill.d419') + (POC_CAT_NAME[x.category] || x.category) : null,
              x.versions ? dt('drill.d420') + x.versions : null,
              x.language || null,
              x.tags || null,
              dt('drill.d421') + fmt(x.created_at),
              (x.engagement_name || x.engagement_id) ? dt('drill.d422') + (x.engagement_name || x.engagement_id) : null,
              x.asset_target ? dt('drill.d423') + x.asset_target : null,
              x.found_by_agent ? dt('drill.d424') + (ROLE_LABEL[x.found_by_agent] || x.found_by_agent) : null,
              x.source_url ? dt('drill.d192') + x.source_url : null].filter(Boolean).join(' · ')),
          isOpen
            ? h('div', { className: 'rt-kb-body' },
                detailBusy && !d ? h('div', { className: 'rt-empty' }, dt('drill.d425')) : null,
                d ? h('div', null,
                  d.usage ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d426')), h('span', { className: 'rt-mono' }, d.usage)) : null,
                  d.description ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d427')), h('span', null, d.description)) : null,
                  d.verified_note ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d428')), h('span', null, d.verified_note)) : null,
                  d.used_on ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d429')), h('span', null, d.used_on)) : null,
                  d.path ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d430')), h('span', { className: 'rt-mono' }, d.path)) : null,
                  h('div', { className: 'rt-kb-actions' },
                    h('button', { className: 'rt-btn', disabled: !d.content, onClick: () => copy(d.content || '', dt('drill.d431')) }, dt('drill.d432')),
                    h('button', { className: 'rt-btn', onClick: () => useIt(x) }, dt('drill.d433')),
                    d.source_url ? h('button', { className: 'rt-btn', onClick: () => copy(d.source_url, dt('drill.d434')) }, dt('drill.d435')) : null),
                  d.content
                    ? h('pre', { className: 'rt-rep-http' }, d.content.length > 12000 ? d.content.slice(0, 12000) + [dt('drill.k30037')] : d.content)
                    : h('div', { className: 'rt-empty' }, dt('drill.d436')))
                : null)
            : null)
      }

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', null, dt('drill.d437')),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn' + (grouped ? ' rt-btn-primary' : ''), title: dt('drill.d443'), onClick: () => setGrouped(!grouped) }, grouped ? [dt('drill.k30038')] : dt('drill.d444')),
          h('button', { className: 'rt-btn', disabled: busy, onClick: () => query() }, busy ? [dt('drill.k30039')] : dt('drill.d82'))),
        /* 计数行：数字大、标签小（原来是一排 tag，读不出「哪个数是主指标」） */
        h('div', { style: { padding: '0 0 5px' } },
          h(StatRow, {
            groups: [{
              key: 'kb',
              items: [
                { key: 'total', label: dt('drill.d313').trim(), value: stats.total },
                { key: 'verified', label: dt('drill.d438').trim(), value: stats.verified },
                { key: 'reused', label: dt('drill.d439').trim(), value: stats.reused || 0 },
                { key: 'templates', label: dt('drill.d442').trim(), value: tpl.total || 0 },
              ],
            }],
          })),
        /* 归类总览：点一下就是按该类筛选，一眼看清"哪类武器攒了多少、哪类还是空的" */
        h('div', { className: 'rt-kb-cats' },
          (stats.byCategory || []).filter((c) => catShown(c) > 0 || POC_CAT_ORDER.includes(c.code)).map((c) => h('span', {
            key: c.code,
            className: 'rt-concl-i' + (category === c.code ? ' on' : ''),
            title: (c.hint || POC_CAT_NAME[c.code] || c.code)
              + dt('drill.d445') + (tplByCat.get(c.code) || 0)
              + dt('drill.d446') + (c.n || 0)
              + (c.verified ? dt('drill.d447') + c.verified + '）' : ''),
            onClick: () => {
              const next = category === c.code ? '' : c.code
              setCategory(next)
              query({ category: next || undefined })
            },
          },
            h('b', null, String(catShown(c))),
            h('span', null, (POC_CAT_NAME[c.code] || c.code) + (c.verified ? dt('drill.d447') + c.verified + '）' : ''))))),
        h('div', { className: 'rt-kb-filter' },
          h('input', {
            className: 'rt-input', style: { flex: 1, minWidth: 140 }, placeholder: dt('drill.d448'),
            value: q, onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') query() },
          }),
          h('select', { className: 'rt-input', style: { maxWidth: 120 }, value: category, onChange: (e) => { setCategory(e.target.value); query({ category: e.target.value || undefined }) } },
            h('option', { value: '' }, dt('drill.d449')),
            POC_CAT_ORDER.map((k) => h('option', { key: k, value: k }, POC_CAT_NAME[k]))),
          h('select', { className: 'rt-input', style: { maxWidth: 120 }, value: engagement, onChange: (e) => { setEngagement(e.target.value); query({ engagement: e.target.value || undefined }) } },
            h('option', { value: '' }, dt('drill.d450')),
            (stats.byEngagement || []).map((e) => h('option', { key: e.engagement, value: e.engagement }, e.engagement + '（' + e.n + '）'))),
          h('input', {
            className: 'rt-input', style: { width: 120 }, placeholder: dt('drill.d451'),
            value: assetTarget, onChange: (e) => setAssetTarget(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') query() },
          }),
          h('select', { className: 'rt-input', style: { maxWidth: 110 }, value: kind, onChange: (e) => { setKind(e.target.value); query({ kind: e.target.value || undefined }) } },
            h('option', { value: '' }, dt('drill.d452')),
            Object.keys(POC_KIND_LABEL).map((k) => h('option', { key: k, value: k }, POC_KIND_LABEL[k]))),
          h('label', { className: 'rt-kb-check' },
            h('input', { type: 'checkbox', checked: verifiedOnly, onChange: (e) => { setVerifiedOnly(e.target.checked); query({ verified: e.target.checked || undefined }) } }),
            dt('drill.d453')),
          h('button', { className: 'rt-btn rt-btn-primary', onClick: () => query() }, dt('drill.d454'))),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' },
          /engagement required|unknown op/i.test(err)
            /* 老 host 还没有知识库接口：讲清怎么恢复，别让人对着 "engagement required" 发懵 */
            ? dt('drill.d455')
            : err) : null,
        !err && data && data.dbPath
          ? h('div', { className: 'rt-foot', style: { marginBottom: 6, fontSize: 11 } },
              dt('drill.d456') + data.dbPath
              + (data.root ? dt('drill.d457') + data.root + '）' : ''))
          : null,
        h('div', { className: 'rt-table' },
          (() => {
            if (!grouped) return items.map(card)
            /* 分组渲染：按内置归类顺序，未知归类挂到末尾的「其它」 */
            const buckets = new Map()
            for (const x of items) {
              const code = POC_CAT_NAME[x.category] ? x.category : 'other'
              if (!buckets.has(code)) buckets.set(code, [])
              buckets.get(code).push(x)
            }
            const order = POC_CAT_ORDER.filter((c) => buckets.has(c))
            for (const code of buckets.keys()) if (!order.includes(code)) order.push(code)
            const out = []
            for (const code of order) {
              const list = buckets.get(code)
              out.push(h('div', { key: 'g' + code, className: 'rt-kb-cat' },
                h('span', { className: 'rt-kb-cat-name' }, POC_CAT_NAME[code] || code),
                h('span', { className: 'rt-tag' }, list.length + dt('drill.d313')),
                h('span', { className: 'rt-tag rt-tag-live' }, dt('drill.d438') + list.filter((x) => x.verified === 1).length),
                h('span', { className: 'rt-spacer' }),
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                  dt('drill.d458') + fmt(list.map((x) => x.created_at).filter(Boolean).sort().pop()))))
              for (const x of list) out.push(card(x))
            }
            return out
          })(),
          tplItems.length
            ? h('div', { className: 'rt-kb-tpl' },
                h('div', { className: 'rt-ap-sub' },
                  dt('drill.d459') + (tplStart + 1) + '–' + (tplStart + tplItems.length) + ' / ' + tplMatched
                  + dt('drill.d460')),
                tplItems.map((t, i) => h('div', { key: 't' + tplStart + '-' + i, className: 'rt-kb-tpl-row' },
                  h('span', { className: 'rt-tag' }, t.severity || '—'),
                  t.category ? h('span', { className: 'rt-tag' }, POC_CAT_NAME[t.category] || t.category) : null,
                  h('span', { className: 'rt-mono rt-kb-tpl-path', title: t.path }, t.path),
                  h('span', { className: 'rt-kb-tpl-name', title: t.name }, t.name || ''),
                  h('button', {
                    className: 'rt-btn', style: { padding: '0 6px', fontSize: 10.5 },
                    onClick: () => copy('nuclei -t ' + t.path + dt('drill.d461'), dt('drill.d462')),
                  }, dt('drill.d360')))),
                h('div', { className: 'rt-kb-actions' },
                  h('button', {
                    className: 'rt-btn', disabled: busy || tplStart <= 0,
                    onClick: () => turnTpl(tplStart - tplPageSize),
                  }, dt('drill.d463')),
                  h('button', {
                    className: 'rt-btn', disabled: busy || tplStart + tplItems.length >= tplMatched,
                    onClick: () => turnTpl(tplStart + tplPageSize),
                  }, dt('drill.d464'))),
                tpl.dir ? h('div', { className: 'rt-foot' }, h('span', null, dt('drill.d465') + tpl.dir)) : null)
            : null,
          data === null ? h('div', { className: 'rt-empty' }, dt('drill.d136')) : null,
          data !== null && !items.length && !tplItems.length
            ? h(EmptyState, {
                text: q || kind || verifiedOnly
                  ? dt('drill.d466')
                  : (tpl.total
                    ? (dt('drill.d467') + tpl.total + dt('drill.d468'))
                    : (tpl.dir ? dt('drill.d469') : dt('drill.d470'))),
                path: data.dbPath || tpl.dir || null,
                action: h('button', { className: 'rt-btn', onClick: () => openDir('knowledge') }, dt('drill.t40open')),
              })
            : null),
        h('div', { className: 'rt-foot' },
          h('span', null, dt('drill.d473'))))
    }

    /* ---------------------------------------------------------- 环境适配（Windows / 非 Kali） */
    /**
     * 借鉴 Z3r0 的「系统配置」思路：路径与密钥进集中配置，不靠 bash/ps1。
     * 落盘 $DSH_HOME/redteam/config.json —— 用户填工具绝对路径或整包搜索目录。
     */
    function EnvTab(props) {
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [folderPath, setFolderPath] = React.useState('')

      const applyDraftFrom = (r) => {
        const c = (r && r.config) || {}
        setDraft({
          platform: c.platform || 'auto',
          toolkitDir: c.toolkitDir || '',
          nucleiTemplatesDir: c.nucleiTemplatesDir || '',
          binDirsText: (c.binDirs || []).join('\n'),
          tools: Object.assign({}, c.tools || {}),
          env: Object.assign({ FOFA_KEY: '', REDTEAM_VPS_HOST: '', REDTEAM_VPS_KEY: '' }, c.env || {}),
          notes: c.notes || '',
        })
        if (c.toolkitDir) setFolderPath(c.toolkitDir)
      }

      const load = () => {
        setBusy(true); setMsg(null)
        api({ op: 'platformConfigGet' }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null); setData(r)
          applyDraftFrom(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [refreshKey])

      const save = () => {
        if (!draft) return
        setBusy(true); setMsg(null)
        const config = {
          platform: draft.platform,
          toolkitDir: draft.toolkitDir,
          nucleiTemplatesDir: draft.nucleiTemplatesDir,
          binDirs: String(draft.binDirsText || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          tools: draft.tools,
          env: draft.env,
          notes: draft.notes,
          envAdaptConfigured: true,
          envAdaptSkip: false,
        }
        api({ op: 'platformConfigSave', config }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d168') }); return }
          setData(r)
          setMsg({ ok: dt('drill.d474') + ((r.config && r.config.path) || '$DSH_HOME/redteam/config.json') })
          applyDraftFrom(r)
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const assignFolder = () => {
        const dir = String(folderPath || (draft && draft.toolkitDir) || '').trim()
        if (!dir) { setMsg({ err: dt('drill.d475') }); return }
        setBusy(true); setMsg(null)
        api({ op: 'platformAssignToolkit', dir }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d476') }); return }
          setData(r)
          applyDraftFrom(r)
          setMsg({
            ok: dt('drill.d477') + (r.assignedCount || 0) + dt('drill.d478')
              + (r.nucleiTemplatesDir ? [dt('drill.k30040')] : ''),
          })
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const setTool = (id, value) => setDraft((d) => d ? Object.assign({}, d, { tools: Object.assign({}, d.tools, { [id]: value }) }) : d)
      const setEnv = (key, value) => setDraft((d) => d ? Object.assign({}, d, { env: Object.assign({}, d.env, { [key]: value }) }) : d)

      const runtime = (data && data.runtime) || {}
      const adapt = (data && data.adapt) || {}
      const tools = (data && data.tools && data.tools.items) || []
      const found = tools.filter((t) => t.path).length
      const defaultToolkit = (data && data.toolkitDir) || '$DSH_HOME/redteam/toolkit'
      const defaultNuclei = (data && data.nucleiTemplatesDir) || (defaultToolkit + '/nuclei-templates')

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', null, dt('drill.d479')),
          h('span', { className: 'rt-badge rt-badge--idle' }, runtime.effective === 'windows' ? 'Windows' : 'Linux/Kali'),
          adapt.kali ? h('span', { className: 'rt-badge rt-badge--ok' }, 'Kali') : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? [dt('drill.k30041')] : dt('drill.d82')),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !draft, onClick: save }, dt('drill.d182'))),
        h('div', { className: 'rt-pane', style: { minHeight: 0 } },
        err ? h('div', { className: 'rt-err' }, err) : null,
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        /* 就绪度：三个数字（工具 / 环境 / 占位），不再是三个彩色 tag */
        h(StatRow, {
          groups: [{
            key: 'env',
            items: [
              { key: 'ready', label: dt('drill.d480').trim(), value: adapt.ready ? dt('drill.k30017') : dt('drill.d481') },
              { key: 'tools', label: dt('drill.d273').trim(), value: found + '/' + tools.length },
              { key: 'kali', label: 'Kali', value: adapt.kali ? dt('drill.k30017') : '—' },
            ],
          }],
        }),
        /* 三条状态各一行：状态点 + 名称 + 一句现状 + 右侧动作 */
        h('div', { className: 'rt-status' },
          h(StatusLine, {
            tone: found && found === tools.length ? 'ok' : 'warn',
            name: dt('drill.d273').trim(),
            detail: found + ' / ' + tools.length,
            action: h('button', { className: 'rt-btn', disabled: busy, onClick: load }, dt('drill.d82')),
          }),
          h(StatusLine, {
            tone: adapt.ready ? 'ok' : 'idle',
            name: dt('drill.d480').trim(),
            detail: adapt.reason || (adapt.ready ? dt('drill.k30017') : dt('drill.d481')),
          }),
          h(StatusLine, {
            tone: adapt.configured ? 'ok' : 'idle',
            name: dt('drill.d483'),
            detail: adapt.message || dt('drill.d482'),
          })),
        /* 未就绪只给一个主操作：保存并重新检测（四个并列按钮会把「该点哪个」推给人） */
        adapt.ready ? null : h('div', { className: 'rt-actions', style: { marginTop: 8 } },
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !draft, onClick: save }, dt('drill.d182'))),
        h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, dt('drill.d483')),
          h('div', { style: { marginBottom: 8, opacity: 0.9 } },
            dt('drill.d484')),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('input', {
              className: 'rt-input', style: { flex: 1 },
              placeholder: dt('drill.d485'),
              value: folderPath,
              onChange: (e) => setFolderPath(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') assignFolder() },
            }),
            h('button', {
              className: 'rt-btn rt-btn-primary', disabled: busy,
              onClick: assignFolder,
            }, busy ? [dt('drill.k30042')] : dt('drill.d486')))),
        data && data.hint ? h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 } }, data.hint) : null,
        data && data.egress ? h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.55 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, dt('drill.d487')),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'HTTP_PROXY=' + (data.egress.http_proxy || dt('drill.d488'))),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'HTTPS_PROXY=' + (data.egress.https_proxy || dt('drill.d488'))),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'ALL_PROXY=' + (data.egress.all_proxy || dt('drill.d488'))),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'NO_PROXY=' + (data.egress.no_proxy || dt('drill.d488'))),
          h('div', { style: { marginTop: 6, opacity: 0.85 } }, data.egress.note || '')) : null,
        !draft ? h('div', { className: 'rt-empty' }, dt('drill.d136')) : h('div', null,
          h('div', { className: 'rt-card' },
            h('h4', null, dt('drill.d489')),
            h('div', { style: { display: 'grid', gap: 8 } },
              h('label', { style: { fontSize: 12 } }, dt('drill.d490'),
                h('select', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  value: draft.platform,
                  onChange: (e) => setDraft(Object.assign({}, draft, { platform: e.target.value })),
                },
                  h('option', { value: 'auto' }, dt('drill.d491')),
                  h('option', { value: 'windows' }, 'windows'),
                  h('option', { value: 'linux' }, 'linux'))),
              h('label', { style: { fontSize: 12 } }, dt('drill.d492'),
                h('input', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  placeholder: dt('drill.d493') + defaultToolkit,
                  value: draft.toolkitDir,
                  onChange: (e) => setDraft(Object.assign({}, draft, { toolkitDir: e.target.value })),
                })),
              h('label', { style: { fontSize: 12 } }, dt('drill.d494'),
                h('input', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  placeholder: dt('drill.d493') + defaultNuclei,
                  value: draft.nucleiTemplatesDir,
                  onChange: (e) => setDraft(Object.assign({}, draft, { nucleiTemplatesDir: e.target.value })),
                })),
              h('label', { style: { fontSize: 12 } }, dt('drill.d495'),
                h('textarea', {
                  className: 'rt-input', rows: 4, style: { display: 'block', width: '100%', marginTop: 4, fontFamily: 'var(--dsw-font-mono, monospace)' },
                  placeholder: dt('drill.d496') + String.fromCharCode(10) + 'D:\\tools' + String.fromCharCode(10) + 'D:\\pentest-bin',
                  value: draft.binDirsText,
                  onChange: (e) => setDraft(Object.assign({}, draft, { binDirsText: e.target.value })),
                })))),
          h('div', { className: 'rt-card' },
            h('h4', null, dt('drill.d497')),
            h('div', { style: { display: 'grid', gap: 8 } },
              ['FOFA_KEY', 'REDTEAM_VPS_HOST', 'REDTEAM_VPS_KEY'].map((k) => h('label', { key: k, style: { fontSize: 12 } }, k + dt('drill.d498'),
                h('input', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  type: k === 'FOFA_KEY' ? 'password' : 'text',
                  placeholder: k === 'REDTEAM_VPS_KEY' ? [dt('drill.k30043')] : (k === 'REDTEAM_VPS_HOST' ? [dt('drill.k30044')] : dt('drill.d499')),
                  value: (draft.env && draft.env[k]) || '',
                  onChange: (e) => setEnv(k, e.target.value),
                }))))),
          h('div', { className: 'rt-card' },
            h('h4', null, dt('drill.d500')),
            h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
              dt('drill.d501')),
            tools.map((t) => h('div', { key: t.id, style: { marginBottom: 8 } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
                h('span', { style: { fontWeight: 600, minWidth: 88 } }, t.label || t.id),
                t.path
                  ? h('span', { className: 'rt-tag rt-tag-live', title: t.path }, t.source + dt('drill.d502'))
                  : h('span', { className: 'rt-tag rt-tag-warn' }, dt('drill.d503'))),
              h('input', {
                className: 'rt-input', style: { width: '100%' },
                placeholder: dt('drill.d504') + (t.names || []).slice(0, 3).join(' / '),
                value: (draft.tools && draft.tools[t.id]) || '',
                onChange: (e) => setTool(t.id, e.target.value),
              }),
              t.path ? h('div', { className: 'rt-mono', style: { fontSize: 10.5, marginTop: 2, opacity: 0.8 } }, t.path) : null))),
          h('div', { className: 'rt-card' },
            h('h4', null, dt('drill.d505')),
            h('textarea', {
              className: 'rt-input', rows: 3, style: { width: '100%' },
              placeholder: dt('drill.d506'),
              value: draft.notes,
              onChange: (e) => setDraft(Object.assign({}, draft, { notes: e.target.value })),
            })),
          h('div', { className: 'rt-foot' },
            h('span', null,
              dt('drill.d507') + ((data && data.config && data.config.path) || '$DSH_HOME/redteam/config.json')
              + dt('drill.d508'))))))
    }

    /* ---------------------------------------------------------- 得分目标 */
    function ScoreTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [openId, setOpenId] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState(null)

      const load = () => {
        if (!eng) return
        setBusy(true)
        api({ op: 'scores', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null)
          setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      /* builtin 要一路带到表单：内置得分点的分值/名称/口径由《得分规则》锁定，
         界面必须把输入框置灰并说明原因 —— 以前是「能改、提示已保存、刷新后变回去」，
         用户以为是 bug。 */
      const startEdit = (p) => setForm({
        id: p.id, name: p.name, category: p.category || '', points: p.points,
        description: p.description || '', enabled: p.enabled, builtin: p.builtin === true,
        src: p.src, cap: p.cap, rule: p.rule,
      })
      const startNew = () => { setForm({ name: '', category: '', points: 10, description: '', enabled: true, builtin: false }); setMsg(null) }
      const setField = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }))

      const save = () => {
        if (!form || !form.name) { setMsg({ err: dt('drill.d509') }); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'saveScorePoint', engagement: eng, point: form }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d168') }); return }
          /* overridden === false 表示后端**没有采纳**提交的分值（内置点由规则锁定）。
             这时不能笼统说「已保存」 —— 那句话会让用户以为分值改成功了。 */
          if (r.overridden === false) {
            setMsg({ err: dt('drill.d510')
              + dt('drill.d511')
              + dt('drill.d512') })
          } else {
            setMsg({ ok: r.note || dt('drill.d169') })
          }
          setForm(null)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }
      const remove = () => {
        if (!form || !form.id) { setForm(null); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'deleteScorePoint', engagement: eng, id: form.id }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d513') }); return }
          setMsg({ ok: dt('drill.d514') })
          setForm(null)
          setOpenId(null)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const summary = (data && data.summary) || { achievedPoints: 0, pointCount: 0, hitPointCount: 0, hitCount: 0, selfCreatedHits: 0, serviceCappedHits: 0 }
      const items = (data && data.items) || []

      /* 按合并版的 8 个类别分组渲染（后端 ruleGroups 已排好序、组内按分值升序）。
         兼容：后端没给 ruleGroups（老 host）时退回平铺。 */
      const groups = (data && data.ruleGroups && data.ruleGroups.length)
        ? data.ruleGroups
        : [{ key: 'all', name: '', capSum: 0, points: 0, counted: 0, tiers: items }]
      const rows = []
      for (const g of groups) {
        if (g.name) {
          rows.push(h('div', { key: 'g-' + g.key, className: 'rt-score-group' },
            h('span', null, g.name),
            h('span', { className: 'rt-sg-sub' },
              g.tiers.length + dt('drill.d395')
              + (g.capSum > 0 ? dt('drill.d515') + g.capSum + [dt('drill.k30045')] : '')),
            h('div', { className: 'rt-spacer' }),
            g.points > 0
              ? h('span', { className: 'rt-tag rt-tag-active' }, '+' + g.points + dt('drill.d297'))
              : null))
        }
        for (const p of g.tiers) {
        const achieved = p.hits.length > 0
        const open = openId === p.id
        rows.push(h('div', {
          key: 'sp' + p.id, className: 'rt-score-row', role: 'button', tabIndex: 0,
          onClick: () => setOpenId(open ? null : p.id),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(open ? null : p.id) } },
        },
          h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
          h('span', null, h('span', {
            className: achieved ? 'rt-pri rt-pri-high' : 'rt-pri rt-pri-low',
            style: achieved ? {} : { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
          }, p.points + dt('drill.d516'))),
          h('span', { title: p.description || '' },
            p.name,
            p.tier ? h('span', { className: 'rt-scope' }, '　' + p.tier) : null),
          /* 命中与上限：这一条计入几次、上限用了多少（G3 各项上限独立，到顶就不再累计） */
          h('span', { title: p.capped > 0
            ? dt('drill.d517') + p.counted + dt('drill.d518') + p.capped + dt('drill.d519') + (p.scope_label || dt('drill.d520')) + dt('drill.d521')
            : (p.scope_label || '') },
            h('span', { className: 'rt-sec-count' }, p.hits.length > 0 ? p.counted + [dt('drill.k30046')] : dt('drill.d522')),
            p.cap > 0
              ? h('span', { className: 'rt-scope' }, dt('drill.d523') + (p.cap_used === null ? 0 : p.cap_used) + '/' + p.cap)
              : null),
          h('span', { style: { textAlign: 'right' } }, p.earned > 0
            ? h('span', { className: 'rt-tag rt-tag-active' }, '+' + p.earned + dt('drill.d297'))
            : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '—'))))
        if (!open) continue
        /* 命中记录：一行一条 —— 第一行给"序号 + 资产 + 时间 + 复制"，内容另起一行自适应换行 */
        const hitNodes = p.hits.map((hh, hi) => h('div', {
          key: 'h' + hh.id,
          className: 'rt-hit-row' + (hh.self_created ? ' self-created' : '') + (hh.capped ? ' service-capped' : ''),
        },
          h('span', { className: 'rt-hit-idx' }, String(hi + 1)),
          h('span', { className: 'rt-hit-asset', title: hh.target || hh.asset_ip || '' },
            hh.asset_ip || hh.target || dt('drill.d524')),
          hh.self_created ? h('span', { className: 'rt-tag rt-tag-warn', title: dt('drill.d525') }, dt('drill.d526')) : null,
          hh.capped ? h('span', {
            className: 'rt-tag rt-tag-warn',
            title: hh.capped_reason || dt('drill.d527'),
          }, dt('drill.d301') + (hh.service ? '（' + hh.service + '）' : '')) : null,
          hh.shot_count ? h('span', { className: 'rt-tag', title: dt('drill.d528') },
            dt('drill.d529') + hh.shot_count) : null,
          h('span', { className: 'rt-hit-time' }, fmt(hh.recorded_at)),
          h('button', {
            className: 'rt-btn', style: { padding: '0 5px', fontSize: 10.5 },
            title: dt('drill.d530'),
            onClick: (e) => {
              e.stopPropagation()
              copyText((hh.asset_ip || hh.target || '') + '  ' + (hh.evidence || ''))
            },
          }, dt('drill.d241')),
          hh.evidence
            ? h('span', { className: 'rt-hit-txt', title: hh.evidence }, String(hh.evidence).replace(/\n+/g, ' '))
            : h('span', { className: 'rt-hit-txt none' }, dt('drill.d531'))))
        rows.push(h('div', {
          key: 'spd' + p.id, className: 'rt-score-row',
          style: { cursor: 'default', gridTemplateColumns: tableColumns([{ key: 'full' }]) },
        }, h('div', { className: 'rt-score-detail' },
          p.description ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d532')), h('span', null, p.description)) : null,
          h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d255')),
            h('span', null, (p.enabled ? [dt('drill.k30047')] : dt('drill.d533')) + ' · ' + p.points + dt('drill.d534') + p.hits.length +
              dt('drill.d535') + p.earned + dt('drill.d297') + (p.self_created ? dt('drill.d314') + p.self_created + [dt('drill.k30048')] : '') +
              (p.capped ? dt('drill.d314') + p.capped + [dt('drill.k30049')] : ''))),
          p.capped
            ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d536')),
                h('span', null, p.service_summary + dt('drill.d537')))
            : null,
          p.hits.length
            ? h('div', null,
                h(ShotStrip, { eng: eng, shots: p.shots, total: p.shot_total,
                  title: dt('drill.d538') + (p.shot_total || (p.shots || []).length) + dt('drill.d30') }),
                h('div', { className: 'rt-section', style: { padding: '6px 0 0' } },
                  dt('drill.d539') + p.hits.length + dt('drill.d540')),
                h('div', { className: 'rt-hits' }, hitNodes))
            : h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d541')),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                  dt('drill.d542'))),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); startEdit(p) } }, dt('drill.d543'))))))
        }
      }

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, dt('drill.d544')),
          /* 只显示已拿下的总分，不显示目标分数、不显示进度条 */
          h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', marginLeft: 4 } }, dt('drill.d545')),
          h('span', { className: 'rt-total' }, String(summary.achievedPoints)),
          h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, dt('drill.d516')),
          h('span', { className: 'rt-tag' }, summary.pointCount + dt('drill.d546')),
          h('span', { className: 'rt-tag' }, dt('drill.d547') + summary.countedHits + dt('drill.d115')),
          summary.selfCreatedHits
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: dt('drill.d548'),
              }, dt('drill.d549') + summary.selfCreatedHits)
            : null,
          summary.serviceCappedHits
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: dt('drill.d550'),
              }, dt('drill.d551') + summary.serviceCappedHits)
            : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', onClick: startNew }, dt('drill.d552')),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? [dt('drill.k30020')] : dt('drill.d82'))),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        form ? h('div', { className: 'rt-pane', style: { flex: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          /* 内置得分点（builtin）：分值 / 名称 / 分类由《得分规则》锁定，输入框置灰。
             可改的只有「启用 / 停用」。这样界面上就不会再出现「改完提示已保存、刷新变回去」的困惑。 */
          form.builtin
            ? h('div', { className: 'rt-hint', style: { marginBottom: 8 } },
                h('b', null, dt('drill.d553')),
                h('div', { style: { marginTop: 3 } },
                  dt('drill.d554')
                  + dt('drill.d555')
                  + dt('drill.d556')),
                form.src !== null && form.src !== undefined
                  ? h('div', { style: { marginTop: 3, color: 'var(--dsw-alias-label-secondary)' } },
                      dt('drill.d557') + form.src + (form.rule ? dt('drill.d558') + form.rule : '')
                      + (form.cap > 0 ? dt('drill.d559') + form.cap + [dt('drill.k30030')] : dt('drill.d560')))
                  : null)
            : null,
          h('div', { className: 'rt-score-form' },
            h('input', {
              className: 'rt-input', placeholder: dt('drill.d561'), value: form.name,
              readOnly: form.builtin === true,
              title: form.builtin ? [dt('drill.k30050')] : '',
              onChange: (e) => setField('name', e.target.value),
            }),
            h('input', {
              className: 'rt-input', placeholder: dt('drill.d562'), value: form.category,
              readOnly: form.builtin === true,
              title: form.builtin ? [dt('drill.k30051')] : '',
              onChange: (e) => setField('category', e.target.value),
            }),
            h('input', {
              className: 'rt-input', type: 'number', placeholder: dt('drill.d563'),
              readOnly: form.builtin === true,
              title: form.builtin
                ? dt('drill.d564')
                : dt('drill.d565'),
              value: form.points, onChange: (e) => setField('points', Number(e.target.value)),
            }),
            h('select', { className: 'rt-input', value: form.enabled ? '1' : '0', onChange: (e) => setField('enabled', e.target.value === '1') },
              h('option', { value: '1' }, dt('drill.d566')),
              h('option', { value: '0' }, dt('drill.d533')))),
          h('input', {
            className: 'rt-input', style: { width: '100%', marginBottom: 6, boxSizing: 'border-box' },
            placeholder: dt('drill.d567'), value: form.description,
            readOnly: form.builtin === true,
            title: form.builtin ? [dt('drill.k30052')] : '',
            onChange: (e) => setField('description', e.target.value),
          }),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: save }, dt('drill.d182')),
          form.id
            ? (form.builtin
                ? h('button', {
                    className: 'rt-btn', disabled: true,
                    title: dt('drill.d568'),
                  }, dt('drill.d569'))
                : h('button', { className: 'rt-btn', disabled: busy, onClick: remove }, dt('drill.d570')))
            : null,
            h('button', { className: 'rt-btn', onClick: () => setForm(null) }, dt('drill.d571')))) : null,
        h('div', null,
          h('div', { className: 'rt-score-row head' },
            h('span', null, ''), h('span', null, dt('drill.d572')), h('span', null, dt('drill.d573')),
            h('span', null, dt('drill.d574')), h('span', { style: { textAlign: 'right' } }, dt('drill.d575'))),
          h(TableGrid, {
            /* 整行托管：得分行同样是自带的 `.rt-score-row` 网格（可展开、带命中详情）。 */
            head: false,
            columns: [{ key: 'row' }],
            rows: rows.map((node, index) => ({ key: 'sr' + index, cells: [node] })),
            empty: !items.length ? h(EmptyState, { text: dt('drill.d576') }) : null,
          })))
    }

    /* ---------------------------------------------------------- 折叠底座 */
    /**
     * 折叠状态按「页签 + 靶标」持久化到 localStorage，切页签/刷新后保持不变。
     * 只记录用户显式点过的键；没点过的用调用方给的默认值。
     */
    const COLLAPSE_KEY = 'rt-collapse:'
    const collapseLoad = (prefix) => {
      try {
        const raw = window.localStorage.getItem(COLLAPSE_KEY + prefix)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (e) { return {} }
    }
    const collapseSave = (prefix, value) => {
      try { window.localStorage.setItem(COLLAPSE_KEY + prefix, JSON.stringify(value)) } catch (e) { /* 隐私模式等 */ }
    }

    /** 一个页签一个 hook：isOpen(key, defaultOpen) / toggle(key, defaultOpen) / setAll(keys, open) */
    function useCollapse(prefix) {
      const [state, setState] = React.useState(() => collapseLoad(prefix))
      React.useEffect(() => { setState(collapseLoad(prefix)) }, [prefix])
      const write = (next) => { collapseSave(prefix, next); setState(next) }
      const isOpen = (key, defaultOpen) => {
        const v = state[key]
        return v === undefined ? defaultOpen !== false : v === true
      }
      const toggle = (key, defaultOpen) => (e) => {
        if (e && e.stopPropagation) e.stopPropagation()
        write(Object.assign({}, state, { [key]: !isOpen(key, defaultOpen) }))
      }
      const setAll = (keys, open) => {
        const next = Object.assign({}, state)
        for (const k of keys) next[k] = open
        write(next)
      }
      return { isOpen: isOpen, toggle: toggle, setAll: setAll }
    }

    /**
     * 统一折叠头（L1）：▾ 固定在最左、标题加粗、计数紧跟、右侧放时间或操作，
     * 内容缩进 12px 并带一条竖引导线。always=true 表示"常显"（不可折叠）。
     */
    function Section(props) {
      const always = props.always === true
      const open = always || props.open === true
      const head = h('div', {
        className: 'rt-sec t-' + (props.tone || 'target') + (always ? ' flat' : ''),
        role: always ? undefined : 'button',
        tabIndex: always ? undefined : 0,
        'aria-expanded': always ? undefined : (open ? 'true' : 'false'),
        onClick: always ? undefined : props.onToggle,
        onKeyDown: always ? undefined : (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (props.onToggle) props.onToggle(e) }
        },
      },
        h('span', { className: 'rt-sec-caret' }, always ? '▍' : (open ? '▾' : '▸')),
        props.title ? h('span', { className: 'rt-sec-title' }, props.title) : null,
        props.count !== undefined && props.count !== null ? h('span', { className: 'rt-sec-count' }, String(props.count)) : null,
        props.sub ? h('span', { className: 'rt-sec-sub' }, props.sub) : null,
        props.right ? h('span', { className: 'rt-sec-right' }, props.right) : null)
      return h('div', { className: 'rt-sec-wrap' }, head,
        open && props.children ? h('div', { className: 'rt-sec-body' }, props.children) : null)
    }

    /** 长文本折叠（L3）：固定预览高度 + 渐隐 + 展开/复制。 */
    function Clip(props) {
      const [open, setOpen] = React.useState(false)
      const text = String(props.text === undefined || props.text === null ? '' : props.text)
      if (text.trim() === '') return null
      return h('div', { className: 'rt-clip' + (open ? ' open' : '') },
        h('div', { className: 'rt-clip-head' },
          props.label ? h('span', { className: 'rt-clip-label' }, props.label) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: (e) => { e.stopPropagation(); copyText(text) },
          }, dt('drill.d241')),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: (e) => { e.stopPropagation(); setOpen((v) => !v) },
          }, open ? [dt('drill.k30053')] : dt('drill.d577'))),
        h('div', { className: 'rt-clip-body' }, text))
    }

    /* ---------------------------------------------------------- 当前测试（实时） */
    const TEST_STATUS_LABEL = {
      untested: dt('drill.d35'), testing: dt('drill.d36'), tested: dt('drill.d37'),
      blocked: dt('drill.d38'), abandoned: dt('drill.d39'), no_surface: dt('drill.d40'),
    }

    /**
     * 当前测试页：agent 正在打哪台、打到哪一步、还有什么在排队。
     * 5 秒轮询自动刷新；三个区块可折叠，其中「正在测」始终完整展开。
     */
    function TestingTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [at, setAt] = React.useState(null)
      const [auto, setAuto] = React.useState(true)
      /* 折叠状态按「页签 + 靶标」记忆；正在测永远常显，不参与折叠 */
      const collapse = useCollapse('testing:' + eng)

      /* 5 秒轮询要有在途守卫：网络慢或后端卡住时，请求会越堆越多、
         而且旧响应回来会覆盖新状态（界面上表现为数字来回跳）。 */
      const inflight = React.useRef(false)
      const seq = React.useRef(0)
      const load = () => {
        if (!eng || inflight.current) return
        inflight.current = true
        const my = ++seq.current
        api({ op: 'activeTests', engagement: eng, limit: 20 }).then((r) => {
          if (my !== seq.current) return          /* 切了靶标：这条已经过期，丢掉 */
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null); setData(r); setAt(new Date())
        }, (e) => { if (my === seq.current) setErr(String((e && e.message) || e)) })
          .finally(() => { if (my === seq.current) inflight.current = false })
      }
      React.useEffect(() => { seq.current += 1; load() }, [eng, refreshKey])
      React.useEffect(() => {
        if (!eng || !auto) return undefined
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [eng, auto, refreshKey])

      const testing = (data && data.testing) || []
      const recent = (data && data.recent) || []
      const queue = (data && data.queue) || []
      const stats = (data && data.stats) || {}

      /* 一台资产一张卡：一眼看清"打的是谁、打到哪、拿到什么" */
      const card = (a, past) => {
        const chips = []
        chips.push(h('span', { key: 'sc', className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external') },
          a.scope === 'internal' ? [dt('drill.k30006')] : dt('drill.d55')))
        if (a.segment_cidr) chips.push(h('span', { key: 'seg', className: 'rt-tag' }, a.segment_cidr))
        if (a.open_ports) chips.push(h('span', { key: 'p', className: 'rt-tag rt-tag-active' }, dt('drill.d578') + a.open_ports + dt('drill.d579')))
        if (a.vulns) chips.push(h('span', { key: 'v', className: 'rt-tag rt-tag-live' }, dt('drill.d580') + a.vulns))
        if (a.webshells) chips.push(h('span', { key: 'w', className: 'rt-tag rt-tag-passive' }, 'WebShell ' + a.webshells))
        if (a.tunnels) chips.push(h('span', { key: 't', className: 'rt-tag rt-tag-passive' }, dt('drill.d322') + a.tunnels))
        if (a.priority) chips.push(h('span', { key: 'pr', className: 'rt-tag' }, dt('drill.d307') + a.priority))
        if (a.blocked_count) chips.push(h('span', { key: 'b', className: 'rt-tag', style: { color: 'var(--dsw-alias-state-error-primary, #ef4444)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 33%, transparent)' } }, dt('drill.d114') + a.blocked_count + dt('drill.d115')))
        const noteLines = a.test_notes
          ? String(a.test_notes).split('\n').slice(-3).map((l) => (l.length > 240 ? l.slice(0, 240) + ' …' : l))
          : []
        return h('div', { key: 'at' + a.id, className: 'rt-atest' + (past ? ' past' : '') },
          h('div', { className: 'rt-atest-head' },
            past ? null : h('span', { className: 'rt-live-dot' }),
            h('span', { className: 'rt-atest-ip' }, a.ip),
            h('span', { className: 'rt-tag ' + (a.test_status === 'testing' ? 'rt-tag-live' : '') }, TEST_STATUS_LABEL[a.test_status] || a.test_status),
            h('div', { className: 'rt-spacer' }),
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
              fmt(a.test_updated_at) + (a.test_updated_by ? ' · ' + a.test_updated_by : ''))),
          chips.length ? h('div', null, chips) : null,
          a.test_surface ? h('div', { className: 'rt-atest-meta' }, dt('drill.d581') + a.test_surface) : null,
          a.potential ? h('div', { className: 'rt-atest-meta' }, dt('drill.d582') + a.potential) : null,
          noteLines.length ? h(Clip, { label: dt('drill.d583'), text: noteLines.join('\n') }) : null)
      }


      const concl = (label, value, tone) => h('span', { key: label, className: 'rt-concl-i', style: { cursor: 'default' } },
        h('b', null, String(value || 0)), h('span', null, label))
      const conclusion = h('div', { className: 'rt-concl' },
        concl(dt('drill.d36'), stats.testing, 'live'),
        concl(dt('drill.d92'), stats.untested, ''),
        concl(dt('drill.d93'), stats.tested, ''),
        concl(dt('drill.d94'), (stats.abandoned || 0) + (stats.blocked || 0), ''),
        concl(dt('drill.d40'), stats.no_surface, ''),
        h('div', { className: 'rt-spacer' }),
        at ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          dt('drill.d584') + at.toLocaleTimeString('zh-CN', { hour12: false })) : null,
        h('button', {
          className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, title: dt('drill.d585'),
          onClick: () => collapse.setAll(['testing:' + eng, 'recent:' + eng, 'queue:' + eng], true),
        }, dt('drill.d282')),
        h('button', {
          className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, title: dt('drill.d586'),
          onClick: () => collapse.setAll(['testing:' + eng, 'recent:' + eng, 'queue:' + eng], false),
        }, dt('drill.d284')),
        h('button', {
          className: 'rt-btn' + (auto ? ' rt-btn-primary' : ''), style: { padding: '0 7px', fontSize: 11 },
          title: dt('drill.d587'), onClick: () => setAuto((x) => !x),
        }, auto ? [dt('drill.k30054')] : dt('drill.d588')),
        h('button', { className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, onClick: load }, dt('drill.d82')))

      const body = []
      /* 正在测：常显，完整展开（不可折叠） */
      body.push(h(Section, {
        key: 'testing', tone: 'test', title: dt('drill.d589'),
        count: testing.length + dt('drill.d60'),
        sub: testing.length ? [dt('drill.k30055')] : dt('drill.d590'),
        open: collapse.isOpen('testing:' + eng, true),
        onToggle: collapse.toggle('testing:' + eng, true),
      }, testing.length
        ? testing.map((a) => card(a, false))
        : h('div', { className: 'rt-atest-meta', style: { paddingBottom: 4 } }, dt('drill.d591'))))

      /* 最近动过（默认折叠，可记忆） */
      body.push(h(Section, {
        key: 'recent', tone: 'past', title: dt('drill.d592'), count: recent.length + dt('drill.d60'),
        sub: dt('drill.d593'),
        open: collapse.isOpen('recent:' + eng, false),
        onToggle: collapse.toggle('recent:' + eng, false),
      }, recent.length ? recent.map((a) => card(a, true)) : h('div', { className: 'rt-atest-meta' }, dt('drill.d277'))))

      /* 待测队列（默认折叠，可记忆） */
      body.push(h(Section, {
        key: 'queue', tone: 'queue', title: dt('drill.d594'),
        count: (data ? (data.untested || 0) : 0) + dt('drill.d60'),
        sub: dt('drill.d595'),
        open: collapse.isOpen('queue:' + eng, false),
        onToggle: collapse.toggle('queue:' + eng, false),
      }, queue.length
        ? queue.map((a) => card(a, true)).concat([
            h('div', { key: 'queueHint', className: 'rt-atest-meta', style: { paddingTop: 4 } },
              dt('drill.d596'))])
        : h('div', { className: 'rt-atest-meta' }, dt('drill.d597'))))

      return h('div', { className: 'rt-main' },
        conclusion,
        err ? h('div', { className: 'rt-err' }, err) : null,
        data === null && !err ? h('div', { className: 'rt-empty' }, dt('drill.d136')) : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          h('div', { style: { padding: '6px 12px 14px' } }, body)))
    }

    /* ---------------------------------------------------------- 会话与入口（WebShell / 隧道） */
    /**
     * 打内网最容易出的问题：拿到 WebShell 或隧道之后忘了登记，过一会儿就"忘了还有入口可用"。
     * 这个页签把事实库里的 WebShell 与隧道集中展示，带连通状态，并可一键让 host 侧实测。
     */
    function SessionTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [copied, setCopied] = React.useState(null)

      const load = () => {
        if (!eng) return
        api({ op: 'sessions', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null)
          setData(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }
      React.useEffect(load, [eng, refreshKey])

      const probe = () => {
        setBusy(true); setMsg(null)
        api({ op: 'probeSessions', engagement: eng, timeoutMs: 6000 }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d598') }); load(); return }
          const on = (r.webshells || []).filter((x) => x.status === 'online').length
          const act = (r.tunnels || []).filter((x) => x.status === 'active').length
          setMsg({ ok: dt('drill.d599') + on + '/' + (r.webshells || []).length + dt('drill.d600') + act + '/' + (r.tunnels || []).length })
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 只有真的写进剪贴板才把按钮点亮成「已复制」；失败时如实报错 */
      const copy = (key, text) => copyWithFeedback(text, text, (okFlag, message) => {
        if (!okFlag) { setMsg({ err: message }); return }
        setCopied(key)
        /*
         * characterization：这里的 1500 是**被允许的**，不要去改它。
         *
         * 它和浮层那条被删的周期轮询（每 1.5 秒一次的 sync 定时器，载体 purge-dock.js）
         * 没有关系：这里是「已复制」提示亮 1.5 秒后自己熄灭的一次性定时器，不是周期轮询。
         * 删浮层那一轮的验收判据因此只认形态 —— 产物里不许出现「周期定时器 + 该常量」的组合，
         * 不认字符串里有没有这个数字；否则下一个为过门禁把常量改小的人，就是在改行为迎合断言。
         */
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
      })

      const markTunnel = (t, status) => {
        setMsg(null)
        api({ op: 'updateTunnel', engagement: eng, id: t.id, patch: { status: status, check_note: dt('drill.d601') } })
          .then(() => load(), (e) => setMsg({ err: String((e && e.message) || e) }))
      }
      const markShell = (w, status) => {
        setMsg(null)
        api({ op: 'updateWebshell', engagement: eng, id: w.id, patch: { status: status, check_note: dt('drill.d601') } })
          .then(() => load(), (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const sessCollapse = useCollapse('sessions:' + eng)
      const totals = (data && data.totals) || {}
      const shells = (data && data.webshells) || []
      const tunnels = (data && data.tunnels) || []
      const statusDot = (s) => h('span', { className: s === 'online' || s === 'active' ? 'rt-dot-on' : (s === 'unknown' || !s ? 'rt-dot-unk' : 'rt-dot-off') })
      /* 卡片里统一用「标签 + 值」两列，长文本自动换行 —— 比一行点分隔好扫读 */
      const fact = (label, value) => h('div', { className: 'rt-sess-fact' }, h('b', null, label), h('span', null, value))
      /* 交付要求：马必须是冰蝎/哥斯拉加密马（用户才连得上），内网必须走 suo5 隧道 */
      const isEncryptedShell = (t) => /behinder|godzilla|冰蝎|哥斯拉/i.test(String(t || ''))
      const isSuo5 = (t) => /suo5/i.test(String(t || ''))
      /* 提示条：只留一句结论 + 可展开的做法（原来是把三段长解释平铺，正文全被淹掉） */
      const hint = (key, title, detail) => h('div', { key, className: 'rt-hint' },
        h('b', null, title),
        h('details', { className: 'rt-sess-fold', style: { marginTop: 3 } },
          h('summary', null, dt('drill.d602')),
          h('div', { style: { marginTop: 4 } }, detail)))
      const hints = []
      const badShells = shells.filter((w) => !isEncryptedShell(w.shell_type))
      const legitTunnels = tunnels.filter((t) => t.legit === true)
      if (badShells.length > 0) {
        hints.push(hint('h1', dt('drill.d603') + badShells.length + dt('drill.d604'),
          dt('drill.d605')
          + dt('drill.d606')))
      }
      if (tunnels.length > 0 && legitTunnels.length === 0) {
        hints.push(hint('h3', dt('drill.d607') + tunnels.length + dt('drill.d608'),
          dt('drill.d609')
          + dt('drill.d610')))
      }
      const activeSuo5 = tunnels.filter((t) => isSuo5(t.kind) && t.status === 'active')
      if (shells.length > 0 && activeSuo5.length === 0) {
        hints.push(hint('h2', dt('drill.d611'),
          dt('drill.d612')
          + dt('drill.d613')
          + dt('drill.d614')))
      }

      const shellCards = shells.map((w) => h('div', { key: 'w' + w.id, className: 'rt-sess' },
        h('div', { className: 'rt-sess-head' },
          statusDot(w.status),
          h('span', { className: 'rt-sess-title' }, w.url),
          h('span', { className: 'rt-tag rt-tag-active' }, w.shell_type || 'webshell'),
          isEncryptedShell(w.shell_type) ? null : h('span', { className: 'rt-tag rt-tag-warn' }, dt('drill.d615')),
          w.privilege ? h('span', { className: 'rt-tag' }, w.privilege) : null,
          h('div', { className: 'rt-spacer' }),
          copied === 'cmd' + w.id
            ? h('span', { className: 'rt-tag', style: { color: 'var(--dsw-alias-state-success-primary, #10b981)' } }, dt('drill.d616'))
            : h('button', {
                className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                onClick: () => copy('cmd' + w.id, 'curl -s "' + w.url + '"'),
              }, dt('drill.d617')),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: () => markShell(w, 'offline'),
          }, dt('drill.d618'))),
        h('div', { className: 'rt-sess-facts' },
          fact(dt('drill.d213'), (isEncryptedShell(w.shell_type) ? [dt('drill.k30056')] : dt('drill.d619'))),
          w.pass_key ? fact(dt('drill.d620'), h('span', { className: 'rt-mono' }, w.pass_key)) : null,
          w.asset_ip ? fact(dt('drill.d621'), w.asset_ip) : null,
          w.privilege ? fact(dt('drill.d622'), w.privilege) : null,
          w.secret_ref ? fact(dt('drill.d623'), h('span', { className: 'rt-mono' }, w.secret_ref)) : null,
          fact(dt('drill.d624'), (w.last_check ? fmt(w.last_check) : dt('drill.d625'))
            + (w.latency_ms !== null && w.latency_ms !== undefined ? '（' + w.latency_ms + 'ms）' : '')),
          w.check_note ? fact(dt('drill.d626'), w.check_note) : null,
          w.note ? fact(dt('drill.d505'), w.note) : null)))

      const tunnelCards = tunnels.map((t) => {
        const proxy = t.listen ? 'socks5://' + t.listen : ''
        const gogoCmd = t.listen ? dt('drill.d627') + proxy : ''
        const fscanCmd = t.listen ? dt('drill.d628') + t.listen + ' -o intranet.txt' : ''
        return h('div', { key: 't' + t.id, className: 'rt-sess' },
          h('div', { className: 'rt-sess-head' },
            statusDot(t.status),
            h('span', { className: 'rt-sess-title' }, t.listen || dt('drill.d629')),
            h('span', { className: 'rt-tag rt-tag-passive' }, t.kind || 'tunnel'),
            isSuo5(t.kind) ? null : h('span', { className: 'rt-tag rt-tag-warn' }, dt('drill.d630')),
            /* 只有跨越靶标边界的通道才算突破凭证（自己 VPS/自建服务器上开的不算） */
            t.legit === true
              ? h('span', { className: 'rt-tag rt-tag-live', title: t.entry_kind_label || '' }, dt('drill.d631'))
              : (t.legit === false
                  ? h('span', { className: 'rt-tag rt-tag-warn', title: dt('drill.d632') }, dt('drill.d633'))
                  : h('span', { className: 'rt-tag', title: dt('drill.d634') }, dt('drill.d635'))),
            t.reach ? h('span', { className: 'rt-tag' }, dt('drill.d316') + t.reach) : null,
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
              onClick: () => copy('sock' + t.id, t.listen || ''),
            }, copied === 'sock' + t.id ? [dt('drill.k30057')] : dt('drill.d636')),
            t.status === 'active'
              ? h('button', { className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 }, onClick: () => markTunnel(t, 'down') }, dt('drill.d618'))
              : h('button', { className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 }, onClick: () => markTunnel(t, 'active') }, dt('drill.d637'))),
          h('div', { className: 'rt-sess-facts rt-def' },
            fact(dt('drill.d638'), t.entry || dt('drill.d369')),
            fact(dt('drill.d639'), t.legit === true
              ? h('span', { className: 'rt-tag rt-tag-live' }, t.entry_kind_label || t.entry_kind || dt('drill.d640'))
              : (t.legit === false
                  ? h('span', { className: 'rt-tag rt-tag-warn' }, dt('drill.d641'))
                  : h('span', { className: 'rt-tag' }, dt('drill.d642')))),
            t.reach ? fact(dt('drill.d643'), t.reach) : null,
            t.asset_ip ? fact(dt('drill.d621'), t.asset_ip) : null,
            fact(dt('drill.d624'), (t.last_check ? fmt(t.last_check) : dt('drill.d625'))
              + (t.latency_ms !== null && t.latency_ms !== undefined ? '（' + t.latency_ms + 'ms）' : '')),
            t.check_note ? fact(dt('drill.d626'), t.check_note) : null,
            t.note ? fact(dt('drill.d505'), t.note) : null),
          /* 命令默认折叠：卡片首要信息是"这条通道能不能用、通向哪"，命令按需展开 */
          t.command ? h('details', { className: 'rt-sess-fold' },
            h('summary', null, dt('drill.d644')),
            h('div', Object.assign({ className: 'rt-code', title: dt('drill.d645') }, clickable(() => copy('c' + t.id, t.command), { label: dt('drill.d360') })),
              copied === 'c' + t.id ? [dt('drill.k30057')] : t.command)) : null,
          t.status === 'active' && t.listen
            ? h('details', { className: 'rt-sess-fold' },
                h('summary', null, dt('drill.d646')),
                h('div', { className: 'rt-sess-cmd' },
                  h('div', Object.assign({ className: 'rt-code', title: dt('drill.d645') }, clickable(() => copy('g' + t.id, gogoCmd), { label: dt('drill.d647') })),
                    copied === 'g' + t.id ? [dt('drill.k30057')] : gogoCmd),
                  h('div', Object.assign({ className: 'rt-code', style: { display: 'block', marginTop: 3 }, title: dt('drill.d645') }, clickable(() => copy('f' + t.id, fscanCmd), { label: dt('drill.d648') })),
                    copied === 'f' + t.id ? [dt('drill.k30057')] : fscanCmd)))
            : null)
      })

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, dt('drill.d649')),
          h('span', { className: 'rt-tag' }, 'WebShell ' + (totals.webshellsOnline || 0) + '/' + (totals.webshells || 0) + dt('drill.d650')),
          h('span', { className: 'rt-tag' }, dt('drill.d322') + (totals.tunnelsActive || 0) + '/' + (totals.tunnels || 0) + dt('drill.d651')),
          h('span', { className: 'rt-tag' }, dt('drill.d652') + (totals.credentials || 0)),
          h('span', { className: 'rt-tag' }, dt('drill.d653') + (totals.access || 0)),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: probe }, busy ? [dt('drill.k30058')] : dt('drill.d654')),
          h('button', { className: 'rt-btn', onClick: load }, dt('drill.d82'))),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          !shells.length && !tunnels.length
            ? h(EmptyState, {
                text: dt('drill.d655'),
                action: h('button', { className: 'rt-btn', onClick: probe }, dt('drill.d654')),
              })
            : null,
          hints.length ? h('div', { style: { padding: '8px 10px 0' } }, hints) : null,
          h(Section, {
            key: 'webshells', tone: 'queue', title: 'WebShell',
            count: (totals.webshellsOnline || 0) + '/' + (totals.webshells || 0) + dt('drill.d650'),
            sub: dt('drill.d657'),
            open: sessCollapse.isOpen('shells', true), onToggle: sessCollapse.toggle('shells', true),
          }, shells.length
            ? h('div', { className: 'rt-sess-grid', style: { padding: 0 } }, shellCards)
            : h('div', { className: 'rt-atest-meta' }, dt('drill.d658'))),
          h(Section, {
            key: 'tunnels', tone: 'test', title: dt('drill.d659'),
            count: (totals.tunnelsActive || 0) + '/' + (totals.tunnels || 0) + dt('drill.d651'),
            sub: dt('drill.d660'),
            open: sessCollapse.isOpen('tunnels', true), onToggle: sessCollapse.toggle('tunnels', true),
          }, tunnels.length
            ? h('div', { className: 'rt-sess-grid', style: { padding: 0 } }, tunnelCards)
            : h('div', { className: 'rt-atest-meta' }, dt('drill.d661')))))

    }

    /* ---------------------------------------------------------- 错误边界 */
    /**
     * 单个页签渲染出错时只降级该页签，不拖垮整个面板：面板与侧栏按钮保持可用，
     * 用户可一键回到资产测绘。（此前面板整块消失、按钮点不开就是缺了这层保护。）
     */
    class RtBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        try { console.error(dt('drill.d662'), error) } catch (e) { /* ignore */ }
      }
      render() {
        if (this.state.error) {
          const msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h('div', { className: 'rt-pane' },
            h('div', { className: 'rt-err' }, dt('drill.d663') + msg),
            h('button', {
              className: 'rt-btn',
              onClick: () => { this.setState({ error: null }); setUI({ tab: 'assets' }) },
            }, dt('drill.d664')))
        }
        return this.props.children
      }
    }

    /**
     * 智能体页签：并发名额（最多 3 个）+ 六个角色与它们的提示词。
     * 主会话派活前先看这里的名额，用户也能一眼看到"现在还能拉起几个智能体"。
     */
    function AgentsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [roles, setRoles] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [concurrency, setConcurrency] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = () => {
        setBusy(true)
        api({ op: eng ? 'prompts' : 'bootstrap', engagement: eng || undefined }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null)
          if (r.roles) setRoles(r.roles)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
        /* 并发名额按"当前跑着的子智能体"算；host 侧读 subagents 注册表 */
        api({ op: 'agentsStatus' }).then((r) => {
          if (r && r.ok !== false) setConcurrency(r)
        }, () => {})
      }
      React.useEffect(load, [eng, refreshKey])

      const used = concurrency ? concurrency.used : null
      const max = concurrency ? concurrency.max : 3
      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', null, dt('drill.d665')),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? [dt('drill.k30041')] : dt('drill.d82'))),
        h('div', { className: 'rt-pane' },
          err ? h('div', { className: 'rt-err' }, err) : null,
          /* 两栏：左边「规则 / 角色」是主体，右边「设置 / 提醒」是辅体。
             整宽单列时每一节权重相同，读起来像一张清单；分栏之后页面才有主次。 */
          h('div', { className: 'rt-cols' },
            h('div', { className: 'rt-cols__main' },
              /* 并发规则：一条规则一行（列表），不再是一段带「·」的连续文本 */
              h('section', { className: 'rt-section rt-section--stack' },
                h('h3', { className: 'rt-section__title' }, dt('drill.d670')),
                h('ul', { className: 'rt-rule' },
                  h('li', { className: 'rt-rule__item', key: 'r1' }, h(RichCopy, { text: dt('drill.d671') + max + dt('drill.d672') })),
                  h('li', { className: 'rt-rule__item', key: 'r2' }, h(RichCopy, { text: dt('drill.d673') })),
                  h('li', { className: 'rt-rule__item', key: 'r3' }, h(RichCopy, { text: dt('drill.d674') })))),
              /* 六个角色：auto-fill 网格（窄屏一列） */
              h('section', { className: 'rt-section rt-section--stack' },
                h('h3', { className: 'rt-section__title' }, dt('drill.d675')),
                h('div', { className: 'rt-roles' },
                  ['drill.d676', 'drill.d677', 'drill.d678', 'drill.d679', 'drill.d680', 'drill.d681'].map((key) =>
                    h('div', { className: 'rt-roles__item', key: key }, h(RichCopy, { text: dt(key) })))))),
            h('div', { className: 'rt-cols__aside' },
              /* 并发占用：数字大、标签小，一眼看出还剩几个名额 */
              h('section', { className: 'rt-section rt-section--stack' },
                h('h3', { className: 'rt-section__title' }, dt('drill.d665')),
                h(StatRow, {
                  groups: [{
                    key: 'agents',
                    items: [
                      { key: 'max', label: dt('drill.d666').trim(), value: max },
                      { key: 'used', label: dt('drill.d668').trim(), value: used === null ? '—' : used },
                      { key: 'free', label: dt('drill.d669').replace(/^\s*\/\s*/, '').trim(), value: used === null ? '—' : Math.max(max - used, 0) },
                    ],
                  }],
                })),
              h(ConcurrencyCard, { concurrency, onSaved: load }))),
          /* 角色提示词编辑器：整宽（长表单，挤进辅栏会把两栏比例撑坏） */
          h('section', { className: 'rt-section rt-section--stack' },
            h('h3', { className: 'rt-section__title' }, dt('drill.d682')),
            h('p', { className: 'rt-section__hint' }, dt('drill.d683')),
            h(PromptsTab, { engagement: eng, refreshKey: refreshKey }))))
    }

    function ConcurrencyCard(props) {
      const info = props.concurrency || {}
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      React.useEffect(() => { if (info.max) setDraft(String(info.max)) }, [info.max])

      const limit = info.limit || 10
      const used = typeof info.used === 'number' ? info.used : null
      const source = info.source === 'settings' ? dt('drill.d684')
        : info.source === 'env' ? [dt('drill.k30059')] : dt('drill.d685')
      const n = Number(draft)
      const invalid = !Number.isFinite(n) || Math.floor(n) !== n || n < 1 || n > limit
      const save = () => {
        if (invalid) return
        setBusy(true); setMsg(null)
        api({ op: 'setAgentsMax', max: n }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d168') }); return }
          setMsg({ ok: dt('drill.d686') + r.max + dt('drill.d687') })
          if (props.onSaved) props.onSaved()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }
      return h('section', { className: 'rt-section rt-section--stack' },
        h('h3', { className: 'rt-section__title' }, dt('drill.d688')),
        h('p', { className: 'rt-section__hint' },
          h(RichCopy, {
            text: dt('drill.d689') + (info.max || '?') + '**'
              + (used === null ? '' : dt('drill.d690') + used + dt('drill.d691') + Math.max((info.max || 0) - used, 0) + '）')
              + dt('drill.d692') + source + dt('drill.d693'),
          })),
        /* 一行设置：标签在上，输入 + 范围提示 + 保存同一条基线 */
        h('div', { className: 'rt-field' },
          /* 标签与分节标题不重复：标题已经是「并发数量」，这里只标这一行的字段名 */
          h('label', { className: 'rt-field__label', htmlFor: 'rt-agents-max' }, dt('drill.d666').trim()),
          h('div', { className: 'rt-field__row' },
            h('input', {
              id: 'rt-agents-max', 'aria-label': dt('drill.d688'),
              className: 'rt-input', style: { width: 90 }, type: 'number', min: 1, max: limit,
              value: draft, onChange: (e) => setDraft(e.target.value),
            }),
            h('span', { className: 'rt-field__hint' }, dt('drill.d694') + limit),
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || invalid, onClick: save },
              busy ? [dt('drill.k30016')] : dt('drill.d182')),
            msg && msg.err ? h('span', { className: 'rt-field__err' }, msg.err) : null,
            msg && msg.ok ? h('span', { className: 'rt-field__hint' }, msg.ok) : null)),
        h('div', { className: 'rt-caution', style: { marginTop: 12 } },
          h('span', { className: 'rt-caution__label' }, dt('drill.note')),
          h(RichCopy, { text: dt('drill.d695') + dt('drill.d696') + dt('drill.d697') })))
    }

    /**
     * 版本显示 + 自动更新按钮。
     *
     * 行为：挂载时静默查一次最新版本（npm registry），有新版本就把按钮点亮成
     * 「有新版本 vX」；点击弹出确认框（当前版本 / 最新版本 / 安装位置 / 阻塞项），
     * 确认后由 host 侧执行 安装 → 重启 dsh web（页面会断开，重启后刷新即可）。
     */
    function VersionBar(props) {
      const [info, setInfo] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [countdown, setCountdown] = React.useState(0)
      /* 倒计时 interval 必须能被打断：弹窗被关闭、组件卸载、重复点「立即更新」
         都会留下孤儿 interval，它会在组件已卸载后调 window.location.reload()。 */
      const countdownRef = React.useRef(null)
      const clearCountdown = React.useCallback(() => {
        if (countdownRef.current) { try { clearInterval(countdownRef.current) } catch { /* ignore */ } }
        countdownRef.current = null
      }, [])
      React.useEffect(() => () => clearCountdown(), [clearCountdown])
      const closeModal = React.useCallback(() => {
        clearCountdown()
        setCountdown(0)
        setOpen(false)
      }, [clearCountdown])

      const check = (silent) => {
        if (!silent) setBusy(true)
        api({ op: 'updateCheck' }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) {
            /* 开发态或查不到 registry：只显示当前版本，不报错打扰用户 */
            if (!silent) setErr((r && r.error) || dt('drill.d698'))
            api({ op: 'version' }).then((v) => { if (v && v.ok !== false) setInfo(v) }, () => {})
            return
          }
          setErr(null)
          setInfo(r)
        }, (e) => {
          setBusy(false)
          if (!silent) setErr(String((e && e.message) || e))
          api({ op: 'version' }).then((v) => { if (v && v.ok !== false) setInfo(v) }, () => {})
        })
      }
      React.useEffect(() => { check(true) }, [])

      const apply = () => {
        setBusy(true)
        setMsg(null)
        api({ op: 'updateApply', target: (info && info.latest) || undefined }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d246') }); return }
          setMsg({ ok: dt('drill.d699') + (r.installed || '') + dt('drill.d700') })
          /* 重启会断开这个页面：倒计时提示用户稍后刷新 */
          setCountdown(6)
          clearCountdown()
          countdownRef.current = setInterval(() => {
            setCountdown((n) => {
              if (n <= 1) { clearCountdown(); window.location.reload(); return 0 }
              return n - 1
            })
          }, 1000)
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const current = info && info.current ? info.current : (info && info.plugin ? info.plugin.version : null)
      const latest = info && info.latest ? info.latest : null
      const hasNew = !!(info && info.updateAvailable)
      const blockers = (info && info.blockers) || []
      const notes = (info && info.notes) || []
      const mode = info && info.install ? info.install.mode : null

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', {
          className: 'rt-tag' + (hasNew ? ' rt-tag-warn' : ''),
          title: (dt('drill.d701') + (current || dt('drill.d32')) + (latest ? dt('drill.d702') + latest : '')
            + (mode === 'dev' ? [dt('drill.k30060')] : mode === 'package' ? [dt('drill.k30061')] : '')
            + (info && info.check_error ? dt('drill.d703') + info.check_error : '')),
        }, 'v' + (current || '?')),
        hasNew
          ? h('button', {
              className: 'rt-btn rt-btn-primary', disabled: busy,
              onClick: () => { setOpen(true); setMsg(null) },
              title: dt('drill.d704') + latest + dt('drill.d705'),
            }, busy ? [dt('drill.k30062')] : dt('drill.d706') + latest)
          : h('button', {
              className: 'rt-btn', disabled: busy, onClick: () => check(false),
              title: dt('drill.d707'),
            }, busy ? [dt('drill.k30062')] : dt('drill.d708')),
        open
          ? h('div', { className: 'rt-modal', 'aria-hidden': 'true', onClick: closeModal },
              h('div', { className: 'rt-modal-box', onClick: (e) => e.stopPropagation() },
                h('h4', { style: { marginTop: 0 } }, dt('drill.d709')),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d710')), h('span', null, current || dt('drill.d32'))),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d711')), h('span', null, latest || dt('drill.d32'))),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d712')),
                  h('span', null, mode === 'dev' ? [dt('drill.k30063')] : mode === 'package' ? dt('drill.d713') + ((info.install && info.install.packageManager) || 'npm') + '）' : dt('drill.d32'))),
                info && info.install && info.install.dir
                  ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d714')), h('span', { className: 'rt-mono' }, info.install.dir))
                  : null,
                blockers.length
                  ? h('div', { className: 'rt-hint' },
                      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, dt('drill.d715')),
                      blockers.map((b, i) => h('div', { key: 'b' + i }, '· ' + b)))
                  : null,
                notes.length
                  ? h('div', { className: 'rt-foot', style: { padding: '4px 0' } }, notes.map((n, i) => h('div', { key: 'n' + i }, n)))
                  : null,
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '8px 0' } },
                  dt('drill.d716')
                  + dt('drill.d717')),
                msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
                countdown > 0
                  ? h('div', { className: 'rt-foot' }, dt('drill.d718') + countdown + dt('drill.d719'))
                  : null,
                h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 } },
                  h('button', { className: 'rt-btn', onClick: closeModal }, dt('drill.d720')),
                  h('button', {
                    className: 'rt-btn rt-btn-primary',
                    disabled: busy || blockers.length > 0 || mode === 'dev',
                    title: mode === 'dev' ? [dt('drill.k30064')] : blockers.length ? [dt('drill.k30065')] : dt('drill.d721'),
                    onClick: apply,
                  }, busy ? [dt('drill.k30066')] : dt('drill.d722')))))
          : null)
    }

    /* ---------------------------------------------------------- 常驻面板主体 */
    /**
     * 「未读」状态：按靶标记在 localStorage 里，每 25 秒问一次 host 的 consoleDigest
     * （每个页签的条数 + 最近更新时间）。比本地记住的快照新 → 该页签点红点；
     * 用户点开那个页签就把当前值记成已读，红点消失。
     */
    const UNREAD_KEY = 'rt-unread:'
    const loadUnread = (eng) => {
      try {
        const raw = window.localStorage.getItem(UNREAD_KEY + eng)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch (e) { return null }
    }
    const saveUnread = (eng, value) => {
      try { window.localStorage.setItem(UNREAD_KEY + eng, JSON.stringify(value)) } catch (e) { /* 隐私模式等：不持久化也能用 */ }
    }
    /** 这个页签相对上次查看有没有新内容（条数变多，或最新一条比上次查看还新）。 */
    const digestHasNew = (prev, cur) => {
      if (!cur) return false
      if (!prev) return true
      const pc = Number(prev.count || 0)
      const cc = Number(cur.count || 0)
      if (cc > pc) return true
      const pa = prev.at || ''
      const ca = cur.at || ''
      return ca !== '' && ca !== pa && ca > pa
    }

    const RT_GEOM_KEY = 'rt-dock-geom-v1'
    function clampRtGeom(g) {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      const w = Math.min(Math.max(320, Number(g && g.w) || 620), Math.max(320, vw))
      const h = Math.min(Math.max(240, Number(g && g.h) || 520), Math.max(240, vh))
      const x = Math.min(Math.max(0, Number(g && g.x) || 0), Math.max(0, vw - w))
      const y = Math.min(Math.max(0, Number(g && g.y) || 0), Math.max(0, vh - h))
      return { x: x, y: y, w: w, h: h }
    }
    function defaultRtGeom() {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      let w = 620
      try {
        const saved = Number(window.localStorage.getItem('rt-dock-width'))
        if (Number.isFinite(saved) && saved >= 320 && saved <= 1200) w = saved
      } catch (e) { /* 隐私模式 */ }
      const h = Math.max(240, Math.min(640, vh - 24))
      return clampRtGeom({ x: Math.max(0, vw - w - 12), y: 12, w: w, h: h })
    }
    function loadRtGeom() {
      try {
        const raw = JSON.parse(window.localStorage.getItem(RT_GEOM_KEY) || 'null')
        if (raw && typeof raw === 'object') return clampRtGeom(raw)
      } catch (e) { /* 隐私模式或坏数据 */ }
      return defaultRtGeom()
    }

    /**
     * 列定义 → grid-template-columns 字符串的**唯一**生成点。
     *
     * 三个数据密集页原先各自写死「150px 74px 104px 1.15fr 1fr」这种字面量，
     * 改一列要同时改表头、行、展开行三处，而且各页的列宽口径根本对不齐。
     *
     * @param {Array<{key:string, width?:number|string}>} list 列定义；width 缺省或 'grow' 表示占满剩余
     * @returns {string} 可直接给 grid-template-columns 的字符串
     */
    function tableColumns(list) {
      return (Array.isArray(list) ? list : []).map((col) => {
        const width = col && col.width
        if (width === undefined || width === null || width === '' || width === 'grow') return 'minmax(0,1fr)'
        return typeof width === 'number' ? width + 'px' : String(width)
      }).join(' ')
    }

    /**
     * 表格原语：一个表头 + 若干行，列宽由 tableColumns 生成。
     *
     * 行的单元格由调用方按列顺序给成节点数组（沿用各页原来的单元格渲染，只换外壳）；
     * `extra` 是就地展开的详情（也占满整行）。表格只用发丝线分隔，不套卡片。
     */
    function TableGrid(props) {
      const columns = Array.isArray(props && props.columns) ? props.columns : []
      const rows = Array.isArray(props && props.rows) ? props.rows : []
      const template = tableColumns(columns)
      const cellClass = (col) => 'rt-grid__cell' + (col && col.align === 'right' ? ' rt-grid__cell--num' : '')
      return h('div', { className: 'rt-grid' + (props && props.className ? ' ' + props.className : '') },
        props && props.head === false ? null : h('div', { className: 'rt-grid__head', style: { gridTemplateColumns: template } },
          columns.map((col) => h('span', { className: cellClass(col) + ' rt-grid__cell--head', key: 'h-' + String(col.key) }, col.label || ''))),
        rows.map((row) => h('div', {
          className: 'rt-grid__row' + (row.onClick ? ' is-clickable' : ''),
          key: row.key,
          style: { gridTemplateColumns: template },
          onClick: row.onClick,
        },
          (row.cells || []).map((cell, index) => h('span', { className: cellClass(columns[index]), key: 'c' + index }, cell)),
          row.extra ? h('div', { className: 'rt-grid__extra' }, row.extra) : null)),
        props && props.empty ? props.empty : null)
    }

    /**
     * 状态行原语：状态点 + 名称 + 一句现状 + 可选右侧动作。
     *
     * 环境适配那三条（工具路径 / 环境变量 / 占位符）原先各是一段话，读者要在三段文字里
     * 自己找「哪个还没就绪」。一行一件事，右侧只放该行自己的动作。
     */
    function StatusLine(props) {
      const tone = props && props.tone === 'ok' ? 'ok' : props && props.tone === 'warn' ? 'warn' : 'idle'
      return h('div', { className: 'rt-status__row' },
        h('span', { className: 'rt-status__dot rt-status__dot--' + tone, 'aria-hidden': 'true' }),
        h('span', { className: 'rt-status__name' }, props.name || ''),
        h('span', { className: 'rt-status__detail' }, props.detail || ''),
        props.action ? h('span', { className: 'rt-status__action' }, props.action) : null)
    }

    /**
     * 统计行原语：分组展示计数，数字大、标签小、数字等宽。
     *
     * 之前页脚是一长串「C 段 0 资产 0（存活 0）端口 0 指纹 0 漏洞 0 被动/主动 0/0」，
     * 读者没法一眼分出「这几项是资产维度、那几项是战果维度」。
     */
    function StatRow(props) {
      const groups = Array.isArray(props && props.groups) ? props.groups : []
      return h('div', { className: 'rt-stats' }, groups.map((group) => h('div', {
        className: 'rt-stat-group',
        key: String(group.key || ''),
      }, (group.items || []).map((item) => h('div', { className: 'rt-stat', key: String(item.key) },
        h('span', { className: 'rt-stat__num' }, String(item.value === undefined || item.value === null ? '—' : item.value)),
        h('span', { className: 'rt-stat__label' }, item.label))))))
    }

    /**
     * 空态原语：左对齐、限宽、一句说明 + 最多一个动作；路径单独一行小号等宽。
     *
     * 原来的空态是整段居中、有时把本机路径塞在正文里 —— 一屏里只有它居中，读起来像报错。
     */
    function EmptyState(props) {
      return h('div', { className: 'rt-empty' },
        h('div', null, props.text || ''),
        props.path ? h('div', { className: 'rt-empty__path' }, props.path) : null,
        props.action ? h('div', { className: 'rt-empty__action' }, props.action) : null)
    }

    function Panel(props) {
      /* embedded：嵌在 dsh-purge 外层 dock 里时，不再自带收起/全面浏览/拖拽条，避免与外层按钮重叠 */
      const embedded = !!(props && props.embedded)
      const st = useUI()
      const [engagements, setEngagements] = React.useState([])
      const [eng, setEng] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [newName, setNewName] = React.useState('')
      const [geom, setGeom] = React.useState(loadRtGeom)
      const [creating, setCreating] = React.useState(false)
      const [refreshKey, setRefreshKey] = React.useState(0)
      const [digest, setDigest] = React.useState(null)
      const [seen, setSeen] = React.useState(null)

      React.useEffect(() => {
        if (embedded) return undefined
        try { window.localStorage.setItem(RT_GEOM_KEY, JSON.stringify(geom)) } catch (e) { /* 隐私模式 */ }
      }, [geom, embedded])
      React.useEffect(() => {
        if (embedded) return undefined
        const onResize = () => setGeom((g) => clampRtGeom(g))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [embedded])

      const loadSnapshot = (id) => {
        if (!id) { setSnapshot(null); return }
        api({ op: 'snapshot', engagement: id }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d144')); return }
          setErr(null)
          setSnapshot(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const refreshList = (selectId) => {
        api({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (selectId) { setEng(selectId); loadSnapshot(selectId) }
        }, () => {})
      }

      React.useEffect(() => {
        api({ op: 'bootstrap' }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d723')); return }
          setEngagements(r.engagements || [])
          const id = r.current || (r.engagements && r.engagements[0] && r.engagements[0].id) || null
          if (id) { setEng(id); loadSnapshot(id) }
        }, (e) => setErr(String((e && e.message) || e)))
      }, [])

      const openEngagement = (nameArg) => {
        const name = String(nameArg || newName).trim()
        if (!name) return
        setCreating(true)
        api({ op: 'openEngagement', name: name }).then((r) => {
          setCreating(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d724')); return }
          setNewName('')
          refreshList(r.engagement && r.engagement.id)
        }, (e) => { setCreating(false); setErr(String((e && e.message) || e)) })
      }

      /** 刷新：重新拉取名册/快照，并让当前页签重新取数。 */
      const refreshAll = () => {
        setRefreshKey((k) => k + 1)
        api({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (eng) loadSnapshot(eng)
        }, () => { if (eng) loadSnapshot(eng) })
      }

      const trackPointer = (e, move) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }
      const startDrag = (e) => {
        if (e.target && e.target.closest && e.target.closest('button,a,input,select,textarea,label')) return
        const sx = e.clientX
        const sy = e.clientY
        const ox = geom.x
        const oy = geom.y
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy), w: g.w, h: g.h })))
      }
      const startResizeLeft = (e) => {
        const sx = e.clientX
        const ox = geom.x
        const ow = geom.w
        trackPointer(e, (ev) => {
          const dx = ev.clientX - sx
          setGeom((g) => clampRtGeom({ x: ox + dx, y: g.y, w: ow - dx, h: g.h }))
        })
      }
      const startResizeRight = (e) => {
        const sx = e.clientX
        const ow = geom.w
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: g.h })))
      }
      const startResizeBottom = (e) => {
        const sy = e.clientY
        const oh = geom.h
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: g.w, h: oh + (ev.clientY - sy) })))
      }
      const startResizeCorner = (e) => {
        const sx = e.clientX
        const sy = e.clientY
        const ow = geom.w
        const oh = geom.h
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: oh + (ev.clientY - sy) })))
      }

      /* 切靶标：重新读该靶标的未读快照，并立刻取一次摘要 */
      React.useEffect(() => {
        if (!eng) { setDigest(null); setSeen(null); return undefined }
        setSeen(loadUnread(eng))
        let alive = true
        let digestInflight = false
        const tick = () => {
          if (digestInflight) return        /* 上一轮还没回来，跳过这一轮，别把请求堆起来 */
          digestInflight = true
          api({ op: 'consoleDigest', engagement: eng }).then((r) => {
            if (alive && r && r.ok !== false && r.sections) setDigest(r.sections)
          }, () => { /* 网络异常：不打断，等下一轮 */ })
            .finally(() => { digestInflight = false })
        }
        tick()
        const timer = window.setInterval(tick, 25000)
        return () => { alive = false; window.clearInterval(timer) }
      }, [eng, refreshKey])

      /**
       * 打开某个页签 = 看过这个页签的内容：把当前摘要记成已读。
       * 没读过（第一次打开面板）不算新内容 —— 否则一进来满屏红点，反而看不出"哪里有新东西"。
       */
      const markTabSeen = React.useCallback((tab) => {
        if (!eng) return
        setSeen((prev) => {
          const base = prev || (() => {
            const fresh = {}
            for (const [k, v] of Object.entries((digest || {}))) fresh[k] = { count: Number(v.count || 0), at: v.at || null }
            return fresh
          })()
          const next = Object.assign({}, base)
          const cur = digest && digest[tab]
          if (cur) next[tab] = { count: Number(cur.count || 0), at: cur.at || null }
          saveUnread(eng, next)
          return next
        })
      }, [eng, digest])

      const unreadOf = (tab) => {
        if (!eng || !digest) return false
        if (!seen) return false
        return digestHasNew(seen[tab], digest[tab])
      }

      const stats = (snapshot && snapshot.stats) || {}
      const tabs = [
        ['assets', dt('drill.k30067')], ['env', dt('drill.k30068')], ['agents', dt('drill.k30069')], ['sessions', dt('drill.k30070')],
        ['findings', dt('drill.k30071')],
        ['chain', dt('drill.k30072')], ['scores', dt('drill.k30073')], ['report', dt('drill.k30074')],
        ['knowledge', dt('drill.k30075')],
        ['skills', dt('drill.k30076')],
      ]
      const full = isFullWindow()
      const openFull = () => {
        try { window.open(window.location.href.split('#')[0] + '#redteam-full', '_blank', 'noopener') } catch (e) { setErr(dt('drill.d725') + ((e && e.message) || e)) }
      }
      const exitFull = () => {
        /* 优先关掉脚本打开的窗口；关不掉就退回带侧栏的普通界面 */
        try { window.close() } catch (e) { /* 非脚本打开的窗口无法关闭 */ }
        try {
          if (window.location.hash) {
            window.location.hash = ''
            window.location.reload()
          }
        } catch (e) { /* ignore */ }
      }
      React.useEffect(() => {
        if (!full) return undefined
        const onKey = (e) => { if (e.key === 'Escape') exitFull() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [full])

      let body
      if (err) body = h('div', { className: 'rt-err' }, err)
      /* 全局页：没有靶标也能看（知识库 / 环境适配 / 技能库 / 智能体概览） */
      else if (st.tab === 'knowledge') body = h(KnowledgeTab, { refreshKey: refreshKey })
      else if (st.tab === 'env') body = h(EnvTab, { refreshKey: refreshKey })
      else if (st.tab === 'skills') body = h(SkillsTab, { refreshKey: refreshKey })
      else if (st.tab === 'agents') body = h(AgentsTab, { engagement: eng, refreshKey: refreshKey })
      else if (!eng) {
        body = h('div', { className: 'rt-pane' },
          h('div', { className: 'rt-card' },
            h('h4', null, dt('drill.d726')),
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
              dt('drill.d727')),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                className: 'rt-input', style: { flex: 1 }, placeholder: dt('drill.d728'),
                value: newName, onChange: (e) => setNewName(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') openEngagement() },
              }),
              h('button', { className: 'rt-btn rt-btn-primary', disabled: creating, onClick: () => openEngagement() },
                creating ? [dt('drill.k30077')] : dt('drill.d729')))))
      } else if (st.tab === 'assets') body = h(AssetsTab, { engagement: eng, snapshot: snapshot, refreshKey: refreshKey, onRefresh: refreshAll, onData: () => loadSnapshot(eng) })
      else if (st.tab === 'sessions') body = h(SessionTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'findings') body = h(FindingsTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'chain') body = h(ChainTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'report') body = h(ReportTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'scores') body = h(ScoreTab, { engagement: eng, refreshKey: refreshKey })
      else body = h('div', { className: 'rt-empty' }, dt('drill.d730'))

      const shellProps = full
        ? { className: 'rt-full', style: { display: 'flex' } }
        : embedded
          ? { className: 'rt-dock rt-embedded', 'data-open': '1', style: { width: '100%', display: 'flex' } }
          : {
              className: 'rt-dock',
              'data-open': st.open ? '1' : '0',
              style: {
                left: geom.x + 'px',
                top: geom.y + 'px',
                right: 'auto',
                bottom: 'auto',
                width: geom.w + 'px',
                height: geom.h + 'px',
                display: st.open ? 'flex' : 'none',
              },
            }

      return h('div', shellProps,
        (full || embedded) ? null : h('div', { className: 'rt-grip', title: dt('drill.d731'), onMouseDown: startResizeLeft }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-r', title: dt('drill.d731'), onMouseDown: startResizeRight }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-b', title: dt('drill.d732'), onMouseDown: startResizeBottom }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-c', title: dt('drill.d733'), onMouseDown: startResizeCorner }),
        h('div', { className: 'rt-head', onMouseDown: (full || embedded) ? undefined : startDrag, title: (full || embedded) ? undefined : dt('drill.d734') },
          /* 页头在三处形态里都成立：主区（embedded）也要有标题与靶标选择，否则进来第一眼就是标签栏。 */
          h('div', { className: 'rt-title' },
            /* 状态点只在真有状态时出现：正常 / 警告（err） / 无靶标（不显示）。
               静态页挂一个永远绿的小圆点等于装饰，读的人会以为它在报什么。 */
            err ? h('span', { className: 'rt-dot rt-dot--warn', title: String(err) })
              : (eng && snapshot ? h('span', { className: 'rt-dot rt-dot--ok' }) : null),
            full ? [dt('drill.k30078')] : dt('drill.d735'),
            full ? h('span', { className: 'rt-tag', style: { marginLeft: 6 } }, dt('drill.d736')) : null),
          h('select', {
            className: 'rt-input rt-eng-select',
            style: { maxWidth: embedded ? '100%' : '170px', minWidth: embedded ? '160px' : undefined, flex: embedded ? '1 1 200px' : undefined },
            value: eng || '',
            onChange: (e) => {
              setEng(e.target.value)
              loadSnapshot(e.target.value)
              /* 同步「当前靶标」：原生 skill 目录按它解析技能根 */
              api({ op: 'activateEngagement', engagement: e.target.value }).catch(() => {})
            },
          },
            h('option', { value: '', disabled: true }, engagements.length ? [dt('drill.k30079')] : dt('drill.d737')),
            engagements.map((x) => h('option', { key: x.id, value: x.id }, x.name || x.id || dt('drill.d738'))),
          ),
          h('div', { className: 'rt-spacer' }),
          embedded ? null : h(VersionBar, null),
          full ? h('button', { className: 'rt-btn', title: dt('drill.d739'), onClick: exitFull }, dt('drill.d740')) : null,
          /* 刷新是这一页的主操作：强调色只给它（页签用下划线，不用色块）。 */
          h('button', { className: 'rt-btn', title: dt('drill.d741'), onClick: refreshAll }, dt('drill.d82')),
          (full || embedded) ? null : h('button', { className: 'rt-btn', title: dt('drill.d742'), onClick: openFull }, dt('drill.d743')),
          (full || embedded) ? null : h('button', { className: 'rt-btn', title: dt('drill.d744'), onClick: () => setUI({ open: false }) }, dt('drill.d745'))),
        /* 页签栏用标准 tablist/tab 角色：读屏软件据此播报「第几个页签、是否选中」。
           键盘用户 Tab 进来后可用 Enter/Space 切换（由 clickable 提供）。 */
        h('div', { className: 'rt-tabs', role: 'tablist' }, tabs.map((t) => {
          const activate = () => {
            markTabSeen(t[0])
            setUI({ tab: t[0] })
            /* 强制当前页重新取数，避免切页后仍显示上一页缓存视觉 */
            setRefreshKey((k) => k + 1)
          }
          return h('div', Object.assign({}, clickable(activate, { label: t[1] }), {
            key: t[0], className: 'rt-tab' + (st.tab === t[0] ? ' on' : ''),
            role: 'tab',
            'aria-selected': st.tab === t[0] ? 'true' : 'false',
            title: unreadOf(t[0]) ? t[1] + [dt('drill.k30080')] : t[1],
          }), t[1], unreadOf(t[0])
            /* 红点是纯视觉信息，给读屏软件一个文字替代 */
            ? h('span', { className: 'rt-tab-dot', 'aria-label': dt('drill.d746') })
            : null)
        })),
        h('div', { className: 'rt-body', key: 'body-' + st.tab }, h(RtBoundary, { key: st.tab }, body)),
        h('div', { className: 'rt-foot' },
          h(StatRow, {
            groups: [
              {
                key: 'assets',
                items: [
                  { key: 'segments', label: dt('drill.d747').trim(), value: stats.segments || 0 },
                  { key: 'assets', label: dt('drill.d264').trim(), value: stats.assets || 0 },
                  { key: 'live', label: dt('drill.d748').replace(/[（）()]/g, '').trim(), value: stats.liveAssets || 0 },
                  { key: 'ports', label: dt('drill.d305').trim(), value: stats.openPorts || 0 },
                  { key: 'fingerprints', label: dt('drill.d749').trim(), value: stats.fingerprints || 0 },
                ],
              },
              { key: 'vulns', items: [{ key: 'vulns', label: dt('drill.d306').trim(), value: stats.vulns || 0 }] },
              {
                key: 'signals',
                items: [{
                  key: 'signals',
                  label: dt('drill.d750').trim(),
                  value: (stats.passiveSignals || 0) + '/' + (stats.activeSignals || 0),
                }],
              },
            ],
          }),
          h('div', { className: 'rt-spacer' }),
          full ? h('span', null, dt('drill.d751')) : null,
          h('span', null, 'SQLite · ' + (snapshot && snapshot.engagement ? snapshot.engagement.name : ''))))
    }

    /* ---------------------------------------------------------- 入口按钮 */
    function SidebarButton(props) {
      const st = useUI()
      return h('button', {
        className: 'rt-icon-btn' + (st.open ? ' on' : ''),
        title: dt('drill.d752'),
        onClick: () => setUI({ open: !st.open }),
      }, h('span', { style: { fontSize: 14 } }, '⛨'), props.wide ? h('span', null, 'RedTeam') : null)
    }

    function HeaderButton() {
      const st = useUI()
      return h('button', {
        className: 'rt-hbtn' + (st.open ? ' on' : ''),
        title: dt('drill.d752'),
        onClick: () => setUI({ open: !st.open }),
      }, '⛨ RedTeam')
    }

    /** 侧栏「全面浏览」：在新浏览器窗口打开完整演练台（当前窗口不受影响）。 */
    function FullButton(props) {
      const open = () => {
        try { window.open(window.location.href.split('#')[0] + '#redteam-full', '_blank', 'noopener') } catch { /* 被浏览器拦截 */ }
      }
      return h('button', {
        className: 'rt-icon-btn',
        title: dt('drill.d753'),
        onClick: open,
      }, h('span', { style: { fontSize: 14 } }, '⛶'), props.wide ? h('span', null, dt('drill.d743')) : null)
    }

    /* ---------------------------------------------------------- 插件入口 */
    /** 唯一硬依赖：座位注册表。 */
    const inject = ['slots']

    /**
     * 注入样式 + 三处座位。样式标签与宽度变量随 fiber 卸载一起移除。
     * @param ctx - 客户端根上下文。
     */
    /**
     * 构建期锚点：本函数体在装配时被整段换成 applyDrillParts()（见 scripts/build-client.mjs），
     * 因为它不再自己注册座位 —— 演练台的座位由 shell.js 统一注册，这里只负责导出 CSS / Panel。
     * 原来挂在这里的三处注册（浮层演练台、侧栏两个按钮、会话头按钮）在产物里从未生效，属死代码。
     */
    function apply(ctx) { /* 整段被构建期替换 */ }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
