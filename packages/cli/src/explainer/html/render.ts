// Single-file HTML assembly for the explainer (DESIGN-0018 Slice 2).
//
// SSR: pre-render every section + diagram in TS, inline the model + search
// index as escaped JSON islands, and ship a ~50-line vanilla nav shim (no
// bundler, no library, works offline). The only browser-side logic is
// show-the-matching-section + a substring search filter. `renderHtml` runs
// self-verify and THROWS rather than return a file with a dead link.
//
//   <aside> sidebar: search box + System→Module→Package tree
//   <main>          : all <section data-route> views (one visible)
//   <script>        : model island · search island · nav shim

import { SivruExplainError } from "@sivru/search";

import type { ExplainerModel, ExplainerNode } from "../types.js";
import { escapeHtml as esc, jsonIsland } from "./escape.js";
import { routeOf, selfVerify } from "./routes.js";
import { buildSearchIndex } from "./search.js";
import { renderSections } from "./views.js";

export function renderHtml(model: ExplainerModel): string {
  const sections = renderSections(model);
  const verdict = selfVerify(sections.map((s) => s.html).join(""), model);
  if (!verdict.ok) {
    // Fail loud — never write a broken artifact (SIVRU-E2011).
    throw new SivruExplainError(
      "SIVRU-E2011",
      `explainer self-verify failed: ${verdict.brokenLinks.length} broken link(s) ` +
        `[${verdict.brokenLinks.slice(0, 5).join(", ")}], ` +
        `${verdict.missingViews.length} missing view(s)`,
    );
  }

  const title = `${model.root.name} — sivru explainer`;
  const html =
    `<!DOCTYPE html>\n<html lang="en"><head>` +
    `<meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<title>${esc(title)}</title>` +
    `<style>${THEME_CSS}</style>` +
    `</head><body>` +
    `<button id="menu-toggle" aria-label="Toggle navigation">☰</button>` +
    `<aside id="sidebar">` +
    `<div class="search-wrap"><input id="search" type="search" placeholder="Search  /" aria-label="Search" autocomplete="off" />` +
    `<div id="results" role="listbox" hidden></div></div>` +
    `<nav class="tree" aria-label="Structure">${renderTree(model.root)}</nav>` +
    `</aside>` +
    `<main id="main">${sections.map((s) => s.html).join("")}</main>` +
    `<script type="application/json" id="model-island">${jsonIsland(model)}</script>` +
    `<script type="application/json" id="search-index">${jsonIsland(buildSearchIndex(model))}</script>` +
    `<script>${CLIENT_JS}</script>` +
    `</body></html>\n`;
  return html;
}

// ── sidebar tree (System → Module → Package) ─────────────────────────────────

function renderTree(root: ExplainerNode): string {
  const pkgList = (mod: ExplainerNode): string =>
    mod.children.length
      ? `<ul>${mod.children
          .map(
            (p) =>
              `<li><a href="${routeOf(p.id)}" data-link>${esc(p.name)}</a></li>`,
          )
          .join("")}</ul>`
      : "";
  const modItems = root.children
    .map(
      (m) =>
        `<li><a href="${routeOf(m.id)}" data-link>${esc(m.name)}</a>${pkgList(m)}</li>`,
    )
    .join("");
  return (
    `<a class="tree-root" href="${routeOf(root.id)}" data-link>${esc(root.name)}</a>` +
    `<ul>${modItems}</ul>`
  );
}

// ── theme (observe-ui tokens as CSS variables) ───────────────────────────────

