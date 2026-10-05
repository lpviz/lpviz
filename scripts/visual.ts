// Visual + DOM regression harness. Builds the app, serves dist with vite
// preview, drives headless Chromium through a fixed set of scenarios (share
// links, panel toggles, a draw→solve→3D→orbit→2D→pan→zoom interaction) and
// records, per scenario: a screenshot, the sidebar's and stage's outerHTML,
// the computed style of every element, and any console error. The baseline is
// local (.visual/baseline, gitignored): write it on the reference commit, then
// run the compare on the branch.
//
// Determinism, pinned from the harness side so the app is untouched: Math.random
// is seeded in the page, the solver worker's clocks are pinned (footers print
// elapsed ms), CSS animations/transitions are disabled before capture, and
// prefers-reduced-motion stops the gallery's timer-driven reshuffle.
//
//   bun scripts/visual.ts --write             capture the baseline
//   bun scripts/visual.ts                     capture .visual/current and compare
//   bun scripts/visual.ts --only NAME         restrict to scenarios containing NAME
//   bun scripts/visual.ts --tolerance N       allow N differing pixels per screenshot
//   bun scripts/visual.ts --no-build          reuse dist/

import { chromium, type Page } from "playwright";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const { encodeSharedState } = await import("@/features/share/compactUrl");
const { GALLERY_PROBLEMS } = await import("@/features/problem-gallery/problems");
type SharedAppState = import("@/features/share/sharedState").SharedAppState;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const write = flag("--write");
const only = opt("--only");
// 1-2 pixels of GPU anti-aliasing noise show up run to run; a real change is hundreds.
const tolerance = Number(opt("--tolerance") ?? 4);
const PORT = Number(process.env.VISUAL_PORT ?? 3011);
const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, ".visual", write ? "baseline" : "current");
const BASE = join(ROOT, ".visual", "baseline");
mkdirSync(OUT, { recursive: true });

// ---------- scenarios ----------

const problem = (id: string) => {
  const p = GALLERY_PROBLEMS.find((g) => g.id === id);
  if (!p) throw new Error(`no gallery problem ${id}`);
  return p;
};
const share = (p: ReturnType<typeof problem>, mode: SharedAppState["solverMode"], extra: Partial<SharedAppState> = {}): string =>
  encodeSharedState({ vertices: p.vertices, completionMode: "closed", objective: p.objectiveVector, solverMode: mode, settings: {}, ...extra });

type Viewport = { width: number; height: number };
type Scenario = { name: string; s?: string; viewport?: Viewport; settle?: number; run?: (page: Page) => Promise<void> };
const DESKTOP: Viewport = { width: 1280, height: 800 };
const MOBILE: Viewport = { width: 390, height: 844 };
const MODES = ["ipm", "pdhg", "simplex", "ellipsoid", "central"] as const;
const P = [problem("pentagon"), problem("corridor"), problem("tight-corner"), problem("many-facets")];

