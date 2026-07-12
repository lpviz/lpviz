import { getState } from "@/features/core/store";
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
  panel.append(
    el("div", { className: "help-panel__title", text: "Usage Tips" }),
    usageTipsList(getState().problemMode),
    docsLink,
  );
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

  const onDocPointerDown = (e: PointerEvent) => {
    if (open && !container.contains(e.target as Node)) setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (open && e.key === "Escape") {
      setOpen(false);
      button.focus();
    }
  };
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onKeyDown);

  container.append(panel, button);
  parent.append(container);

  return {
    destroy: () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      container.remove();
    },
  };
}
