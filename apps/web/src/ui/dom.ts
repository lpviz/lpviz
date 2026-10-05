export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    attrs?: Record<string, string>;
    id?: string;
  } = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.id) node.id = options.id;
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [k, v] of Object.entries(options.attrs ?? {})) node.setAttribute(k, v);
  node.append(...children);
  return node;
}
export function clear(node: Element): void {
  node.replaceChildren();
}