const scenarios: Scenario[] = [{ name: "empty" }];
for (const p of P) for (const mode of MODES) scenarios.push({ name: `${mode}-${p.id}-2d`, s: share(p, mode) });
for (const mode of MODES) scenarios.push({ name: `${mode}-${P[0]!.id}-3d`, s: share(P[0]!, mode, { is3DMode: true }), settle: 3000 });
scenarios.push({ name: `ellipsoid-${P[3]!.id}-3d`, s: share(P[3]!, "ellipsoid", { is3DMode: true, zScale: 2 }), settle: 3000 });
scenarios.push({ name: "simplex-dual", s: share(P[1]!, "simplex", { settings: { simplexDualMode: true, simplexEnteringRule: "coeff", simplexLeavingRule: "last" } }) });
scenarios.push({ name: "pdhg-eq-halpern-basis", s: share(P[1]!, "pdhg", { settings: { pdhgIneqMode: false, pdhgHalpernMode: true, pdhgColorByBasis: true, maxitPDHG: 300 } }) });
scenarios.push({ name: "ellipsoid-chebyshev", s: share(P[1]!, "ellipsoid", { settings: { ellipsoidQueryPoint: "chebyshev", ellipsoidRayShoot: false, ellipsoidDeepCuts: false } }) });
scenarios.push({ name: "ellipsoid-volumetric-short", s: share(P[2]!, "ellipsoid", { settings: { ellipsoidQueryPoint: "volumetric", maxitEllipsoid: 6, ellipsoidInitialScale: 3 } }) });
scenarios.push({ name: "ipm-start", s: share(P[1]!, "ipm", { solverStartPoint: { x: P[1]!.interiorPoint.x + 1, y: P[1]!.interiorPoint.y - 1 }, settings: { alphaMax: 0.9 } }) });
scenarios.push({ name: "simplex-start-3d", s: share(P[0]!, "simplex", { solverStartPoint: P[0]!.vertices[1]!, is3DMode: true }), settle: 3000 });
scenarios.push({ name: "central-short", s: share(P[2]!, "central", { settings: { centralPathIter: 8 } }) });
scenarios.push({
  name: "nonconvex",
  s: encodeSharedState({
    vertices: [
      { x: -5, y: -5 },
      { x: 5, y: 5 },
      { x: 5, y: -5 },
      { x: -5, y: 5 },
    ],
    completionMode: "closed",
    objective: { x: 1, y: 1 },
    solverMode: "ipm",
    settings: {},
  }),
});
scenarios.push({
  name: "open-region",
  s: encodeSharedState({
    vertices: [
      { x: -6, y: 0 },
      { x: 0, y: -4 },
      { x: 6, y: 0 },
    ],
    completionMode: "open",
    objective: { x: 0, y: -1 },
    solverMode: "pdhg",
    settings: {},
  }),
});
scenarios.push({
  name: "draft-region",
  s: encodeSharedState({
    vertices: [
      { x: -6, y: 0 },
      { x: 0, y: -4 },
      { x: 6, y: 0 },
    ],
    completionMode: "draft",
    objective: null,
    solverMode: "ipm",
    settings: {},
  }),
});
scenarios.push({ name: "help-open", run: async (page) => page.click("#helpButton") });
scenarios.push({ name: "gallery-open", run: async (page) => page.click(".problem-gallery__toggle") });
scenarios.push({ name: "empty-mobile", viewport: MOBILE });
scenarios.push({ name: `ipm-${P[0]!.id}-mobile`, s: share(P[0]!, "ipm"), viewport: MOBILE });
scenarios.push({ name: `simplex-${P[1]!.id}-3d-mobile`, s: share(P[1]!, "simplex", { is3DMode: true }), viewport: MOBILE, settle: 3000 });
scenarios.push({
  name: "sidebar-narrow",
  s: share(P[0]!, "ipm"),
  run: async (page) => {
    const handle = await page.locator("#sidebarHandle").boundingBox();
    if (!handle) throw new Error("no sidebar handle");
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 120, y, { steps: 8 });
    await page.mouse.up();
  },
});
scenarios.push({
  name: "interaction",
  settle: 1500,
  run: async (page) => {
    const drag = async (x0: number, y0: number, x1: number, y1: number) => {
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move(x1, y1, { steps: 10 });
      await page.mouse.up();
    };
    // the sidebar occupies x < 450 at desktop width; everything below is on the canvas
    for (const [x, y] of [
      [650, 250],
      [950, 230],
      [1000, 480],
      [700, 520],
    ] as const) {
      await page.mouse.click(x, y);
      await page.waitForTimeout(120);
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    await page.mouse.click(820, 380);
    await page.waitForTimeout(200);
    await page.click("#ipmButton");
    await page.waitForTimeout(800);
    await page.click("#toggle3DButton");
    await page.waitForTimeout(2000);
    await drag(820, 380, 890, 340);
    await page.waitForTimeout(500);
    await page.click("#toggle3DButton");
    await page.waitForTimeout(2000);
    await drag(820, 380, 850, 420);
    await page.mouse.move(820, 380);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(800);
    await page.click("button:has-text('Simplex')");
    await page.waitForTimeout(800);
  },
});

// ---------- determinism pins ----------

const SEEDED_RANDOM = `(() => { let seed = 0x2f6e2b1; Math.random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();`;
const PINNED_CLOCKS = "performance.now = () => 0; Date.now = () => 0;\n";
const FROZEN_MOTION = "*, *::before, *::after { animation: none !important; transition: none !important; }";

const STYLE_SCRIPT = `(() => {
  const path = (el) => { const parts = []; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { let s = e.tagName.toLowerCase(); if (e.id) s += '#' + e.id; if (e.classList.length) s += '.' + [...e.classList].join('.'); const sib = e.parentElement ? [...e.parentElement.children].filter(c => c.tagName === e.tagName) : []; if (sib.length > 1) s += ':nth(' + sib.indexOf(e) + ')'; parts.unshift(s); } return parts.join('>'); };
  const out = [];
  for (const el of document.querySelectorAll('*')) { const cs = getComputedStyle(el); const props = []; for (let i = 0; i < cs.length; i++) { const p = cs[i]; props.push(p + ':' + cs.getPropertyValue(p)); } out.push(path(el) + '\\n  ' + props.join(';')); }
  return out.join('\\n');
})()`;

// ---------- capture ----------

async function capture(page: Page, sc: Scenario) {
  const errors: string[] = [];
  const onConsole = (m: { type: () => string; text: () => string }) => {
    if (m.type() === "error") errors.push(`error: ${m.text()}`);
  };
  const onPageError = (e: Error) => errors.push(`pageerror: ${e.message}`);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  await page.setViewportSize(sc.viewport ?? DESKTOP);
  await page.goto(`http://localhost:${PORT}/${sc.s ? `?s=${sc.s}` : ""}`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: FROZEN_MOTION });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  if (sc.run) await sc.run(page);
  await page.waitForTimeout(sc.settle ?? 1200);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const png = await page.screenshot({ fullPage: false });
  const html = await page.evaluate(() => (document.getElementById("sidebar")?.outerHTML ?? "") + "\n" + (document.querySelector("main")?.outerHTML ?? ""));
  const styles = (await page.evaluate(STYLE_SCRIPT)) as string;
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  writeFileSync(join(OUT, `${sc.name}.png`), png);
  writeFileSync(join(OUT, `${sc.name}.html`), html);
  writeFileSync(join(OUT, `${sc.name}.styles.gz`), gzipSync(styles));
  writeFileSync(join(OUT, `${sc.name}.console.txt`), errors.join("\n"));
  return errors;
}

