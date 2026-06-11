/**
 * Shared visual contract for every self-contained HTML report (behavioral gap
 * report, competitive cube, content-quality/smell audit).
 *
 * Direction: quiet, modern, legible — one typeface, a tight neutral palette
 * with a single blue accent, pass/warn/fail mapped to green/amber/red. Reports
 * read like a clear product page, not a dashboard. Status hues are text/border
 * accents only (no filled chips); body never goes mono.
 *
 * One source of truth so the family stays visually consistent. To rebrand for
 * your own org/target, override the `:root` block but keep the variable names —
 * the rest of the stylesheet depends on them. The `ax-*` class hooks are the
 * stable contract a design system can restyle without touching report structure.
 */
export const REPORT_STYLE = `
:root {
  --bg:#ffffff; --bg-soft:#f7f8fa; --card:#ffffff;
  --ink:#15171c; --muted:#5b6573; --faint:#959ba6; --hair:#e7e9ee;
  --accent:#2563eb;
  --pass:#15803d; --warn:#b45309; --fail:#b42318;
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:36px; --s7:56px;
  --radius:12px; --radius-sm:8px;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,ui-sans-serif,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,"JetBrains Mono",monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font); font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
.ax-main { max-width: 1100px; margin: 0 auto; padding: var(--s7) var(--s5) 96px; }

/* Header */
.ax-header { margin-bottom: var(--s7); }
.ax-eyebrow { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); margin-bottom: var(--s2); }
.ax-title { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; margin: 0 0 var(--s3); }
.ax-target { color: var(--accent); }
.ax-subtitle { color: var(--muted); margin: 0; font-size: 15px; max-width: 60ch; }
.ax-meta { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s5); margin: var(--s5) 0 0; padding: var(--s4) 0 0; border-top: 1px solid var(--hair); }
.ax-meta > div { display: flex; gap: var(--s2); font-size: 12.5px; }
.ax-meta dt { color: var(--faint); margin: 0; }
.ax-meta dd { margin: 0; color: var(--muted); }
.ax-code { font-family: var(--mono); font-size: 0.86em; background: var(--bg-soft); border: 1px solid var(--hair); padding: 1px 5px; border-radius: 5px; color: var(--ink); }

/* Section */
.ax-section { margin: 0 0 var(--s7); }
.ax-section > h2 { font-size: 13px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: var(--muted); margin: 0 0 var(--s4); }

/* Verdict — the single hero statement */
.ax-verdict { font-size: 21px; font-weight: 600; line-height: 1.4; letter-spacing: -0.01em; color: var(--ink); margin: 0 0 var(--s5); max-width: 58ch; }

/* Prominent caveats — used for generated sample/fake-data reports where the
   reader must see the limitation before interpreting any score. */
.ax-caveat { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s3); align-items: baseline; border: 1px solid var(--hair); border-left: 3px solid var(--warn); border-radius: var(--radius-sm); padding: var(--s3) var(--s4); margin: 0 0 var(--s5); background: color-mix(in srgb, var(--warn) 8%, var(--card)); }
.ax-caveat__label { color: var(--warn); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; }
.ax-caveat__detail { color: var(--ink); font-size: 13px; }

/* TL;DR — executive summary block at the very top */
.ax-tldr { background: var(--bg-soft); border: 1px solid var(--hair); border-radius: var(--radius); padding: var(--s5); margin-bottom: var(--s6); }
.ax-tldr__takeaway { font-size: 16px; line-height: 1.5; color: var(--ink); margin: 0 0 var(--s4); max-width: 70ch; }
.ax-tldr__pills { display: flex; flex-wrap: wrap; gap: var(--s2); margin-bottom: var(--s3); }
.ax-tldr__pill { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: var(--s2) var(--s3); border: 1px solid var(--hair); border-radius: var(--radius-sm); background: var(--card); text-decoration: none; min-width: 7.5em; }
a.ax-tldr__pill:hover { border-color: var(--accent); }
.ax-tldr__pill--static { cursor: default; }
.ax-tldr__pill-val { font-size: 20px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
.ax-tldr__pill-scale { font-size: 12px; font-weight: 600; color: var(--faint); margin-left: 1px; }
.ax-tldr__pill-label { font-size: 12px; color: var(--muted); }
.ax-tldr__jump { font-size: 13px; color: var(--muted); margin: 0; }
.ax-tldr__jump a { color: var(--accent); }
.ax-tldr__byharness { margin: var(--s3) 0; }
.ax-tldr__byharness-h { font-size: 12px; color: var(--faint); margin-bottom: var(--s2); }
.ax-tldr__byharness-h a { color: var(--accent); }
.ax-tldr__hrow { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s2) var(--s4); padding: var(--s2) 0; border-top: 1px solid var(--hair); font-size: 13px; color: var(--muted); }
.ax-tldr__hname { font-family: var(--mono); font-size: .9em; color: var(--ink); min-width: 8em; }
.ax-tldr__hmetric strong { color: var(--ink); font-variant-numeric: tabular-nums; }

/* Scorecard */
.ax-scorecard { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s3); }
.ax-scorecard--four { grid-template-columns: repeat(4, 1fr); }
.ax-card { border: 1px solid var(--hair); border-radius: var(--radius); padding: var(--s4); background: var(--card); }
.ax-card__value { font-size: 32px; font-weight: 700; line-height: 1; letter-spacing: -0.03em; display: block; }
.ax-card__scale { font-size: 15px; font-weight: 600; color: var(--faint); letter-spacing: 0; margin-left: 1px; }
.ax-card__label { color: var(--muted); font-size: 13px; font-weight: 500; display: block; margin-top: var(--s2); }
.ax-card__sub { color: var(--faint); font-size: 12px; display: block; margin-top: 2px; }

/* "How these scores are computed" — a collapsible explainer under the scorecard */
.ax-howscored { margin-top: var(--s4); border-top: 1px solid var(--hair); padding-top: var(--s3); }
.ax-howscored > summary { font-size: 13px; font-weight: 600; color: var(--muted); cursor: pointer; }
.ax-howscored ul { margin: var(--s3) 0 0; padding-left: var(--s4); display: flex; flex-direction: column; gap: var(--s2); }
.ax-howscored li { color: var(--muted); font-size: 13px; line-height: 1.5; }
.ax-card--pass .ax-card__value { color: var(--pass); }
.ax-card--warn .ax-card__value { color: var(--warn); }
.ax-card--fail .ax-card__value { color: var(--fail); }

/* Findings — simple bulleted list with an accent dot */
.ax-findings { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--s3); }
.ax-finding { position: relative; padding-left: var(--s4); color: var(--ink); }
.ax-finding::before { content: ""; position: absolute; left: 0; top: 9px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }

/* Recommendations */
.ax-recs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--s3); }
.ax-rec { border: 1px solid var(--hair); border-left: 3px solid var(--hair); border-radius: var(--radius-sm); padding: var(--s4); background: var(--card); }
.ax-rec--high { border-left-color: var(--fail); }
.ax-rec--med { border-left-color: var(--warn); }
.ax-rec--low { border-left-color: var(--pass); }
.ax-rec__badge { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.ax-rec--high .ax-rec__badge { color: var(--fail); }
.ax-rec--med .ax-rec__badge { color: var(--warn); }
.ax-rec--low .ax-rec__badge { color: var(--pass); }
.ax-rec__title { font-size: 16px; font-weight: 600; margin: var(--s1) 0 var(--s2); color: var(--ink); }
.ax-rec__detail { margin: 0; color: var(--muted); font-size: 14px; }
.ax-rec__grid { margin-top: var(--s3); display: flex; flex-direction: column; gap: var(--s1); }
.ax-rec__row { display: grid; grid-template-columns: 5.5em 1fr; gap: var(--s3); font-size: 13px; color: var(--ink); }
.ax-rec__key { color: var(--faint); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.03em; padding-top: 2px; }
.ax-empty { color: var(--muted); font-style: italic; margin: 0; }

/* Tables */
.ax-subhead { font-size: 13px; font-weight: 600; color: var(--ink); margin: var(--s5) 0 var(--s2); }
/* Wide tables scroll horizontally instead of overflowing/wrapping the page. */
.ax-table-wrap { overflow-x: auto; margin-top: var(--s2); -webkit-overflow-scrolling: touch; }
.ax-table-wrap .ax-table { margin-top: 0; }
.ax-table-wrap .ax-table th, .ax-table-wrap .ax-table td { white-space: nowrap; }
.ax-table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: var(--s2); }
.ax-table th, .ax-table td { text-align: left; padding: 9px var(--s3); border-bottom: 1px solid var(--hair); }
.ax-table thead th { color: var(--faint); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
.ax-table tbody tr:last-child td { border-bottom: 0; }
.ax-table td { color: var(--ink); }
.ax-pass { color: var(--pass); font-weight: 600; }
.ax-fail { color: var(--fail); font-weight: 600; }
/* Pill badge variants for PASS/FAIL cells — high-contrast green/red so the
   status reads at a glance even in dense tables. */
.ax-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; line-height: 1.4; }
.ax-pill--pass { color: #166534; background: #dcfce7; border: 1px solid #86efac; }
.ax-pill--fail { color: #991b1b; background: #fee2e2; border: 1px solid #fca5a5; }
.ax-note { color: var(--muted); font-size: 13px; line-height: 1.6; margin: var(--s3) 0 0; max-width: 72ch; }

/* Heat cells for the competitive tables — a metric reads at a glance by color:
   green (strong) → amber (mixed) → red (weak); em-dash is neutral/unmeasured. */
.ax-heat { display: inline-block; min-width: 3.2em; text-align: center; padding: 2px 8px; border-radius: 6px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ax-table .ax-heat:not(.ax-heat--count) { min-width: 5.8em; }
.ax-heat--count { min-width: 2.4em; }
.ax-heat--hi { color: #166534; background: #dcfce7; border: 1px solid #86efac; }
.ax-heat--mid { color: #92400e; background: #fef3c7; border: 1px solid #fcd34d; }
.ax-heat--lo { color: #991b1b; background: #fee2e2; border: 1px solid #fca5a5; }
.ax-heat--na { color: var(--faint); background: var(--bg-soft); border: 1px solid var(--hair); }
.ax-heat--blocked { color: #3730a3; background: #e0e7ff; border: 1px solid #a5b4fc; min-width: 0; text-transform: uppercase; letter-spacing: .04em; font-size: .82em; }
.ax-row--blocked td { opacity: .72; }

/* Harness × surface matrix (standard report, when >1 cell) */
.ax-matrix th { font-weight: 600; }
.ax-matrix thead th { text-transform: uppercase; font-size: 12px; letter-spacing: .03em; color: var(--faint); }
.ax-mcell__harness { color: var(--ink); font-family: var(--mono); font-size: .9em; }
.ax-mcell__sub { color: var(--faint); font-size: 11px; margin-left: 4px; }
.ax-mcell--na { color: var(--faint); }
/* Excel-style merged surface cell + dividers between surface groups */
.ax-mx-surface { font-weight: 700; vertical-align: middle; color: var(--ink); border-right: 1px solid var(--hair); text-transform: uppercase; font-size: 12px; letter-spacing: .03em; }
.ax-matrix .ax-mx-group > td, .ax-matrix .ax-mx-group > th { border-top: 2px solid var(--ink); }
.ax-matrix tbody tr:not(.ax-mx-group) > td { border-top: 0; }
/* Agent-discovery as colored TEXT (not a pill), tinted by the strict score scale. */
.ax-disc--hi { color: #166534; font-weight: 600; }
.ax-disc--mid { color: #92400e; font-weight: 600; }
.ax-disc--lo { color: #991b1b; font-weight: 600; }
.ax-count { font-weight: 700; font-variant-numeric: tabular-nums; }
.ax-proc-source { font-weight: 700; }
.ax-proc-source--ok { color: #166534; }
.ax-proc-source--warn { color: #92400e; }
.ax-proc-source--bad { color: #991b1b; }
/* Rank medals in the cross-product leaderboard. */
.ax-rank { display: inline-flex; align-items: center; justify-content: center; width: 1.6em; height: 1.6em; border-radius: 999px; font-weight: 700; font-size: 12px; }
.ax-rank--1 { background: #fde68a; color: #78350f; border: 1px solid #f59e0b; }
.ax-rank--2 { background: #e5e7eb; color: #374151; border: 1px solid #9ca3af; }
.ax-rank--3 { background: #fed7aa; color: #7c2d12; border: 1px solid #fb923c; }
.ax-rank--n { color: var(--faint); }
.ax-table tr.ax-row--best td { background: color-mix(in srgb, #16a34a 7%, transparent); }

/* Runtime warnings — visible but not alarming; sits inside Methodology. */
.ax-warnings { margin-top: var(--s4); padding: var(--s3) var(--s4); border-left: 3px solid var(--warn); background: color-mix(in srgb, var(--warn) 8%, var(--card)); border-radius: var(--radius-sm); }
.ax-warnings .ax-subhead { margin-top: 0; }
.ax-warnings__list { margin: var(--s2) 0 0; padding-left: var(--s4); color: var(--ink); font-size: 13px; line-height: 1.6; }
.ax-warnings__list li { margin: 0 0 var(--s1); }

/* Appendix — lower emphasis, collapsible task detail */
.ax-appendix { margin-top: var(--s7); padding-top: var(--s5); border-top: 1px solid var(--hair); }
.ax-task { border: 1px solid var(--hair); border-radius: var(--radius-sm); margin: 0 0 var(--s2); padding: 0 var(--s4); background: var(--card); }
.ax-task > summary { cursor: pointer; font-weight: 600; font-size: 14px; padding: var(--s3) 0; color: var(--ink); }
.ax-task__diff { color: var(--faint); font-weight: 400; font-size: 13px; }
.ax-prompt { font-family: var(--mono); font-size: 12.5px; white-space: pre-wrap; background: var(--bg-soft); border: 1px solid var(--hair); border-radius: var(--radius-sm); padding: var(--s3); margin: var(--s2) 0; color: var(--muted); }
.ax-oracles { margin: var(--s2) 0 var(--s3); padding-left: var(--s4); font-size: 13px; color: var(--muted); }
.ax-oracles li { margin: 3px 0; }
.ax-outcome { font-weight: 600; margin: var(--s3) 0 2px; font-size: 13px; }
.ax-trace { font-family: var(--mono); font-size: 12px; color: var(--muted); margin: var(--s2) 0 var(--s3); padding-left: var(--s4); list-style: none; }
.ax-trace li { margin: 2px 0; }

/* CI gate banner + robustness/trace status pills */
.ax-gate { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; border: 1px solid var(--hair); border-left: 3px solid var(--hair); border-radius: var(--radius-sm); padding: var(--s3) var(--s4); margin: 0 0 var(--s5); background: var(--card); }
.ax-gate--pass { border-left-color: var(--pass); }
.ax-gate--warn { border-left-color: var(--warn); background: color-mix(in srgb, var(--warn) 6%, var(--card)); }
.ax-gate--fail { border-left-color: var(--fail); }
.ax-gate__status { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.ax-gate--pass .ax-gate__status { color: var(--pass); }
.ax-gate--warn .ax-gate__status { color: var(--warn); }
.ax-gate--fail .ax-gate__status { color: var(--fail); }
.ax-gate__detail { color: var(--muted); font-size: 13px; }
.ax-kind { font-family: var(--mono); font-size: 12px; color: var(--fail); }

/* Smell tags (content-quality audit) — small category chips on an endpoint. */
.ax-tags { display: inline-flex; flex-wrap: wrap; gap: var(--s1); margin-left: var(--s2); vertical-align: middle; }
.ax-tag { font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: 0.03em; padding: 1px 6px; border-radius: 5px; color: var(--fail); background: color-mix(in srgb, var(--fail) 9%, var(--card)); border: 1px solid color-mix(in srgb, var(--fail) 25%, var(--card)); }
.ax-smell-groups { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s2); padding: 0; margin: var(--s3) 0; list-style: none; }
.ax-smell-group { display: flex; gap: var(--s2); align-items: flex-start; border: 1px solid var(--hair); border-radius: var(--radius-sm); background: var(--card); padding: var(--s3); min-width: 0; }
.ax-smell-group__count { flex: 0 0 auto; min-width: 26px; font-family: var(--mono); font-size: 17px; font-weight: 700; color: var(--accent); line-height: 1.1; }
.ax-smell-group__body { display: grid; gap: 2px; min-width: 0; font-size: 12.5px; color: var(--muted); }
.ax-smell-group__body strong { color: var(--ink); font-size: 13px; }
.ax-smell { margin: var(--s2) 0; }
.ax-smell__head { font-weight: 600; font-size: 13px; color: var(--ink); }
.ax-smell__fix { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
.ax-smell__fix code { font-family: var(--mono); font-size: 0.92em; color: var(--accent); }

@media (max-width: 680px) {
  .ax-main { padding: var(--s5); }
  .ax-scorecard { grid-template-columns: 1fr; }
  .ax-smell-groups { grid-template-columns: 1fr; }
}
`;
