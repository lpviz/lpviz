import type { AppContext } from "@/app/appContext";
import { getState } from "@/features/core/store";
import { GALLERY_PROBLEMS, type GalleryProblem } from "@/features/problem-gallery/problems";
import { el } from "@/ui/dom";

const IDLE = 3000,
  ITEM_W = 84,
  GAP = 8,
  CHROME = 16;
function pointsAttribute(problem: GalleryProblem) {
  const minX = Math.min(...problem.vertices.map((v) => v.x));
  const maxX = Math.max(...problem.vertices.map((v) => v.x));
  const minY = Math.min(...problem.vertices.map((v) => v.y));
  const maxY = Math.max(...problem.vertices.map((v) => v.y));
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  return problem.vertices.map((v) => `${(8 + ((v.x - minX) / width) * 44).toFixed(1)},${(36 - ((v.y - minY) / height) * 28).toFixed(1)}`).join(" ");
}
export function mountProblemGallery(parent: HTMLElement, ctx: AppContext) {
  // the presets are 2-variable problems; /3d has no gallery (yet)
  if (getState().problemMode === "3d") {
    return { update: () => {}, destroy: () => {} };
  }
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
  for (const p of GALLERY_PROBLEMS) {
    const b = el("button", {
      className: "problem-gallery__item",
      attrs: { type: "button", title: p.name },
    });
    b.innerHTML = `<svg class="problem-gallery__thumb" viewBox="0 0 60 44" aria-hidden="true"><polygon points="${pointsAttribute(p)}"/><line x1="30" y1="22" x2="${30 + p.objectiveVector.x}" y2="${22 - p.objectiveVector.y}"/></svg><span>${p.name}</span>`;
    b.addEventListener("click", () => ctx.actions.loadGalleryProblem(p));
    items.append(b);
  }
  const render = () => {
    const sw = ctx.getViewportSidebarWidth();
    root.className = `problem-gallery ${expanded ? "is-expanded" : ""}`.trim();
    root.style.left = `calc(${sw}px + (100vw - ${sw}px) / 2)`;
    root.style.setProperty("--problem-gallery-expanded-width", `min(${GALLERY_PROBLEMS.length * ITEM_W + Math.max(0, GALLERY_PROBLEMS.length - 1) * GAP + CHROME}px, calc(100vw - ${sw}px - 120px))`);
    toggle.setAttribute("aria-expanded", String(expanded));
    items.setAttribute("aria-hidden", String(!expanded));
  };
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
      document.removeEventListener("click", firstClick);
      root.remove();
    },
  };
}