// Pixel diff done inside the browser: no image decoder needed on the bun side.
// Returns the count and a PNG (data URL) with differing pixels in red.
async function pixelDiff(page: Page, a: Buffer, b: Buffer): Promise<{ differing: number; total: number; image: string } | "size"> {
  return page.evaluate(
    async ([ba, bb]) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = "data:image/png;base64," + src;
        });
      const [ia, ib] = await Promise.all([load(ba), load(bb)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return "size" as const;
      const canvasFor = (img: HTMLImageElement) => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        return { c, ctx, data: ctx.getImageData(0, 0, img.width, img.height) };
      };
      const A = canvasFor(ia);
      const B = canvasFor(ib);
      const da = A.data.data;
      const db = B.data.data;
      const out = A.ctx.createImageData(ia.width, ia.height);
      let differing = 0;
      for (let i = 0; i < da.length; i += 4) {
        const same = da[i] === db[i] && da[i + 1] === db[i + 1] && da[i + 2] === db[i + 2] && da[i + 3] === db[i + 3];
        if (same) {
          const g = 255 - ((255 - (da[i]! + da[i + 1]! + da[i + 2]!) / 3) >> 2);
          out.data[i] = out.data[i + 1] = out.data[i + 2] = g;
        } else {
          differing++;
          out.data[i] = 255;
          out.data[i + 1] = 0;
          out.data[i + 2] = 0;
        }
        out.data[i + 3] = 255;
      }
      A.ctx.putImageData(out, 0, 0);
      return { differing, total: da.length / 4, image: A.c.toDataURL("image/png") };
    },
    [a.toString("base64"), b.toString("base64")],
  );
}

