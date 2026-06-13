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

import { basename } from "node:path";

import { SivruExplainError } from "@sivru/search";

import type { ArchDelta, NodeRef } from "../diff-types.js";
import { isEmptyDelta } from "../diff-format.js";
import type { ExplainerModel, ExplainerNode } from "../types.js";
import { escapeHtml as esc, jsonIsland } from "./escape.js";
import { routeOf, selfVerify } from "./routes.js";
import { buildSearchIndex } from "./search.js";
import { renderSystemMap } from "./svg.js";
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
    `<div class="feedback-bar">` +
    `<label class="fb-toggle"><input type="checkbox" id="fb-mode" /> Feedback mode</label>` +
    `<button id="fb-export" hidden>Export patch (<span id="fb-count">0</span>)</button>` +
    `</div>` +
    `</aside>` +
    `<main id="main">${sections.map((s) => s.html).join("")}</main>` +
    // The HTML is shareable, so the island carries the repo BASENAME, not the
    // author's absolute path. `feedback apply` defaults to the CWD anyway.
    `<script type="application/json" id="model-island">${jsonIsland({ ...model, repoPath: basename(model.repoPath) })}</script>` +
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
.feedback-bar{margin-top:14px;border-top:1px solid var(--border);padding-top:10px}
.fb-toggle{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--mute);cursor:pointer}
#fb-export{margin-top:8px;width:100%;background:var(--accent);color:var(--bg);border:none;border-radius:6px;padding:7px;font-size:13px;font-weight:600;cursor:pointer}
body.feedback-on [data-editable]{outline:1px dashed var(--accent);outline-offset:3px;border-radius:3px;cursor:text}
body.feedback-on [data-editable]:hover{background:rgba(212,160,86,.12)}
[data-editable].edited{background:rgba(212,160,86,.18)}
.fb-create,.fb-narrative,.fb-note{display:none;margin-top:10px;background:transparent;color:var(--accent);border:1px dashed var(--accent);border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer}
body.feedback-on .fb-create,body.feedback-on .fb-narrative,body.feedback-on .fb-note{display:inline-block}
.fb-create.edited,.fb-narrative.edited,.fb-note.edited{border-style:solid;background:rgba(212,160,86,.18)}
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
.attention{list-style:none;margin:8px 0;padding:0;counter-reset:hot}
.attention li{counter-increment:hot;display:flex;align-items:baseline;gap:10px;padding:5px 8px;border-bottom:1px solid var(--border)}
.attention li::before{content:counter(hot);color:var(--mute);font-size:11px;font-variant-numeric:tabular-nums;min-width:14px}
.attention .hot-meta{color:var(--mute);font-size:12px;margin-left:auto}
.attention .hot-score{color:var(--accent);font-variant-numeric:tabular-nums;font-size:12px;min-width:36px;text-align:right}
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
.diagram .edge{stroke:var(--mute);stroke-width:1.2;fill:none}
.diagram .arrow-head{fill:var(--mute)}
.diagram .map-box.added{stroke:#4ade80;stroke-width:2.5}
.diagram .map-box.changed{stroke:var(--warn);stroke-width:2;stroke-dasharray:5 3}
.diagram .edge.new-edge{stroke:#4ade80;stroke-width:2}
.diagram .edge.cycle-edge{stroke:var(--error);stroke-width:2.5;stroke-dasharray:2 3}
.delta-empty{color:#4ade80;font-size:15px;margin:18px 0}
.delta-base{color:var(--mute);font-size:13px;margin:2px 0 16px}
.delta-legend{display:flex;flex-wrap:wrap;gap:14px;margin:10px 0 18px;font-size:12px;color:var(--mute)}
.delta-legend span{display:inline-flex;align-items:center;gap:5px}
.delta-tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;padding:1px 6px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.delta-tag.cycle{color:var(--error);border:1px solid var(--error)}
.delta-tag.edge{color:#4ade80;border:1px solid #4ade80}
.delta-tag.block{color:var(--warn);border:1px solid var(--warn)}
.delta-tag.removed{color:var(--mute);border:1px solid var(--mute)}
.delta-row{display:flex;gap:10px;align-items:baseline;padding:7px 11px;margin:5px 0;background:var(--panel);border-left:3px solid var(--border)}
.delta-row.cycle{border-left-style:double;border-left-width:5px;border-left-color:var(--error)}
.delta-row.edge{border-left-style:solid;border-left-color:#4ade80}
.delta-row.block{border-left-style:dashed;border-left-color:var(--warn)}
.delta-row.removed{border-left-style:dotted;border-left-color:var(--mute)}
.delta-row code{font-size:12px;color:var(--text)}
.delta-note{color:var(--mute);font-size:12px;margin-top:18px;font-style:italic}
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
  // feedback mode (DESIGN-0018 Slice 3): inline-edit a block field → structured
  // annotation in localStorage → Export downloads a patch.json that
  // \`sivru feedback apply\` writes back to the @sivru block in source.
  var model=JSON.parse(document.getElementById('model-island').textContent);
  var FB_KEY='sivru-feedback:'+model.repoPath;
  function fbLoad(){try{return JSON.parse(localStorage.getItem(FB_KEY)||'{}');}catch(e){return {};}}
  function fbCount(){var s=fbLoad();var n=Object.keys(s).length;var c=document.getElementById('fb-count');if(c)c.textContent=n;var ex=document.getElementById('fb-export');if(ex)ex.hidden=n===0;}
  var fbMode=document.getElementById('fb-mode');
  if(fbMode)fbMode.addEventListener('change',function(){document.body.classList.toggle('feedback-on',fbMode.checked);});
  function fbStore(key,val){var s=fbLoad();s[key]=val;localStorage.setItem(FB_KEY,JSON.stringify(s));fbCount();}
  document.addEventListener('click',function(e){
    if(!document.body.classList.contains('feedback-on'))return;
    var t=e.target;
    // author a NEW block on an un-annotated symbol
    var cb=t.closest&&t.closest('.fb-create');
    if(cb){e.preventDefault();
      var role=window.prompt('role — a short kind (e.g. service, parser):',cb.getAttribute('data-symbol'));
      if(role===null||role==='')return;
      var resp=window.prompt('responsibility — one line: what it does and why:','');
      if(resp===null||resp==='')return;
      fbStore(cb.getAttribute('data-node-id')+'::create',{kind:'create',targetNodeId:cb.getAttribute('data-node-id'),sourcePath:cb.getAttribute('data-path'),blockSymbolName:cb.getAttribute('data-symbol'),declLine:parseInt(cb.getAttribute('data-decl'),10),role:role,responsibility:resp});
      cb.classList.add('edited');cb.textContent='@sivru block queued ✓';return;
    }
    // suggest a system narrative
    var nb=t.closest&&t.closest('.fb-narrative');
    if(nb){e.preventDefault();
      var nv=window.prompt('System narrative — what this system is and how it fits together:','');
      if(nv===null||nv==='')return;
      fbStore('narrative',{kind:'narrative',value:nv});
      nb.classList.add('edited');nb.textContent='narrative queued ✓';return;
    }
    // leave a freeform note (recorded, never auto-applied)
    var note=t.closest&&t.closest('.fb-note');
    if(note){e.preventDefault();
      var nt=window.prompt('Note (recorded for a human — not applied to source):','');
      if(nt===null||nt==='')return;
      fbStore(note.getAttribute('data-node-id')+'::note',{kind:'note',targetNodeId:note.getAttribute('data-node-id'),sourcePath:note.getAttribute('data-path'),note:nt});
      note.classList.add('edited');note.textContent='note queued ✓';return;
    }
    // edit an existing block field
    var dd=t.closest&&t.closest('[data-editable]');
    if(!dd)return;
    e.preventDefault();
    var blk=dd.closest('.block');if(!blk)return;
    var field=dd.getAttribute('data-edit-field');
    var isList=field==='collaborators';
    var cur=isList?Array.prototype.map.call(dd.querySelectorAll('li'),function(li){return li.textContent;}).join(', '):dd.textContent;
    var val=window.prompt('Edit '+field+' (comma-separated for a list):',cur);
    if(val===null||val===cur)return;
    fbStore(blk.getAttribute('data-node-id')+'::'+field,{kind:'edit',targetNodeId:blk.getAttribute('data-node-id'),sourcePath:blk.getAttribute('data-path'),blockSymbolName:blk.getAttribute('data-symbol'),blockContentHash:blk.getAttribute('data-hash'),edit:isList?{field:field,op:'set',value:val.split(',').map(function(s){return s.trim();}).filter(Boolean)}:{field:field,op:'set',value:val}});
    dd.classList.add('edited');
    if(isList){dd.innerHTML='<ul>'+val.split(',').map(function(s){return '<li>'+esc(s.trim())+'</li>';}).join('')+'</ul>';}else{dd.textContent=val;}
  });
  var fbExport=document.getElementById('fb-export');
  if(fbExport)fbExport.addEventListener('click',function(){
    var s=fbLoad();var all=Object.keys(s).map(function(k){return s[k];});
    var patch={schema:1,repoRoot:model.repoPath,head:model.head||'',
      edits:all.filter(function(x){return x.kind==='edit';}).map(function(x){return {targetNodeId:x.targetNodeId,sourcePath:x.sourcePath,blockSymbolName:x.blockSymbolName,blockContentHash:x.blockContentHash,edit:x.edit};}),
      creates:all.filter(function(x){return x.kind==='create';}).map(function(x){return {targetNodeId:x.targetNodeId,sourcePath:x.sourcePath,blockSymbolName:x.blockSymbolName,declLine:x.declLine,role:x.role,responsibility:x.responsibility};}),
      narrative:all.filter(function(x){return x.kind==='narrative';}).map(function(x){return {value:x.value};}),
      notes:all.filter(function(x){return x.kind==='note';}).map(function(x){return {targetNodeId:x.targetNodeId,sourcePath:x.sourcePath,note:x.note};})};
    var blob=new Blob([JSON.stringify(patch,null,2)],{type:'application/json'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='sivru-feedback-patch.json';a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);},1000);
  });
  fbCount();
  show(location.hash||'#/');
})();
`.trim();

// ── diff view (DESIGN-0023 Slice 2) ──────────────────────────────────────────
//
// `sivru explain --project --diff --html` → a standalone page: the HEAD
// architecture map with the delta overlaid (added/changed modules, new edges,
// the cycle's closing edge) plus a textual "What changed" digest. Every change
// is named in the digest with a text tag (NEW/CHG/DEL/⟳CYCLE), so color is never
// the only signal (WCAG 1.4.1); the map's color + stroke-style is enhancement.

const strip = (id: string): string => id.replace(/^(module|package|symbol):/, "").split("#")[0]!;
const edgeKey = (from: string, to: string): string => `${from} ${to}`;

/** Which HEAD modules a delta touches, and how (added vs otherwise changed). */
function affectedModules(head: ExplainerModel, delta: ArchDelta): Map<string, "added" | "changed"> {
  const modules = head.root.children;
  const out = new Map<string, "added" | "changed">();
  const addedIds = new Set(delta.nodes.added.map((r) => r.id));
  for (const m of modules) if (addedIds.has(m.id)) out.set(m.id, "added");
  const markByPath = (path: string): void => {
    for (const m of modules) {
      if (out.get(m.id) === "added") continue;
      if (path === m.path || (m.path !== "" && path.startsWith(`${m.path}/`))) out.set(m.id, "changed");
    }
  };
  const touchRefs = (refs: NodeRef[]): void => refs.forEach((r) => markByPath(r.path));
  touchRefs(delta.nodes.changed.map((c) => c.ref));
  touchRefs(delta.nodes.removed);
  touchRefs([...delta.blocks.added, ...delta.blocks.changed, ...delta.blocks.removed]);
  for (const e of delta.edges.added) {
    markByPath(strip(e.from));
    markByPath(strip(e.to));
  }
  return out;
}

export function renderDiffHtml(head: ExplainerModel, delta: ArchDelta): string {
  const modules = head.root.children;
  const symbolsOf = (m: ExplainerNode): number =>
    m.children.reduce((n, p) => n + p.children.length, 0);
  const affected = affectedModules(head, delta);
  const newEdges = new Set(delta.edges.added.map((e) => edgeKey(e.from, e.to)));
  const cycleEdges = new Set(
    delta.cycles.added.filter((c) => c.closedBy).map((c) => edgeKey(c.closedBy!.from, c.closedBy!.to)),
  );

  const edges = modules.flatMap((m) => m.derived.depEdges.map((to) => ({ from: m.id, to })));
  const map = modules.length
    ? renderSystemMap(
        modules.map((m) => ({
          id: m.id,
          name: m.name,
          sub: `${symbolsOf(m)} sym · churn ${m.derived.churn}`,
          size: symbolsOf(m),
        })),
        edges,
        (id) => routeOf(id),
        {
          box: (id) => affected.get(id) ?? null,
          edge: (from, to) =>
            cycleEdges.has(edgeKey(from, to)) ? "cycle-edge" : newEdges.has(edgeKey(from, to)) ? "new-edge" : null,
        },
      )
    : "";

  const empty = isEmptyDelta(delta);

  const row = (cls: string, tag: string, body: string): string =>
    `<div class="delta-row ${cls}"><span class="delta-tag ${cls}">${tag}</span><span>${body}</span></div>`;
  const code = (s: string): string => `<code>${esc(s)}</code>`;

  const digest: string[] = [];
  for (const c of delta.cycles.added) {
    const closing = c.closedBy ? ` — closed by ${code(`${c.closedBy.from} → ${c.closedBy.to}`)}` : "";
    digest.push(row("cycle", "⟳ CYCLE", `New dependency cycle: ${code(c.render)}${closing}`));
  }
  for (const e of delta.edges.added.slice(0, 20)) {
    digest.push(row("edge", "NEW", `New dependency ${code(`${e.from} → ${e.to}`)}`));
  }
  if (delta.edges.added.length > 20) {
    digest.push(row("edge", "NEW", `… +${delta.edges.added.length - 20} more new edge(s)`));
  }
  for (const r of delta.blocks.changed.slice(0, 20)) {
    digest.push(row("block", "CHG", `Authored block changed on ${code(r.name)}`));
  }
  for (const r of delta.blocks.added.slice(0, 20)) {
    digest.push(row("edge", "NEW", `Authored block added on ${code(r.name)}`));
  }
  for (const r of [...delta.nodes.removed, ...delta.blocks.removed].slice(0, 20)) {
    digest.push(row("removed", "DEL", `Removed ${code(r.name)}`));
  }

  const legend =
    `<div class="delta-legend">` +
    `<span><span class="delta-tag cycle">⟳ CYCLE</span> new cycle</span>` +
    `<span><span class="delta-tag edge">NEW</span> new edge / block</span>` +
    `<span><span class="delta-tag block">CHG</span> changed block</span>` +
    `<span><span class="delta-tag removed">DEL</span> removed</span>` +
    `</div>`;

  const body =
    `<h1>Architectural delta</h1>` +
    `<p class="delta-base">vs <code>${esc(delta.baseRef)}</code></p>` +
    (empty
      ? `<p class="delta-empty">✓ No architectural change — this PR is structurally inert.</p>`
      : legend +
        (map ? `<h2>Architecture (changes highlighted)</h2><div class="diagram-wrap">${map}</div>` : "") +
        `<h2>What changed</h2>${digest.join("")}` +
        `<p class="delta-note">Informational — sivru does not gate on this signal yet (DESIGN-0023).</p>`);

  const title = `Architectural delta vs ${delta.baseRef} — sivru`;
  return (
    `<!DOCTYPE html>\n<html lang="en"><head>` +
    `<meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<title>${esc(title)}</title>` +
    `<style>${THEME_CSS}</style>` +
    `</head><body>` +
    `<main id="main" style="margin-left:0;max-width:900px">${body}</main>` +
    `</body></html>\n`
  );
}
