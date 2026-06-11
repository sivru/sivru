// Minimal Markdown → HTML for the system narrative (DESIGN-0018 Slice 2).
//
// The narrative is a repo doc (README / ARCHITECTURE.md / .sivru/explainer.md).
// Rendering it raw as pre-wrap text turns the landing page into a wall of `##`
// and code-fences. This handles the common subset — headings, fenced code
// (ASCII diagrams stay monospaced), lists, bold, inline code, links,
// paragraphs — and HTML-escapes everything first so it is injection-safe. Not a
// full CommonMark implementation; the explainer narrative does not need one.

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

/** Inline formatting on an already-trusted line: escape, then code/bold/links. */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
}

export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let fence: string[] | null = null;
  let para: string[] = [];
  let list: "ul" | "ol" | null = null;

  const flushPara = (): void => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (fence !== null) {
        out.push(`<pre>${esc(fence.join("\n"))}</pre>`);
        fence = null;
      } else {
        flushPara();
        flushList();
        fence = [];
      }
      continue;
    }
    if (fence !== null) {
      fence.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const lvl = Math.min(6, h[1]!.length + 2); // md # → h3 (page owns h1/h2)
      out.push(`<h${lvl}>${inline(h[2]!)}</h${lvl}>`);
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const want = ul ? "ul" : "ol";
      if (list !== want) {
        flushList();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${inline((ul ? ul[1] : ol![1])!)}</li>`);
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    para.push(line.trim());
  }
  if (fence !== null) out.push(`<pre>${esc(fence.join("\n"))}</pre>`);
  flushPara();
  flushList();
  return out.join("\n");
}
