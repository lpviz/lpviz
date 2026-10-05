// Renders a documentation page: the shared head, nav, pager, footer and JSON-LD
// around the page's body fragment. The output is plain, JavaScript-free HTML;
// vite.config.ts writes it to dist/docs/<slug>.html at build time and serves it
// on request in dev and preview.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_PAGES, type DocsPage } from "./pages";

const ORIGIN = "https://lpviz.net";
// The table is non-empty by construction (the overview is its first entry).
const overview = DOCS_PAGES[0]!;
const articles = DOCS_PAGES.slice(1);
const APP_DESCRIPTION = "Interactive web app for visualizing linear programming solvers: Simplex, interior point methods, PDHG, the ellipsoid method, and the central path.";

const pagePath = (page: DocsPage): string => (page === overview ? "/docs/" : `/docs/${page.slug}`);
const pageUrl = (page: DocsPage): string => ORIGIN + pagePath(page);
const text = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const json = JSON.stringify;

function jsonLd(page: DocsPage): string {
  if (page === overview) {
    const parts = articles.map((a) => `              { "@type": "TechArticle", "name": ${json(a.schema.name)}, "url": ${json(pageUrl(a))} }`);
    return `          {
            "@type": "WebApplication",
            "@id": "${ORIGIN}/#app",
            "name": "lpviz",
            "url": "${ORIGIN}/",
            "description": ${json(APP_DESCRIPTION)},
            "applicationCategory": "EducationalApplication",
            "operatingSystem": "Any (web browser)"
          },
          {
            "@type": "CollectionPage",
            "@id": ${json(pageUrl(page))},
            "name": ${json(page.schema.name)},
            "description": ${json(page.schema.description)},
            "isPartOf": { "@id": "${ORIGIN}/#app" },
            "hasPart": [
${parts.join(",\n")}
            ]
          }`;
  }
  return `          {
            "@type": "TechArticle",
            "headline": ${json(page.og.title)},
            "description": ${json(page.schema.description)},
            "url": ${json(pageUrl(page))},
            "isPartOf": { "@type": "CollectionPage", "@id": ${json(pageUrl(overview))} }
          },
          {
            "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "lpviz", "item": "${ORIGIN}/" },
              { "@type": "ListItem", "position": 2, "name": ${json(overview.nav)}, "item": ${json(pageUrl(overview))} },
              { "@type": "ListItem", "position": 3, "name": ${json(page.nav)}, "item": ${json(pageUrl(page))} }
            ]
          }`;
}

// The last article's "next" leads back to the overview.
function pager(page: DocsPage): string {
  const i = DOCS_PAGES.indexOf(page);
  const prev = DOCS_PAGES[i - 1];
  const next = DOCS_PAGES[i + 1] ?? overview;
  const nextDir = page === overview ? "Start with →" : next === overview ? "Back to" : "Next →";
  const links: string[] = [];
  if (prev) links.push(`          <a href="${pagePath(prev)}"><span class="dir">${prev === overview ? "← Back to" : "← Previous"}</span>${text(prev.pager)}</a>`);
  links.push(`          <a class="next" href="${pagePath(next)}"><span class="dir">${nextDir}</span>${text(next.pager)}</a>`);
  return links.join("\n");
}

export function renderDocsPage(page: DocsPage): string {
  const body = readFileSync(join(import.meta.dirname, `${page.slug}.html`), "utf8");
  const nav = DOCS_PAGES.map((p) => `        <a href="${pagePath(p)}"${p === page ? ' class="is-active" aria-current="page"' : ""}>${text(p.nav)}</a>`);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${text(page.title)}</title>
    <meta
      name="description"
      content="${text(page.description)}"
    />
    <link rel="canonical" href="${pageUrl(page)}" />
    <link rel="stylesheet" href="/docs/docs.css" />
    <meta property="og:type" content="${page === overview ? "website" : "article"}" />
    <meta property="og:site_name" content="lpviz" />
    <meta property="og:title" content="${text(page.og.title)}" />
    <meta property="og:description" content="${text(page.og.description)}" />
    <meta property="og:url" content="${pageUrl(page)}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${text(page.twitter.title)}" />
    <meta name="twitter:description" content="${text(page.twitter.description)}" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
${jsonLd(page)}
        ]
      }
    </script>
  </head>
  <body>
    <header class="site-header">
      <nav aria-label="Documentation">
        <a class="brand" href="/">lpviz</a>
${nav.join("\n")}
      </nav>
    </header>
    <main>
      <article>
${body}
        <nav class="pager" aria-label="Continue reading">
${pager(page)}
        </nav>
      </article>
    </main>
    <footer class="site-footer">
      <div>
        <a href="${ORIGIN}/">lpviz.net</a> · <a href="https://github.com/lpviz/lpviz">GitHub</a> · <a href="https://arxiv.org/abs/2604.27518">Paper (arXiv:2604.27518)</a> · Free &amp; open source, MIT licensed. All solvers run in your browser.
      </div>
    </footer>
  </body>
</html>
`;
}
