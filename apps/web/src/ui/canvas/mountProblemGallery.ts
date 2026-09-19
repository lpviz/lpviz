import type { AppContext } from "@/app/appContext";
import { GALLERY_PROBLEMS, randomConvexPolygonPreview, requestRandomConvexPolygonProblem, type GalleryProblem } from "@/features/problem-gallery/problems";
import { el } from "@/ui/dom";

const IDLE = 3000,
  ITEM_W = 84,
  GAP = 8,
  CHROME = 16,
  // the open strip's height, also handed to the viewport as the top inset
  // zoom-to-fit must keep the region clear of (the CSS reads it as a variable)
  EXPANDED_H = 96,
  // breathing room between the strip's bottom edge and the fitted region
  INSET_GAP = 8;
// how often the random item's thumbnail changes shape while the strip is open
const RESHUFFLE_MS = 1000;
type Shape = Pick<GalleryProblem, "vertices" | "objectiveVector">;
function pointsAttribute(problem: Pick<GalleryProblem, "vertices">) {
  const minX = Math.min(...problem.vertices.map((v) => v.x));
  const maxX = Math.max(...problem.vertices.map((v) => v.x));
  const minY = Math.min(...problem.vertices.map((v) => v.y));
  const maxY = Math.max(...problem.vertices.map((v) => v.y));
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  return problem.vertices.map((v) => `${(8 + ((v.x - minX) / width) * 44).toFixed(1)},${(36 - ((v.y - minY) / height) * 28).toFixed(1)}`).join(" ");
}
const shapeMarkup = (shape: Shape) => `<polygon points="${pointsAttribute(shape)}"/><line x1="30" y1="22" x2="${30 + shape.objectiveVector.x}" y2="${22 - shape.objectiveVector.y}"/>`;

// The random item's thumbnail keeps reshuffling — a fresh region every
// RESHUFFLE_MS, crossfaded between two shape layers since SVG point lists
// cannot be transitioned but opacity can — so it is the one thing in the
// strip that moves, which is what marks it as "roll a new one". It only runs
// while the strip is open and the tab visible (nothing to see otherwise), and
// not at all under prefers-reduced-motion.
function createReshuffle(button: HTMLButtonElement) {
  const layers = button.querySelectorAll<SVGGElement>(".problem-gallery__shape");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let front = 0;
  let timer: number | null = null;
  const reshuffle = () => {
    const back = 1 - front;
    layers[back]!.innerHTML = shapeMarkup(randomConvexPolygonPreview());
    layers[back]!.classList.remove("is-faded");
    layers[front]!.classList.add("is-faded");
    front = back;
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const setRunning = (running: boolean) => {
    stop();
    if (running && !reducedMotion.matches && document.visibilityState === "visible") {
      timer = window.setInterval(reshuffle, RESHUFFLE_MS);
    }
  };
  return { setRunning, stop };
}
export function mountProblemGallery(parent: HTMLElement, ctx: AppContext) {
  let expanded = false;
  const root = el("div", {
    className: "problem-gallery",
    attrs: { "aria-label": "Problem gallery" },
  });
  parent.append(root);
  const toggle = el("button", {
    className: "problem-gallery__toggle",
    attrs: {
      type: "button",
      title: "Problem gallery",
      "aria-expanded": "false",
    },
  });
  toggle.innerHTML = '<svg class="problem-gallery__chevron" viewBox="0 0 12 8" aria-hidden="true"><polyline points="1 1 6 6 11 1" /></svg>';
  const items = el("div", {
    className: "problem-gallery__items",
    attrs: { "aria-hidden": "true" },
  });
  root.append(toggle, items);
  const reshuffles: Array<ReturnType<typeof createReshuffle>> = [];
  for (const p of GALLERY_PROBLEMS) {
    const b = el("button", {
      className: "problem-gallery__item",
      attrs: { type: "button", title: p.name },
    });
    b.innerHTML = p.isRandom
      ? `<svg class="problem-gallery__thumb" viewBox="0 0 60 44" aria-hidden="true"><g class="problem-gallery__shape">${shapeMarkup(p)}</g><g class="problem-gallery__shape is-faded"></g></svg><span>${p.name}</span>`
      : `<svg class="problem-gallery__thumb" viewBox="0 0 60 44" aria-hidden="true">${shapeMarkup(p)}</svg><span>${p.name}</span>`;
    if (p.isRandom) reshuffles.push(createReshuffle(b));
    b.addEventListener("click", () => {
      if (p.isRandom) {
        const generated = requestRandomConvexPolygonProblem();
        if (generated) ctx.actions.loadGalleryProblem(generated);
        return;
      }
      ctx.actions.loadGalleryProblem(p);
    });
    items.append(b);
  }
  const render = () => {
    const sw = ctx.getViewportSidebarWidth();
    root.className = `problem-gallery ${expanded ? "is-expanded" : ""}`.trim();
    root.style.left = `calc(${sw}px + (100vw - ${sw}px) / 2)`;
    root.style.setProperty("--problem-gallery-expanded-width", `min(${GALLERY_PROBLEMS.length * ITEM_W + Math.max(0, GALLERY_PROBLEMS.length - 1) * GAP + CHROME}px, calc(100vw - ${sw}px - 120px))`);
    root.style.setProperty("--problem-gallery-expanded-height", `${EXPANDED_H}px`);
    ctx.services.viewport.setTopInset(expanded ? EXPANDED_H + INSET_GAP : 0);
    toggle.setAttribute("aria-expanded", String(expanded));
    items.setAttribute("aria-hidden", String(!expanded));
    for (const r of reshuffles) r.setRunning(expanded);
  };
  const onVisibility = () => {
    for (const r of reshuffles) r.setRunning(expanded);
  };
  document.addEventListener("visibilitychange", onVisibility);
  let timer: number | null = window.setTimeout(() => {
    timer = null;
    expanded = true;
    document.removeEventListener("click", firstClick);
    render();
  }, IDLE);
  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  function firstClick() {
    expanded = false;
    clearTimer();
    document.removeEventListener("click", firstClick);
    render();
  }
  document.addEventListener("click", firstClick);
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    clearTimer();
    document.removeEventListener("click", firstClick);
    expanded = !expanded;
    render();
  });
  render();
  return {
    update: render,
    destroy: () => {
      clearTimer();
      for (const r of reshuffles) r.stop();
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("click", firstClick);
      root.remove();
    },
  };
}
