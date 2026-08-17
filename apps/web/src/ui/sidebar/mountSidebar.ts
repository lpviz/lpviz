import type { AppContext } from "@/app/appContext";
import { getState, on } from "@/features/core/store";
import { el } from "@/ui/dom";
import { createSidebarLogExpansion } from "@/ui/sidebar/logExpansion";
import { mountAnimationControlsPanel } from "@/ui/sidebar/mountAnimationControlsPanel";
import { mountProblemPanel } from "@/ui/sidebar/mountProblemPanel";
import { mountSolverControlsPanel } from "@/ui/sidebar/mountSolverControlsPanel";
import { mountSolverLogPanel } from "@/ui/sidebar/mountSolverLogPanel";

const SVG_NS = "http://www.w3.org/2000/svg";

function githubIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("github-icon");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", "0 0 98 96");
  // decorative: the wrapping link carries the accessible name
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill-rule", "evenodd");
  path.setAttribute("clip-rule", "evenodd");
  path.setAttribute(
    "d",
    "M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z",
  );
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

export function mountSidebar(parent: HTMLElement, ctx: AppContext) {
  const header = el("header");
  const sidebar = el("div", { id: "sidebar" });
  sidebar.style.width = `${ctx.getSidebarWidth()}px`;
  const content = el("div", { id: "sidebarContent" });
  const title = el("div", { className: "header controlPanel" }, [
    el("h1", { text: "lpviz" }),
    el(
      "a",
      {
        className: "github-link",
        attrs: {
          href: "https://github.com/lpviz/lpviz",
          target: "_blank",
          rel: "noreferrer",
          "aria-label": "GitHub Repository for lpviz",
        },
      },
      [githubIcon()],
    ),
  ]);
  const ui = el("div", { id: "uiContainer" });
  content.append(title, ui);
  sidebar.append(content);
  header.append(sidebar);
  parent.append(header);
  const children = [
    mountProblemPanel(ui, ctx),
    mountSolverControlsPanel(ui, ctx),
    mountAnimationControlsPanel(ui, ctx),
  ];
  const label = el("label", {
    className: "is-hidden",
    attrs: { for: "replaySpeedSlider" },
    text: "Speed:",
  });
  const replay = el("input", {
    className: "is-hidden",
    attrs: {
      type: "range",
      id: "replaySpeedSlider",
      min: "1",
      max: "100",
      step: "1",
      autocomplete: "off",
    },
  }) as HTMLInputElement;
  replay.addEventListener("input", () =>
    ctx.actions.updateSolverSetting("replaySpeed", parseInt(replay.value, 10)),
  );
  ui.append(label, replay);
  children.push(mountSolverLogPanel(ui, ctx));
  const logPanel = ui.querySelector<HTMLElement>("#terminal-container");
  const logExpansion = logPanel
    ? createSidebarLogExpansion({ sidebar, content, logPanel })
    : null;
  const controller = new AbortController();
  on(
    ["solverSettings"],
    ({ solverSettings }) => {
      replay.value = String(solverSettings.replaySpeed);
    },
    controller.signal,
  );
  replay.value = String(getState().solverSettings.replaySpeed);
  return {
    updateWidth: (w: number) => {
      sidebar.style.width = `${w}px`;
    },
    destroy: () => {
      logExpansion?.destroy();
      controller.abort();
      for (const c of children) c.destroy();
      header.remove();
    },
  };
}
