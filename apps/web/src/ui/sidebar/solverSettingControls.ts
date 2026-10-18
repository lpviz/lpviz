import { type NumberSettingKey, type SelectSettingKey, settingRange, settingValues, type SolverSettings } from "@/features/solver/solverSettings";
import { checkbox, el, labelFor, range } from "@/ui/dom";

const MAXIT_LOG_MIN = 0;
const MAXIT_LOG_MAX = 5;
const MAXIT_LOG_STEP = 0.01;
const maxitToSliderValue = (value: number) => Math.min(MAXIT_LOG_MAX, Math.max(MAXIT_LOG_MIN, Math.log10(Math.max(1, value))));
const sliderValueToMaxit = (value: string) => Math.max(1, Math.round(10 ** parseFloat(value)));
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const fmt = (value: number) => NUMBER_FORMAT.format(value);
export const fixed = (digits: number) => (value: number) => value.toFixed(digits);

type SettingKeys<T> = { [K in keyof SolverSettings]: SolverSettings[K] extends T ? K : never }[keyof SolverSettings];
type MaxitSettingKey = Extract<keyof SolverSettings, `maxit${string}`>;
type SliderSpec = {
  key: NumberSettingKey;
  /** the input's id, `<key>Slider` unless given */
  id?: string;
  label: string;
  /** the slider's own range, when it is not the setting's (a log scale) */
  range?: readonly [min: string, max: string, step: string];
  /** the readout of a value, and the slider's position for it */
  format?: (v: number) => string;
  toInput?: (v: number) => string;
  parse?: (v: string) => number;
  br?: boolean;
};
// writes one setting, then re-solves if the section's solver is the active one
type SettingUpdater = <K extends keyof SolverSettings>(key: K) => (v: SolverSettings[K]) => void;
// what a solver section is built from: the updater its controls write through; their values come by `sync`
export type SectionContext = { set: SettingUpdater };

/** One control of a solver section: the nodes it adds and how it follows the settings. */
export type SettingControl = { nodes: Node[]; sync: (settings: SolverSettings) => void };

/** Follow a setting without fighting the person typing in the field. */
function setInputValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  if (document.activeElement !== input) input.value = value;
}

/** The controls laid out together in one `<div class="{className}">`. */
export function group(className: string, controls: SettingControl[]): SettingControl {
  return {
    nodes: [
      el(
        "div",
        { className },
        controls.flatMap((control) => control.nodes),
      ),
    ],
    sync: (next) => {
      for (const control of controls) control.sync(next);
    },
  };
}

// A slider (id `<key>Slider`) over the setting's range, with a live readout: <label>text " "
// <span></label>, the input, and a <br> unless `br` is false.
export function numberSlider(
  { set }: SectionContext,
  { key, id = key + "Slider", label, range: bounds = settingRange(key), format = fixed(3), toInput = String, parse = parseFloat, br = true }: SliderSpec,
): SettingControl {
  const span = el("span");
  const update = set(key);
  const input = range(id, ...bounds, (v) => {
    const next = parse(v);
    span.textContent = format(next);
    update(next);
  });
  const text = labelFor(id);
  text.append(label, " ", span);
  const nodes: Node[] = [text, input];
  if (br) nodes.push(el("br"));
  return {
    nodes,
    sync: (next) => {
      span.textContent = format(next[key]);
      setInputValue(input, toInput(next[key]));
    },
  };
}

// one <label>text " "<input type=checkbox></label> per entry, in order; `applies` greys out the
// boxes that the current settings make moot
export function checkboxRow(
  { set }: SectionContext,
  labels: Partial<Record<SettingKeys<boolean>, string>>,
  applies?: (settings: SolverSettings, key: SettingKeys<boolean>) => boolean,
): SettingControl {
  const row = el("div", { className: "settings-checkbox-row" });
  const boxes = (Object.entries(labels) as [SettingKeys<boolean>, string][]).map(([key, label]) => {
    const box = checkbox(key, set(key));
    const wrap = labelFor(key, label + " ", [box]);
    row.append(wrap);
    return { key, box, wrap };
  });
  return {
    nodes: [row],
    sync: (next) => {
      for (const { key, box, wrap } of boxes) {
        box.checked = next[key];
        if (!applies) continue;
        const enabled = applies(next, key);
        box.disabled = !enabled;
        wrap.classList.toggle("is-disabled", !enabled);
      }
    },
  };
}

// A <label> and the <select> (id `key`) it names, for the caller to lay out: one option per value
// of the setting's vocabulary, in its order, under the label given here.
export function labeledSelect<K extends SelectSettingKey>({ set }: SectionContext, key: K, label: string, labels: Record<SolverSettings[K], string>): SettingControl {
  const input = el(
    "select",
    {
      attrs: { id: key, autocomplete: "off" },
      on: {
        change() {
          set(key)(this.value as SolverSettings[K]);
        },
      },
    },
    settingValues(key).map((value) => el("option", { attrs: { value }, text: labels[value] })),
  );
  return { nodes: [labelFor(key, label), input], sync: (next) => setInputValue(input, next[key]) };
}

// A log-scale slider for an iteration cap: a number slider positioned by the cap's decade, in a
// wrapper with the decades marked under it.
export function maxitSlider(ctx: SectionContext, id: string, key: MaxitSettingKey): SettingControl {
  const { nodes, sync } = numberSlider(ctx, {
    key,
    id,
    label: "Maximum iterations:",
    range: [String(MAXIT_LOG_MIN), String(MAXIT_LOG_MAX), String(MAXIT_LOG_STEP)],
    format: fmt,
    toInput: (v) => String(maxitToSliderValue(v)),
    parse: sliderValueToMaxit,
    br: false,
  });
  const input = nodes[1] as HTMLInputElement;
  input.classList.add("log-slider");
  const scale = ["1", "10", "100", "1k", "10k", "100k"].map((text) => el("span", { text }));
  return { nodes: [el("div", { className: "log-slider-control" }, [...nodes, el("div", { className: "log-slider-scale", attrs: { "aria-hidden": "true" } }, scale)])], sync };
}

/** The control, shown only while the settings make it apply (a method's own knobs). */
export function shownWhen(control: SettingControl, applies: (settings: SolverSettings) => boolean): SettingControl {
  return {
    nodes: control.nodes,
    sync: (next) => {
      const shown = applies(next);
      for (const node of control.nodes) if (node instanceof HTMLElement) node.hidden = !shown;
      control.sync(next);
    },
  };
}