const normalizeHtml = (html: string) => html.replace(/\b\d+ms\b/g, "#ms");

function firstStyleDiff(a: string, b: string): string {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      const pa = (la[i] ?? "").split(";");
      const pb = (lb[i] ?? "").split(";");
      const prop = pa.find((p, j) => p !== pb[j]) ?? "(line)";
      return `line ${i + 1}: ${(la[i - 1] ?? la[i] ?? "").trim().slice(0, 120)} :: ${prop.slice(0, 160)} vs ${(pb[pa.indexOf(prop)] ?? "").slice(0, 160)}`;
    }
  }
  return "";
}

// ---------- main ----------

if (!flag("--no-build")) {
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) {
    console.error(build.stderr.toString());
    process.exit(1);
  }
}
const server = Bun.spawn(["bunx", "vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
  } catch {}
  await Bun.sleep(100);
}

let failures = 0;
const report: string[] = [];
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  // reducedMotion stops the gallery's timer-driven random thumbnail reshuffle, whose
  // Math.random call count would otherwise depend on timing (no CSS reads the query).
  const context = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: "reduce" });
  await context.addInitScript(SEEDED_RANDOM);
  // The solver worker prints elapsed time into its footers; pin its clocks by
  // prepending to the worker chunk as it is served.
  await context.route("**/assets/solverWorker-*.js", async (route) => {
    const response = await route.fetch();
    route.fulfill({ response, body: PINNED_CLOCKS + (await response.text()), headers: { ...response.headers(), "content-type": "text/javascript" } });
  });
  const page = await context.newPage();
  page.on("dialog", (d) => d.dismiss());
  for (const sc of scenarios) {
    if (only && !sc.name.includes(only)) continue;
    const errors = await capture(page, sc);
    let line = `${sc.name.padEnd(36)}`;
    if (errors.length) {
      failures++;
      line += ` CONSOLE ${errors.length}: ${errors[0]!.slice(0, 140)}`;
    }
    if (!write) {
      const basePng = join(BASE, `${sc.name}.png`);
      if (!existsSync(basePng)) {
        line += " NO BASELINE";
        failures++;
      } else {
        const px = await pixelDiff(page, readFileSync(basePng), readFileSync(join(OUT, `${sc.name}.png`)));
        const htmlSame = normalizeHtml(readFileSync(join(BASE, `${sc.name}.html`), "utf8")) === normalizeHtml(readFileSync(join(OUT, `${sc.name}.html`), "utf8"));
        const stylesA = gunzipSync(readFileSync(join(BASE, `${sc.name}.styles.gz`))).toString();
        const stylesB = gunzipSync(readFileSync(join(OUT, `${sc.name}.styles.gz`))).toString();
        const pxBad = px === "size" || px.differing > tolerance;
        if (pxBad || !htmlSame || stylesA !== stylesB) failures++;
        if (px !== "size" && px.differing > 0) writeFileSync(join(OUT, `${sc.name}.diff.png`), Buffer.from(px.image.split(",")[1]!, "base64"));
        line += ` px=${px === "size" ? "SIZE" : `${px.differing}/${px.total}`}${pxBad ? " PIXELS" : ""}${htmlSame ? "" : " HTML"}${stylesA === stylesB ? "" : ` STYLES ${firstStyleDiff(stylesA, stylesB)}`}`;
      }
    }
    console.log(line);
    report.push(line);
  }
} finally {
  await browser.close();
  server.kill();
}
writeFileSync(join(ROOT, ".visual", write ? "baseline-report.txt" : "report.txt"), report.join("\n") + "\n");
console.log(write ? `baseline written to ${OUT} (${readdirSync(OUT).length} files)` : failures ? `visual: ${failures} scenario(s) differ` : "visual: all scenarios match");
process.exit(write ? 0 : failures ? 1 : 0);
