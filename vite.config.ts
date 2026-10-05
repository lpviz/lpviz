import { defineConfig, type Connect, type Plugin } from "vite";
import { DOCS_PAGES } from "./apps/web/docs/pages";
import { renderDocsPage } from "./apps/web/docs/render";

// The documentation pages are rendered from apps/web/docs into docs/<slug>.html
// at build time. In production, Cloudflare's asset server maps clean URLs onto
// them (html_handling: auto-trailing-slash): /docs and /docs/ serve
// docs/index.html, /docs/simplex serves docs/simplex.html. Vite's dev and
// preview servers render the same pages on request under the same URLs.
function docsPages(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? "";
    const queryIndex = url.search(/[?#]/);
    const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
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
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [docsPages()],
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
