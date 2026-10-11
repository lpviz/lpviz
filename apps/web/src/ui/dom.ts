/** The wheel's delta along its dominant axis; zero when it did not move. */
export const dominantWheelDelta = (event: WheelEvent): number => (Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX);

/** Ends an event here: no default action, and no other listener sees it. */
export const swallow = (event: Event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
};

type ElOptions<K extends keyof HTMLElementTagNameMap> = {
  id?: string | undefined;
  className?: string;
  text?: string;
  /** parsed into the element after its attributes are set and before `children` are appended */
  html?: string;
  attrs?: Record<string, string>;
  /** listeners by event type; `this` is the element */
  on?: { [E in keyof HTMLElementEventMap]?: (this: HTMLElementTagNameMap[K], event: HTMLElementEventMap[E]) => void };
};

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, options: ElOptions<K> = {}, children: Node[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.id) node.id = options.id;
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [k, v] of Object.entries(options.attrs ?? {})) node.setAttribute(k, v);
  if (options.html !== undefined) node.innerHTML = options.html;
  for (const [type, listener] of Object.entries(options.on ?? {})) node.addEventListener(type, listener as EventListener);
  node.append(...children);
  return node;
}

export const button = (text: string, onClick: () => void, options: Pick<ElOptions<"button">, "id" | "className" | "attrs"> = {}) => el("button", { ...options, text, on: { click: onClick } });

// A horizontal range input (the stylesheet's `.range`); onInput receives the slider's string
// value on every input event.
export function range(id: string, min: string, max: string, step: string, onInput: (v: string) => void) {
  return el("input", {
    className: "range",
    attrs: { type: "range", id, min, max, step, autocomplete: "off" },
    on: {
      input() {
        onInput(this.value);
      },
    },
  });
}

export function checkbox(id: string, onChange: (v: boolean) => void) {
  return el("input", {
    attrs: { type: "checkbox", id },
    on: {
      change() {
        onChange(this.checked);
      },
    },
  });
}
