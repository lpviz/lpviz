import type { AppActions } from "@/app/appActions";
import { GALLERY_PROBLEMS, randomConvexPolygonPreview, requestRandomConvexPolygonProblem, type GalleryProblem } from "@/features/problem-gallery/problems";
import { el } from "@/ui/dom";
import { prefersReducedMotion } from "@/ui/media";
import { boundsOf } from "@lpviz/math/vec";

// the strip opens by itself after this long, unless the person clicks first
const IDLE = 3000;
// breathing room between the open strip's bottom edge and the region zoom-to-fit keeps clear of it
const INSET_GAP = 8;
// how often the random item's thumbnail changes shape while the strip is open
const RESHUFFLE_MS = 1000;
type Shape = Pick<GalleryProblem, "vertices" | "objectiveVector">;
function pointsAttribute(problem: Pick<GalleryProblem, "vertices">) {
  const { min, max } = boundsOf(problem.vertices);
  const width = Math.max(max[0]! - min[0]!, 1);
  const height = Math.max(max[1]! - min[1]!, 1);
  return problem.vertices.map((v) => `${(8 + ((v[0] - min[0]!) / width) * 44).toFixed(1)},${(36 - ((v[1] - min[1]!) / height) * 28).toFixed(1)}`).join(" ");
}
const shapeMarkup = (shape: Shape) => `<polygon points="${pointsAttribute(shape)}"/><line x1="30" y1="22" x2="${30 + shape.objectiveVector[0]}" y2="${22 - shape.objectiveVector[1]}"/>`;

// The random item's thumbnail keeps reshuffling — a fresh region every
// RESHUFFLE_MS, crossfaded between two shape layers since SVG point lists
// cannot be transitioned but opacity can — so it is the one thing in the
// strip that moves, which is what marks it as "roll a new one". It only runs
// while the strip is open and the tab visible (nothing to see otherwise), and
// not at all under prefers-reduced-motion.
function createReshuffle(button: HTMLButtonElement) {
  const layers = button.querySelectorAll<SVGGElement>(".problem-gallery__shape");
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
    if (running && !prefersReducedMotion() && document.visibilityState === "visible") {
      timer = window.setInterval(reshuffle, RESHUFFLE_MS);
    }
  };
  return { setRunning, stop };
}
export function mountProblemGallery(parent: HTMLElement, actions: Pick<AppActions, "loadGalleryProblem" | "setTopInset">) {
  let expanded = false;
  const root = el("div", {
    className: "problem-gallery",
    attrs: { "aria-label": "Problem gallery" },
  });
  // the stylesheet lays the strip out; the item count is the one number it cannot know
  root.style.setProperty("--gallery-items", String(GALLERY_PROBLEMS.length));
  parent.append(root);
  const toggle = el("button", {
    className: "problem-gallery__toggle",
    attrs: {
      type: "button",
      title: "Problem gallery",
      "aria-expanded": "false",
    },
    html: '<svg class="problem-gallery__chevron" viewBox="0 0 12 8" aria-hidden="true"><polyline points="1 1 6 6 11 1" /></svg>',
    on: {
      click: (e) => {
        e.stopPropagation();
        disarmAutoOpen();
        expanded = !expanded;
        render();
      },
    },
  });
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
      html: p.isRandom
        ? `<svg class="problem-gallery__thumb" viewBox="0 0 60 44" aria-hidden="true"><g class="problem-gallery__shape">${shapeMarkup(p)}</g><g class="problem-gallery__shape is-faded"></g></svg><span>${p.name}</span>`
        : `<svg class="problem-gallery__thumb" viewBox="0 0 60 44" aria-hidden="true">${shapeMarkup(p)}</svg><span>${p.name}</span>`,
      on: {
        click: () => {
          // the random item rolls a fresh problem each time
          const problem = p.isRandom ? requestRandomConvexPolygonProblem() : p;
          if (problem) actions.loadGalleryProblem(problem);
        },
      },
    });
    if (p.isRandom) reshuffles.push(createReshuffle(b));
    items.append(b);
  }
  // the open strip's height is the stylesheet's (it differs by layout); zoom-to-fit keeps clear of it
  const expandedHeight = () => parseFloat(getComputedStyle(root).getPropertyValue("--gallery-expanded-height")) || 0;
  const render = () => {
    root.classList.toggle("is-expanded", expanded);
    actions.setTopInset(expanded ? expandedHeight() + INSET_GAP : 0);
    toggle.setAttribute("aria-expanded", String(expanded));
    items.setAttribute("aria-hidden", String(!expanded));
    for (const r of reshuffles) r.setRunning(expanded);
  };
  const onVisibility = () => {
    for (const r of reshuffles) r.setRunning(expanded);
  };
  document.addEventListener("visibilitychange", onVisibility);
  // the auto-open: a timer that opens the strip, cancelled by the first click anywhere
  let autoOpen: number | null = window.setTimeout(() => {
    autoOpen = null;
    disarmAutoOpen();
    expanded = true;
    render();
  }, IDLE);
  function firstClick() {
    disarmAutoOpen();
    expanded = false;
    render();
  }
  function disarmAutoOpen() {
    if (autoOpen !== null) clearTimeout(autoOpen);
    autoOpen = null;
    document.removeEventListener("click", firstClick);
  }
  document.addEventListener("click", firstClick);
  render();
  return {
    destroy: () => {
      disarmAutoOpen();
      for (const r of reshuffles) r.stop();
      document.removeEventListener("visibilitychange", onVisibility);
      root.remove();
    },
  };
}
