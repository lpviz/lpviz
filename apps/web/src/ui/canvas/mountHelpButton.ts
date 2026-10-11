import { el, mounted } from "@/ui/dom";
import { usageTipsList } from "@/ui/usageTips";

export function mountHelpButton(stage: HTMLElement, viewport: HTMLElement) {
  const container = el("div", { id: "helpControl" });
  // Covers the viewport while the popover is open: the press that dismisses it must not also
  // reach the canvas, where it would place a vertex (on a phone the sheet covers most of the
  // canvas, so that press is the natural way to dismiss it). The sidebar and the toolbar sit
  // above the viewport and stay uncovered: a press there closes the popover and does what it
  // would have done.
  const backdrop = el("div", { id: "helpBackdrop", attrs: { hidden: "" } });
  const panel = el("div", {
    id: "helpPanel",
    attrs: { role: "dialog", "aria-label": "Usage tips" },
  });
  const docsLink = el("a", {
    className: "help-panel__docs-link",
    attrs: { href: "/docs/" },
    text: "Docs: how each solver works →",
  });
  panel.append(el("div", { className: "help-panel__title", text: "Usage Tips" }), usageTipsList(), docsLink);
  const button = el("button", {
    id: "helpButton",
    attrs: {
      type: "button",
      title: "Usage Tips",
      "aria-label": "Usage Tips",
      "aria-expanded": "false",
    },
    text: "?",
    on: {
      click: (e) => {
        e.stopPropagation();
        setOpen(!open);
      },
    },
  });

  let open = false;
  const setOpen = (next: boolean) => {
    open = next;
    container.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
    backdrop.hidden = !open;
  };
  backdrop.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    setOpen(false);
  });
  // a cancelled touch gets no synthetic click: that click is hit-tested afresh after the lift,
  // by which time the backdrop is gone and the canvas would take it as a tap
  backdrop.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });

  // a press outside the popover or Escape closes it
  const listeners = new AbortController();
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (open && !container.contains(e.target as Node)) setOpen(false);
    },
    { signal: listeners.signal },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (open && e.key === "Escape") {
        setOpen(false);
        button.focus();
      }
    },
    { signal: listeners.signal },
  );

  container.append(panel, button);
  viewport.append(backdrop);
  stage.append(container);

  return mounted(
    container,
    () => listeners.abort(),
    () => backdrop.remove(),
  );
}
