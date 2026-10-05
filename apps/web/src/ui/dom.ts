export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  // `html` is parsed into the element after its attributes are set and before
  // `children` are appended, the order every former `.innerHTML =` site used
  options: { className?: string; text?: string; html?: string; attrs?: Record<string, string>; id?: string | undefined } = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.id) node.id = options.id;
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [k, v] of Object.entries(options.attrs ?? {})) node.setAttribute(k, v);
  if (options.html !== undefined) node.innerHTML = options.html;
  node.append(...children);
  return node;
}

// A range input; onInput receives the slider's string value on every input event.
export function range(id: string, min: string, max: string, step: string, onInput: (v: string) => void) {
  const i = el("input", { attrs: { type: "range", id, min, max, step, autocomplete: "off" } });
  i.addEventListener("input", () => onInput(i.value));
  return i;
}
