import { el } from "@/ui/dom";
import { usageTipsList } from "@/ui/usageTips";

export function mountHelpButton(parent: HTMLElement) {
  const container = el("div", { id: "helpControl" });
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
  });

  let open = false;
  const setOpen = (next: boolean) => {
    open = next;
    container.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
  };

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!open);
  });

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
  parent.append(container);

  return {
    destroy: () => {
      listeners.abort();
      container.remove();
    },
  };
}
