import { readFileSync } from "node:fs";
import { defineConfig, type Connect, type Plugin } from "vite";
import { DOCS_PAGES } from "./apps/web/docs/pages";
import { renderDocsPage } from "./apps/web/docs/render";

const { version } = JSON.parse(readFileSync(new URL("./apps/web/package.json", import.meta.url), "utf8")) as { version: string };

// The sitemap, from the same table as the pages: the app, then the overview and the articles.
const SITE = "https://lpviz.net";
const DOCS_LASTMOD = "2026-08-17";
const sitemapEntry = (loc: string, priority: string, lastmod?: string) =>
  `  <url>\n    <loc>${loc}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ""}    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>\n`;
const sitemap = () =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  sitemapEntry(`${SITE}/`, "1.0") +
  DOCS_PAGES.map((page) => (page.slug === "index" ? sitemapEntry(`${SITE}/docs/`, "0.9", DOCS_LASTMOD) : sitemapEntry(`${SITE}/docs/${page.slug}`, "0.8", DOCS_LASTMOD))).join("") +
  `</urlset>\n`;

// The documentation pages are rendered from apps/web/docs into docs/<slug>.html
// at build time. In production, Cloudflare's asset server maps clean URLs onto
// them (html_handling: auto-trailing-slash): /docs and /docs/ serve
// docs/index.html, /docs/simplex serves docs/simplex.html. Vite's dev and
// preview servers render the same pages, and the sitemap, on request under the same URLs.
function docsPages(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? "";
    const queryIndex = url.search(/[?#]/);
    const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
    if (pathname === "/sitemap.xml") {
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.end(sitemap());
      return;
    }
    const slug = pathname === "/docs" || pathname === "/docs/" ? "index" : pathname.match(/^\/docs\/([\w-]+)\/?$/)?.[1];
    const page = DOCS_PAGES.find((p) => p.slug === slug);
    if (!page) return next();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderDocsPage(page));
  };

  return {
    name: "docs-pages",
    generateBundle() {
      for (const page of DOCS_PAGES) this.emitFile({ type: "asset", fileName: `docs/${page.slug}.html`, source: renderDocsPage(page) });
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemap() });
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// The solver worker's chunk is only requested once the bundle has run, a round trip the first
// solve of a cold shared link then waits for; a prefetch in the head lets it download alongside
// the bundle at idle priority, and the worker's own request finds it in the cache.
function prefetchWorker(): Plugin {
  return {
    name: "prefetch-worker",
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        const worker = Object.keys(bundle ?? {}).find((file) => /^assets\/solverWorker-[\w-]+\.js$/.test(file));
        return worker ? [{ tag: "link", attrs: { rel: "prefetch", href: `/${worker}`, as: "script" }, injectTo: "head" }] : [];
      },
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [docsPages(), prefetchWorker()],
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      input: "index.html",
    },
    chunkSizeWarningLimit: 1000,
    emptyOutDir: true,
  },
});
