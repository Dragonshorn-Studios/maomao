/**
 * Vendored Infernal SaaS design system (`infernal-saas`), the shared
 * Dragonshorn Studios UX library. Source: Dragonshorn-Studios/infernal-saas
 * dist/infernal.css at commit 39944bebca5b — re-vendor by copying the
 * library's dist file, do not edit the rules in place. Product-specific
 * composition lives in theme.ts; the mergehenna brand tokens are selected
 * with data-if-brand on the document root.
 */

export const INFERNAL_HREF = "/assets/infernal.css";

export const INFERNAL_CSS = `/* Infernal UI v0.1 — framework-agnostic, namespaced component library */
:root, [data-if-theme="dark"] {
  color-scheme:dark;
  --if-bg:#0c0d13;--if-bg-raised:#11131c;--if-surface:#171925;--if-surface-2:#1d202e;--if-surface-hover:#252838;
  --if-line:#2b2e3d;--if-line-strong:#404355;--if-text:#f1eef7;--if-text-soft:#b4b2c2;--if-muted:#7f8297;
  --if-accent:#c58aff;--if-accent-ink:#1d102b;--if-accent-soft:#332342;--if-accent-line:#674477;
  --if-success:#76d8a0;--if-success-soft:#1b392e;--if-warning:#efc37a;--if-warning-soft:#3c3020;
  --if-danger:#ff8b99;--if-danger-soft:#43252e;--if-info:#8dbbff;--if-info-soft:#24374e;
  --if-shadow:0 18px 70px rgba(0,0,0,.23);--if-radius:12px;--if-radius-sm:7px;
  --if-font:Inter,"Segoe UI",ui-sans-serif,system-ui,-apple-system,sans-serif;
  --if-mono:"Cascadia Code","IBM Plex Mono",ui-monospace,SFMono-Regular,Consolas,monospace;
  --if-display:Georgia,"Iowan Old Style",serif;
}
[data-if-brand="mergehenna"] {--if-accent:#f4a86d;--if-accent-ink:#271409;--if-accent-soft:#38271f;--if-accent-line:#805038}
[data-if-brand="machine"] {--if-accent:#d49af5;--if-accent-ink:#24112f;--if-accent-soft:#362541;--if-accent-line:#765087}
[data-if-theme="light"] {
  color-scheme:light;--if-bg:#f2eff4;--if-bg-raised:#f9f7fb;--if-surface:#ffffff;--if-surface-2:#f4f2f8;--if-surface-hover:#eae7f1;
  --if-line:#dfdce8;--if-line-strong:#c5bfd3;--if-text:#282334;--if-text-soft:#5c586b;--if-muted:#777383;
  --if-success:#14784a;--if-success-soft:#ddf5e7;--if-warning:#8f580e;--if-warning-soft:#fff1d9;
  --if-danger:#b72d47;--if-danger-soft:#ffe5e9;--if-info:#2b67b2;--if-info-soft:#e1efff;
  --if-shadow:0 20px 55px rgba(56,39,71,.09);
}
[data-if-theme="light"][data-if-brand="machine"] {--if-accent:#8437af;--if-accent-ink:#fff;--if-accent-soft:#f1e5fa;--if-accent-line:#d4b5e4}
[data-if-theme="light"][data-if-brand="mergehenna"] {--if-accent:#a95523;--if-accent-ink:#fff;--if-accent-soft:#fff0e3;--if-accent-line:#e7c4aa}
*,*::before,*::after {box-sizing:border-box}
html{scroll-behavior:smooth}body{margin:0;background:var(--if-bg);color:var(--if-text);font:14px/1.5 var(--if-font)}
button,input,select,textarea{font:inherit}button{cursor:pointer}a{color:inherit;text-decoration:none}
::selection{background:var(--if-accent-soft);color:var(--if-text)}
:focus-visible{outline:2px solid var(--if-accent);outline-offset:3px}
button:disabled,input:disabled,select:disabled,textarea:disabled{opacity:.46;cursor:not-allowed}
.if-mono{font-family:var(--if-mono)}.if-muted{color:var(--if-muted)}.if-soft{color:var(--if-text-soft)}
.if-eyebrow{font:700 10px/1.4 var(--if-mono);text-transform:uppercase;letter-spacing:.18em;color:var(--if-accent)}
.if-display{font:400 clamp(30px,3vw,46px)/1.05 var(--if-display);letter-spacing:-.035em}
.if-h1{font-size:22px;letter-spacing:-.035em;font-weight:680;margin:0}.if-h2{font-size:16px;font-weight:650;margin:0;letter-spacing:-.02em}
.if-caption{color:var(--if-muted);font-size:12px}.if-row{display:flex;align-items:center;gap:10px;min-width:0}.if-row--between{justify-content:space-between}
.if-stack{display:flex;flex-direction:column;gap:12px;min-width:0}.if-stack--sm{gap:7px}.if-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.if-grid--two{grid-template-columns:repeat(2,minmax(0,1fr))}.if-section{margin-bottom:32px;scroll-margin-top:84px}
.if-section-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:15px}
.if-divider{height:1px;background:var(--if-line);border:0;margin:14px 0}
.if-card,.if-panel{background:var(--if-surface);border:1px solid var(--if-line);border-radius:var(--if-radius);min-width:0}
.if-card{padding:19px}.if-card--soft{background:var(--if-bg-raised)}.if-card--interactive{transition:border-color .16s,transform .16s}
/* Optional infernal treatment: a quiet glow inside cards, never essential UI state. */
:is(.if-card--ember,.if-stack-review,.if-panel:has(#build-progress)){position:relative;isolation:isolate;overflow:hidden;border-color:var(--if-accent-line)}
:is(.if-card--ember,.if-stack-review,.if-panel:has(#build-progress))::before{content:"";position:absolute;pointer-events:none;inset:10% -20% -45%;z-index:-1;background:radial-gradient(ellipse 55% 58% at 22% 90%,color-mix(in srgb,var(--if-accent) 39%,transparent),transparent 78%),radial-gradient(ellipse 48% 65% at 74% 88%,rgba(255,118,56,.25),transparent 76%),radial-gradient(ellipse 22% 68% at 52% 87%,rgba(255,189,72,.16),transparent 80%);filter:blur(19px);animation:if-ember-drift 6.8s ease-in-out infinite alternate;opacity:.7}
:is(.if-card--ember,.if-stack-review,.if-panel:has(#build-progress))::after{content:"";position:absolute;pointer-events:none;left:12%;right:12%;bottom:0;height:1px;background:linear-gradient(90deg,transparent,var(--if-accent),#f6a46a,transparent);opacity:.68;animation:if-ember-glint 4.5s ease-in-out infinite alternate}
:is(.if-card--ember,.if-stack-review,.if-panel:has(#build-progress))>*{position:relative}
@keyframes if-ember-drift{0%{transform:translate(-4%,10%) scale(.91) rotate(-4deg);opacity:.48}50%{transform:translate(3%,-4%) scale(1.06) rotate(3deg);opacity:.78}100%{transform:translate(-1%,-12%) scale(.98) rotate(-2deg);opacity:.57}}
@keyframes if-ember-glint{from{opacity:.25;transform:scaleX(.72)}to{opacity:.84;transform:scaleX(1.04)}}
.if-card--ember.if-card--ember-strong::before{opacity:1;filter:blur(12px);animation-duration:4.4s}
.if-card--interactive:hover{border-color:var(--if-accent-line);transform:translateY(-1px)}
.if-panel__head{padding:15px 18px;border-bottom:1px solid var(--if-line);display:flex;align-items:center;justify-content:space-between;gap:12px}
.if-panel__body{padding:18px}.if-panel__foot{border-top:1px solid var(--if-line);padding:12px 18px}
.if-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:35px;border:1px solid var(--if-line-strong);border-radius:var(--if-radius-sm);background:var(--if-surface-2);color:var(--if-text);font-weight:600;font-size:12px;padding:7px 13px;white-space:nowrap;transition:background .15s,border-color .15s,transform .15s}
.if-button:hover:not(:disabled){background:var(--if-surface-hover);border-color:var(--if-muted)}.if-button:active:not(:disabled){transform:translateY(1px)}
.if-button--primary{color:var(--if-accent-ink);background:var(--if-accent);border-color:var(--if-accent)}
.if-button--primary:hover:not(:disabled){background:color-mix(in srgb,var(--if-accent) 82%,white);border-color:var(--if-accent)}
.if-button--ghost{background:transparent;border-color:transparent;color:var(--if-text-soft)}
.if-button--danger{background:var(--if-danger-soft);color:var(--if-danger);border-color:color-mix(in srgb,var(--if-danger) 25%,transparent)}
.if-button--sm{min-height:28px;padding:4px 9px;font-size:11px}.if-button--lg{min-height:43px;padding:10px 18px;font-size:13px}
.if-button--icon{width:35px;min-width:35px;padding:0}.if-button-group{display:inline-flex;align-items:center;gap:0}
.if-button-group>.if-button{border-radius:0;margin-left:-1px}.if-button-group>.if-button:first-child{border-radius:var(--if-radius-sm) 0 0 var(--if-radius-sm);margin:0}
.if-button-group>.if-button:last-child{border-radius:0 var(--if-radius-sm) var(--if-radius-sm) 0}
.if-badge{display:inline-flex;align-items:center;gap:6px;border-radius:5px;padding:3px 8px;font:600 10px/1.45 var(--if-mono);background:var(--if-surface-2);color:var(--if-text-soft);border:1px solid var(--if-line);white-space:nowrap}
.if-badge--success{color:var(--if-success);background:var(--if-success-soft);border-color:transparent}
.if-badge--warning{color:var(--if-warning);background:var(--if-warning-soft);border-color:transparent}
.if-badge--danger{color:var(--if-danger);background:var(--if-danger-soft);border-color:transparent}
.if-badge--info{color:var(--if-info);background:var(--if-info-soft);border-color:transparent}
.if-badge--running{color:var(--if-accent);background:var(--if-accent-soft);border-color:transparent}
.if-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.if-dot--pulse{box-shadow:0 0 0 0 currentColor;animation:if-pulse 2s ease-out infinite}
@keyframes if-pulse{65%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}
.if-tabs{display:flex;gap:2px;align-items:center;padding:3px;border:1px solid var(--if-line);background:var(--if-bg-raised);border-radius:9px}
.if-tab{background:transparent;border:0;color:var(--if-muted);border-radius:6px;padding:7px 12px;font-weight:600;font-size:12px}
.if-tab:hover{color:var(--if-text)}.if-tab[aria-selected="true"],.if-tab.is-active{background:var(--if-surface-hover);color:var(--if-text);box-shadow:inset 0 0 0 1px var(--if-line)}
.if-field{display:flex;flex-direction:column;gap:6px;min-width:0}.if-label{font-weight:600;font-size:12px;color:var(--if-text-soft)}
.if-input,.if-select,.if-textarea{width:100%;background:var(--if-bg-raised);border:1px solid var(--if-line-strong);border-radius:var(--if-radius-sm);color:var(--if-text);padding:9px 11px;min-height:37px;outline:none}
.if-input::placeholder,.if-textarea::placeholder{color:var(--if-muted)}.if-input:focus,.if-select:focus,.if-textarea:focus{border-color:var(--if-accent);box-shadow:0 0 0 3px var(--if-accent-soft)}
.if-textarea{min-height:90px;resize:vertical}.if-field--error .if-input{border-color:var(--if-danger)}.if-error{color:var(--if-danger);font-size:11px}
.if-check{display:inline-flex;align-items:center;gap:9px;font-size:12px;color:var(--if-text-soft);cursor:pointer}
.if-check input{accent-color:var(--if-accent);width:15px;height:15px;cursor:pointer}
.if-switch{display:inline-flex;align-items:center;gap:10px;font-size:12px;cursor:pointer}.if-switch input{position:absolute;opacity:0;width:1px;height:1px}
.if-switch__track{width:34px;height:20px;border:1px solid var(--if-line-strong);border-radius:30px;background:var(--if-surface-hover);padding:2px;transition:background .16s}
.if-switch__track::before{content:"";display:block;width:14px;height:14px;border-radius:50%;background:var(--if-text-soft);transition:transform .16s,background .16s}
.if-switch input:checked+.if-switch__track{background:var(--if-accent);border-color:var(--if-accent)}
.if-switch input:checked+.if-switch__track::before{background:var(--if-accent-ink);transform:translateX(14px)}
.if-switch input:focus-visible+.if-switch__track{outline:2px solid var(--if-accent);outline-offset:3px}
.if-range{width:100%;accent-color:var(--if-accent)}
.if-progress{width:100%;height:5px;border:0;border-radius:6px;background:var(--if-surface-hover);overflow:hidden}
.if-progress>span{display:block;height:100%;border-radius:inherit;background:var(--if-accent);transition:width .3s}
.if-progress--success>span{background:var(--if-success)}
.if-banner{padding:13px 15px;border-radius:var(--if-radius-sm);display:flex;align-items:flex-start;gap:11px;border:1px solid var(--if-accent-line);background:var(--if-accent-soft);font-size:12px}
.if-banner--warning{border-color:color-mix(in srgb,var(--if-warning) 30%,transparent);background:var(--if-warning-soft)}
.if-banner--danger{border-color:color-mix(in srgb,var(--if-danger) 30%,transparent);background:var(--if-danger-soft)}
.if-banner--success{border-color:color-mix(in srgb,var(--if-success) 30%,transparent);background:var(--if-success-soft)}
.if-avatar{height:34px;width:34px;flex:none;border:1px solid var(--if-accent-line);border-radius:10px;background:var(--if-accent-soft);display:grid;place-items:center;color:var(--if-accent);font-weight:800;font-size:13px}
.if-avatar--round{border-radius:50%}
.if-table-wrap{overflow-x:auto;border-radius:var(--if-radius);border:1px solid var(--if-line)}
.if-table{width:100%;border-collapse:collapse;min-width:620px;text-align:left}
.if-table th{font:700 10px var(--if-mono);text-transform:uppercase;letter-spacing:.1em;color:var(--if-muted);background:var(--if-bg-raised);padding:11px 14px}
.if-table td{padding:12px 14px;border-top:1px solid var(--if-line);font-size:12px}
.if-table tbody tr:hover{background:var(--if-surface-hover)}
.if-queue-item{display:flex;align-items:center;gap:12px;padding:13px 14px;border-bottom:1px solid var(--if-line)}
.if-queue-item:last-child{border-bottom:0}.if-queue-item__index{font:600 12px var(--if-mono);color:var(--if-muted);width:24px;text-align:center}
.if-queue-item__body{flex:1;min-width:0}.if-queue-item__name{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.if-timeline{margin:0;padding:0 0 0 15px;list-style:none;border-left:1px solid var(--if-line)}
.if-timeline li{position:relative;margin:0 0 17px;padding-left:14px;font-size:12px}.if-timeline li:last-child{margin-bottom:0}
.if-timeline li::before{content:"";position:absolute;top:5px;left:-20px;border:3px solid var(--if-surface);background:var(--if-accent);height:10px;width:10px;border-radius:50%}
.if-code{background:#0c0e17;color:#dcd4ea;border:1px solid #313345;border-radius:var(--if-radius-sm);padding:14px;font:11px/1.7 var(--if-mono);overflow:auto}
.if-code .token-plus{color:#92dfaf}.if-code .token-minus{color:#ff929b}.if-code .token-comment{color:#7e879f}
.if-diff{font:11px/1.75 var(--if-mono);background:#0c0e17;border:1px solid #303143;border-radius:var(--if-radius-sm);overflow:auto;white-space:pre;color:#dcd4ea}
.if-diff div{padding:0 12px}.if-diff .if-diff--add{background:#15302a;color:#92dfaf}.if-diff .if-diff--remove{background:#342128;color:#ff929b}.if-diff .if-diff--meta{background:#1c2132;color:#9fbaf1}
.if-chat{display:flex;align-items:flex-start;gap:10px}.if-chat__bubble{background:var(--if-surface-2);border:1px solid var(--if-line);padding:13px 15px;border-radius:3px 11px 11px 11px;flex:1;font-size:12px}
.if-activity{display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid var(--if-line);background:var(--if-bg-raised);border-radius:8px;font-size:12px}
.if-empty{text-align:center;padding:30px 20px;border:1px dashed var(--if-line-strong);border-radius:var(--if-radius);color:var(--if-muted)}
.if-skeleton{height:12px;border-radius:5px;background:linear-gradient(95deg,var(--if-surface-2) 20%,var(--if-surface-hover) 50%,var(--if-surface-2) 80%);background-size:220% 100%;animation:if-shimmer 1.9s infinite}
@keyframes if-shimmer{to{background-position-x:-220%}}
.if-dialog{border:1px solid var(--if-line-strong);border-radius:14px;background:var(--if-surface);color:var(--if-text);padding:0;width:min(440px,calc(100vw - 32px));box-shadow:var(--if-shadow)}
.if-dialog::backdrop{background:rgba(4,5,10,.78);backdrop-filter:blur(4px)}
.if-dialog__head{padding:19px 22px;border-bottom:1px solid var(--if-line)}.if-dialog__body{padding:20px 22px}.if-dialog__foot{padding:14px 22px;border-top:1px solid var(--if-line);display:flex;justify-content:flex-end;gap:9px}
.if-dialog__body{display:flex;flex-direction:column;gap:12px}
.if-popover{position:absolute;background:var(--if-surface);border:1px solid var(--if-line-strong);border-radius:9px;box-shadow:var(--if-shadow);padding:5px;min-width:180px;z-index:8}
.if-menu-item{display:flex;gap:10px;align-items:center;width:100%;border:0;border-radius:5px;color:var(--if-text-soft);text-align:left;padding:9px;background:transparent;font-size:12px}
.if-menu-item:hover{background:var(--if-surface-hover);color:var(--if-text)}
.if-tooltip{position:relative}.if-tooltip:hover::after,.if-tooltip:focus-visible::after{content:attr(data-tooltip);position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);padding:6px 9px;background:var(--if-text);color:var(--if-bg);border-radius:5px;white-space:nowrap;font:11px var(--if-font);z-index:10}
/* Shell */
.if-app{min-height:100vh;display:grid;grid-template-columns:236px minmax(0,1fr)}.if-sidebar{background:var(--if-bg-raised);border-right:1px solid var(--if-line);padding:24px 13px;display:flex;flex-direction:column;gap:24px}
.if-brand{display:flex;align-items:center;gap:11px;padding:0 10px}.if-brand__mark{width:31px;height:31px;display:grid;place-items:center;border:1px solid var(--if-accent-line);border-radius:10px;color:var(--if-accent);background:var(--if-accent-soft);font:italic 700 21px var(--if-display)}
.if-brand__title{font-weight:750;letter-spacing:-.025em;font-size:15px;line-height:1}.if-brand__caption{font:9px var(--if-mono);letter-spacing:.14em;color:var(--if-muted);text-transform:uppercase;margin-top:4px}
.if-nav-title{font:700 10px var(--if-mono);color:var(--if-muted);letter-spacing:.12em;text-transform:uppercase;padding:0 13px 7px}
.if-nav-link{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:8px;color:var(--if-text-soft);font-size:12px;margin:2px 0}
.if-nav-link:hover{background:var(--if-surface-hover)}.if-nav-link.is-active{background:var(--if-accent-soft);color:var(--if-text);box-shadow:inset 2px 0 var(--if-accent)}
.if-nav-link .if-nav-icon{width:18px;text-align:center;color:var(--if-muted)}.if-nav-link.is-active .if-nav-icon{color:var(--if-accent)}
.if-main{min-width:0}.if-topbar{min-height:61px;border-bottom:1px solid var(--if-line);display:flex;align-items:center;justify-content:space-between;padding:10px 30px;gap:18px;background:var(--if-bg-raised);position:sticky;top:0;z-index:4}
.if-content{max-width:1510px;margin:0 auto;padding:30px;min-width:0}.if-inspector{background:var(--if-bg-raised);border-left:1px solid var(--if-line)}
.if-kpi{padding:19px;border:1px solid var(--if-line);background:var(--if-surface);border-radius:var(--if-radius)}
.if-kpi__value{font:650 30px/1.2 var(--if-font);letter-spacing:-.05em;margin:11px 0 6px}
/* Composite patterns: stack reviews, reviewer runs, agent plans, tool calls. */
.if-pattern-head{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:15px 18px;border-bottom:1px solid var(--if-line)}
.if-stack-review{border:1px solid var(--if-accent-line);background:var(--if-surface);border-radius:var(--if-radius);overflow:hidden}
.if-stack-review__summary{padding:18px;background:linear-gradient(105deg,var(--if-accent-soft),transparent 75%)}
.if-stack-track{list-style:none;display:flex;align-items:center;gap:0;margin:14px 0;padding:0;overflow:auto}
.if-stack-track li{display:flex;align-items:center;flex:1;min-width:85px;font:600 11px var(--if-mono);color:var(--if-muted)}
.if-stack-track li:not(:last-child)::after{content:"";height:1px;flex:1;margin:0 9px;background:var(--if-line-strong)}
.if-stack-track a,.if-stack-track span{border:1px solid var(--if-line-strong);padding:7px 9px;border-radius:7px;white-space:nowrap}
.if-stack-track .is-done a{background:var(--if-success-soft);color:var(--if-success);border-color:transparent}
.if-stack-track .is-current a{background:var(--if-accent-soft);color:var(--if-accent);border-color:var(--if-accent-line)}
.if-stack-member{padding:13px 17px;display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:12px;align-items:center;border-top:1px solid var(--if-line)}
.if-stack-member__number{font:600 12px var(--if-mono);color:var(--if-muted)}
.if-stack-member__title{font-weight:650;font-size:13px}.if-stack-member__meta{font:11px var(--if-mono);color:var(--if-muted);margin-top:4px}
.if-reviewer-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.if-reviewer-card{background:var(--if-bg-raised);border:1px solid var(--if-line);border-radius:9px;padding:14px;min-width:0}
.if-reviewer-card__icon{display:grid;place-items:center;height:29px;width:29px;background:var(--if-accent-soft);color:var(--if-accent);border-radius:8px;font-size:16px}
.if-reviewer-run{display:grid;grid-template-columns:130px minmax(0,1fr) 85px 85px;gap:12px;align-items:center;padding:12px 15px;border-bottom:1px solid var(--if-line);font-size:12px}
.if-reviewer-run:last-child{border:0}.if-reviewer-run__owner{font:10px var(--if-mono);color:var(--if-muted)}
.if-finding{border:1px solid var(--if-line);border-radius:9px;background:var(--if-bg-raised);overflow:hidden}
.if-finding summary{cursor:pointer;padding:15px 16px;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:12px}
.if-finding summary::-webkit-details-marker{display:none}.if-finding summary::after{content:"⌄";color:var(--if-muted)}.if-finding[open] summary::after{content:"⌃"}
.if-finding__body{padding:15px 16px;border-top:1px solid var(--if-line);font-size:12px;color:var(--if-text-soft)}
.if-plan-step{display:grid;grid-template-columns:25px minmax(0,1fr) auto;align-items:start;gap:12px;padding:15px 0;border-bottom:1px solid var(--if-line)}
.if-plan-step:last-child{border:0}.if-plan-step__mark{height:23px;width:23px;border:1px solid var(--if-line-strong);border-radius:50%;display:grid;place-items:center;font:600 11px var(--if-mono);color:var(--if-muted)}
.if-plan-step.is-done .if-plan-step__mark{background:var(--if-success-soft);color:var(--if-success);border:0}.if-plan-step.is-running .if-plan-step__mark{background:var(--if-accent-soft);color:var(--if-accent);border:0}
.if-tool-card{border:1px solid var(--if-line);border-radius:9px;overflow:hidden;background:var(--if-bg-raised)}
.if-tool-card summary{padding:12px 15px;cursor:pointer;display:flex;align-items:center;gap:9px;list-style:none}.if-tool-card summary::-webkit-details-marker{display:none}
.if-tool-card__body{padding:12px 15px;border-top:1px solid var(--if-line)}
.if-approval{border:1px solid var(--if-accent-line);border-radius:10px;background:var(--if-accent-soft);padding:17px}
.if-change-row{padding:12px 15px;border-bottom:1px solid var(--if-line);display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12px}
.if-change-row:last-child{border:0}
/* Expanded product-pattern vocabulary. */
.if-crumbs{display:flex;align-items:center;gap:8px;color:var(--if-muted);font:11px var(--if-mono);flex-wrap:wrap}.if-crumbs strong{color:var(--if-text)}
.if-metric-strip{display:flex;gap:16px;flex-wrap:wrap;padding:12px 14px;background:var(--if-bg-raised);border:1px solid var(--if-line);border-radius:9px}.if-metric-strip>div{display:grid;gap:2px}.if-metric-strip small{color:var(--if-muted);text-transform:uppercase;letter-spacing:.08em;font:10px var(--if-mono)}.if-metric-strip strong{font:12px var(--if-mono)}
.if-tree{list-style:none;padding:0;margin:0;font:12px var(--if-mono)}.if-tree li{padding:7px 11px;border-radius:6px}.if-tree li:hover{background:var(--if-surface-hover)}.if-tree .is-selected{background:var(--if-accent-soft);color:var(--if-accent)}.if-tree .if-tree__nested{padding-left:24px}
.if-command-list{border:1px solid var(--if-line);border-radius:9px;overflow:hidden}.if-command-row{padding:11px 13px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--if-line);font-size:12px}.if-command-row:last-child{border:0}.if-command-row kbd{margin-left:auto;border:1px solid var(--if-line-strong);border-radius:4px;padding:2px 5px;font:10px var(--if-mono);color:var(--if-muted)}
.if-log{overflow:auto;max-height:160px;background:#0c0e17;border:1px solid #303143;border-radius:8px;color:#c9c5d3;padding:12px;font:11px/1.8 var(--if-mono)}
.if-audit{display:grid;grid-template-columns:110px minmax(0,1fr) auto;align-items:center;gap:10px;padding:12px;border-bottom:1px solid var(--if-line);font-size:12px}.if-audit:last-child{border:0}
.if-screen-preview{border:1px solid var(--if-line-strong);border-radius:13px;overflow:hidden;background:var(--if-surface);box-shadow:var(--if-shadow)}
.if-screen-preview__bar{padding:11px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--if-line);background:var(--if-bg-raised)}
.if-screen-preview__frame{width:100%;height:670px;border:0;display:block;background:var(--if-bg)}
.if-screen-preview__notes{padding:13px 17px;border-top:1px solid var(--if-line);color:var(--if-muted);font-size:12px;line-height:1.6}
/* Two-tier navigation: persistent icon rail + context-sensitive side navigation. */
.if-rail-layout{display:grid;grid-template-columns:60px 248px minmax(0,1fr);min-height:560px;background:var(--if-bg);border:1px solid var(--if-line);border-radius:12px;overflow:hidden}
.if-rail{display:flex;flex-direction:column;align-items:center;gap:7px;padding:12px 7px;border-right:1px solid var(--if-line);background:var(--if-bg-raised)}
.if-rail__logo{display:grid;place-items:center;width:40px;height:40px;border:1px solid var(--if-accent-line);border-radius:12px;background:var(--if-accent-soft);color:var(--if-accent);font-size:20px;margin-bottom:12px}
.if-rail__button{display:grid;place-items:center;position:relative;width:40px;height:40px;border:0;border-radius:10px;background:transparent;color:var(--if-muted);font-size:19px}
.if-rail__button:hover{background:var(--if-surface-hover);color:var(--if-text)}
.if-rail__button[aria-pressed="true"]{background:var(--if-accent-soft);color:var(--if-accent)}
.if-rail__button[aria-pressed="true"]::before{content:"";position:absolute;left:-7px;top:10px;height:20px;width:3px;border-radius:4px;background:var(--if-accent)}
.if-rail__spacer{flex:1}.if-rail__avatar{width:32px;height:32px;border-radius:50%;background:var(--if-surface-hover);color:var(--if-text);border:1px solid var(--if-line-strong);display:grid;place-items:center;font:700 12px var(--if-font)}
.if-context-nav{background:var(--if-bg-raised);border-right:1px solid var(--if-line);padding:18px 11px;min-width:0;display:flex;flex-direction:column}
.if-context-nav__head{padding:0 9px 16px;display:flex;align-items:center;justify-content:space-between;gap:9px}
.if-context-nav__title{font-weight:750;font-size:14px}.if-context-nav__section{font:700 10px var(--if-mono);letter-spacing:.1em;color:var(--if-muted);text-transform:uppercase;padding:15px 10px 7px}
.if-context-nav__item{border:0;background:transparent;display:flex;align-items:center;gap:10px;width:100%;color:var(--if-text-soft);border-radius:7px;padding:9px 10px;text-align:left;font-size:12px;min-width:0}
.if-context-nav__item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.if-context-nav__item:hover{background:var(--if-surface-hover)}.if-context-nav__item.is-active{background:var(--if-accent-soft);color:var(--if-text)}
.if-context-nav__item .if-context-nav__pin{margin-left:auto;flex:none;color:var(--if-muted);font-size:11px}.if-context-nav__item.is-active .if-context-nav__pin{color:var(--if-accent)}
.if-context-nav__scroll{overflow-y:auto;flex:1;min-height:0}.if-rail-workspace{font:10px var(--if-mono);color:var(--if-muted);padding:4px 10px 10px}
.if-rail-content{min-width:0;display:flex;flex-direction:column}.if-rail-content__bar{padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--if-line);background:var(--if-bg-raised)}
.if-rail-layout.is-collapsed{grid-template-columns:60px 0 minmax(0,1fr)}.if-rail-layout.is-collapsed .if-context-nav{overflow:hidden;padding:0;visibility:hidden;border:0}
@media(max-width:720px){.if-rail-layout{grid-template-columns:52px minmax(0,1fr);min-height:540px}.if-rail{padding:9px 5px}.if-rail__button{width:38px;height:38px}.if-context-nav{grid-column:2;grid-row:1;padding:10px}.if-rail-content{grid-column:1/-1;grid-row:2;border-top:1px solid var(--if-line)}.if-rail-layout.is-collapsed{grid-template-columns:52px minmax(0,1fr)}.if-rail-layout.is-collapsed .if-rail-content{grid-row:1;grid-column:2}}
@media(max-width:900px){.if-reviewer-grid{grid-template-columns:1fr}.if-reviewer-run{grid-template-columns:110px 1fr}.if-reviewer-run__owner{display:none}}
@media (max-width:1050px){.if-app{grid-template-columns:70px minmax(0,1fr)}.if-sidebar{padding:20px 9px}.if-brand__title,.if-brand__caption,.if-nav-title,.if-nav-link .if-nav-text,.if-sidebar__footer{display:none}.if-brand{padding:0;justify-content:center}.if-nav-link{justify-content:center}.if-content{padding:20px}.if-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:680px){.if-app{display:block}.if-sidebar{position:static;display:flex;flex-direction:row;padding:8px 12px;gap:7px;overflow:auto}.if-sidebar nav{display:flex}.if-sidebar .if-nav-title,.if-sidebar__footer{display:none}.if-nav-link{min-width:37px;padding:9px}.if-brand{margin-right:8px}.if-topbar{padding:10px 15px;flex-wrap:wrap}.if-content{padding:17px}.if-grid,.if-grid--two{grid-template-columns:1fr}.if-section-heading{align-items:flex-start;flex-direction:column}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