const THEME_CSS = `
:root{--bg:#0f1115;--panel:#161a21;--border:#262b35;--text:#d6d8dd;--mute:#7a8390;--accent:#d4a056;--warn:#fbbf24;--error:#f87171}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex}
code,pre,.num{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#sidebar{width:280px;min-width:280px;height:100vh;overflow:auto;background:var(--panel);border-right:1px solid var(--border);padding:14px;position:sticky;top:0}
.search-wrap{position:relative;margin-bottom:12px}
#search{width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px}
#results{position:absolute;left:0;right:0;top:38px;background:var(--panel);border:1px solid var(--border);border-radius:6px;max-height:50vh;overflow:auto;z-index:5}
#results a{display:flex;justify-content:space-between;gap:8px;padding:6px 10px;color:var(--text);border-bottom:1px solid var(--border)}
#results a:hover{background:var(--bg);text-decoration:none}
#results .lvl{color:var(--mute);font-size:11px}
.tree-root{display:block;font-weight:600;margin-bottom:6px}
.tree ul{list-style:none;margin:0;padding-left:14px}
.tree li{margin:2px 0}
.tree a{display:block;padding:2px 6px;border-radius:4px;color:var(--text);font-size:13px}
.tree a:hover{background:var(--bg);text-decoration:none}
.tree a.active{background:var(--bg);color:var(--accent);font-weight:600}
#main{flex:1;min-width:0;max-width:980px;margin:0 auto;padding:28px 36px}
.breadcrumb{color:var(--mute);font-size:12px;margin-bottom:14px}
.breadcrumb .sep{margin:0 6px}
.breadcrumb .current{color:var(--text)}
h1{font-size:22px;margin:0 0 10px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:26px 0 10px;border-bottom:1px solid var(--border);padding-bottom:6px}
.meta,.deps{color:var(--mute);font-size:13px;margin:4px 0}
.deps strong{color:var(--text)}
.overview{color:var(--mute);font-size:13px;margin:2px 0 4px}
.overview code{background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:0 4px;color:var(--accent);font-size:12px}
details.narrative{margin-top:26px;border-top:1px solid var(--border);padding-top:10px}
details.narrative>summary{cursor:pointer;color:var(--mute);font-size:13px;text-transform:uppercase;letter-spacing:.04em;list-style-position:inside}
details.narrative>summary:hover{color:var(--text)}
.md{margin-top:12px;max-width:760px}
.md h3,.md h4,.md h5,.md h6{margin:18px 0 8px;color:var(--text)}
.md h3{font-size:16px}.md h4{font-size:14px}
.md p{margin:8px 0}
.md ul,.md ol{padding-left:22px;margin:8px 0}
.md li{margin:3px 0}
.md pre{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:12px;overflow:auto;font-size:12px;line-height:1.4}
.md code{background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:0 4px;font-size:12px}
.md pre code{background:none;border:none;padding:0}
.diagram-wrap{overflow:auto;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px}
table.grid{width:100%;border-collapse:collapse;font-size:13px}
table.grid th{text-align:left;color:var(--mute);font-weight:500;border-bottom:1px solid var(--border);padding:6px 8px}
table.grid td{border-bottom:1px solid var(--border);padding:6px 8px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--mute)}
.badge{font-size:11px;color:var(--accent);border:1px solid var(--border);border-radius:4px;padding:1px 5px}
.facts{display:grid;grid-template-columns:120px 1fr;gap:4px 14px;margin:10px 0}
.facts dt{color:var(--mute)}
.facts dd{margin:0}
.facts code,.block code{background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:0 4px;font-size:12px}
.block{background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:6px;padding:12px 16px;margin:12px 0}
.block-head{font-weight:600;color:var(--accent);margin-bottom:8px}
.block dl{display:grid;grid-template-columns:130px 1fr;gap:4px 14px;margin:0}
.block dt{color:var(--mute)}
.block dd{margin:0}
.block ul{margin:0;padding-left:18px}
.empty{background:var(--panel);border:1px dashed var(--border);border-radius:6px;padding:12px 16px;margin:12px 0}
.empty-head{color:var(--warn);font-weight:600;margin-bottom:6px}
.stub{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;overflow:auto;font-size:12px;color:var(--mute)}
.diagram{max-width:100%;height:auto}
.diagram .map-box{fill:var(--bg);stroke:var(--border);stroke-width:1.5}
.diagram a:hover .map-box{stroke:var(--accent)}
.diagram .map-name{fill:var(--text);font-size:13px;font-weight:600;text-anchor:middle}
.diagram .map-sub{fill:var(--mute);font-size:11px;text-anchor:middle}
.diagram .edge{stroke:var(--mute);stroke-width:1.2}
.diagram .arrow-head{fill:var(--mute)}
.diagram .bar{fill:var(--accent)}
.diagram .bar-label{fill:var(--text);font-size:12px;text-anchor:end;dominant-baseline:middle}
.diagram .bar-value{fill:var(--mute);font-size:11px;dominant-baseline:middle}
.diagram .hub{fill:var(--accent)}
.diagram .collab{fill:var(--text)}
.diagram .hub-label,.diagram .collab-label{fill:var(--text);font-size:11px;text-anchor:middle}
#menu-toggle{display:none;position:fixed;top:10px;left:10px;z-index:20;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;width:38px;height:38px;font-size:18px;cursor:pointer}
@media(max-width:768px){
#sidebar{position:fixed;left:0;top:0;z-index:15;transform:translateX(-100%);transition:transform .2s}
body.nav-open #sidebar{transform:none}
#menu-toggle{display:block}
#main{padding:60px 16px 24px}
}
`.trim();

// ── client nav shim (vanilla, no bundler) ────────────────────────────────────

export const CLIENT_JS = `
(function(){
  var views=document.querySelectorAll('.view');
  var links=document.querySelectorAll('.tree a');
  var search=document.getElementById('search');
  var results=document.getElementById('results');
  var index=JSON.parse(document.getElementById('search-index').textContent);
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function show(hash){
    var t=(hash||'#/').replace(/^#\\//,'');
    t=t===''?'system':decodeURIComponent(t);
    var found=false;
    views.forEach(function(v){var m=v.getAttribute('data-route')===t;v.hidden=!m;if(m)found=true;});
    if(!found){views.forEach(function(v){v.hidden=v.getAttribute('data-route')!=='system';});}
    links.forEach(function(a){a.classList.toggle('active',a.getAttribute('href')===hash);});
    document.body.classList.remove('nav-open');
    window.scrollTo(0,0);
  }
  window.addEventListener('hashchange',function(){show(location.hash);});
  function filter(q){
    q=q.trim().toLowerCase();
    if(!q){results.innerHTML='';results.hidden=true;return;}
    var hits=index.filter(function(e){return e.name.toLowerCase().indexOf(q)>=0;}).slice(0,30);
    results.innerHTML=hits.map(function(e){return '<a href="'+e.route+'">'+esc(e.name)+' <span class="lvl">'+e.level+'</span></a>';}).join('');
    results.hidden=hits.length===0;
  }
  search.addEventListener('input',function(){filter(search.value);});
  results.addEventListener('click',function(){setTimeout(function(){search.value='';filter('');},0);});
  document.addEventListener('keydown',function(e){
    if(e.key==='/'&&document.activeElement!==search){e.preventDefault();search.focus();}
    if(e.key==='Escape'){search.value='';filter('');search.blur();}
  });
  var toggle=document.getElementById('menu-toggle');
  if(toggle)toggle.addEventListener('click',function(){document.body.classList.toggle('nav-open');});
  show(location.hash||'#/');
})();
`.trim();
