import type { SolverSettings } from "@/features/core/store";
import { el, range } from "@/ui/dom";

const MAXIT_LOG_MIN = 0,
  MAXIT_LOG_MAX = 5,
  MAXIT_LOG_STEP = 0.01;
const maxitToSliderValue = (value: number) => Math.min(MAXIT_LOG_MAX, Math.max(MAXIT_LOG_MIN, Math.log10(Math.max(1, value))));
const sliderValueToMaxit = (value: string) => Math.max(1, Math.round(10 ** parseFloat(value)));
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const fmt = (value: number) => NUMBER_FORMAT.format(value);
export const fixed = (digits: number) => (value: number) => value.toFixed(digits);

export type SettingKeys<T> = { [K in keyof SolverSettings]: SolverSettings[K] extends T ? K : never }[keyof SolverSettings];
type MaxitSettingKey = Extract<keyof SolverSettings, "maxitIPM" | "maxitPDHG" | "maxitEllipsoid">;
type SettingField = HTMLInputElement | HTMLSelectElement;
type SliderSpec = { key: SettingKeys<number>; min: string; max: string; step: string; label: string; format?: (v: number) => string; parse?: (v: string) => number; br?: boolean };
// writes one setting, then re-solves if the section's solver is the active one
type SettingUpdater = <K extends keyof SolverSettings>(key: K) => (v: SolverSettings[K]) => void;
// what a solver section is built from: the settings to show and the updater its controls write through
export type SectionContext = { st: SolverSettings; set: SettingUpdater };

export function checkbox(id: string, onChange: (v: boolean) => void) {
  const i = el("input", { attrs: { type: "checkbox", id } });
  i.addEventListener("change", () => onChange(i.checked));
  return i;
}
export function select<T extends string>(id: string, options: readonly (readonly [T, string])[], onChange: (v: T) => void) {
  const s = el(
    "select",
    { attrs: { id, autocomplete: "off" } },
    options.map(([value, label]) => el("option", { attrs: { value }, text: label })),
  );
  s.addEventListener("change", () => onChange(s.value as T));
  return s;
}

export function setInputValue(input: SettingField, value: string) {
  if (document.activeElement !== input) input.value = value;
}

// A slider (id `<key>Slider`) with a live readout: <label>text " " <span></label>,
// the input, and a <br> unless `br` is false.
export function numberSlider({ st, set }: SectionContext, { key, min, max, step, label, format = fixed(3), parse = parseFloat, br = true }: SliderSpec) {
  const id = key + "Slider";
  const span = el("span", { text: format(st[key]) });
  const update = set(key);
  const input = range(id, min, max, step, (v) => {
    const next = parse(v);
    span.textContent = format(next);
    update(next);
  });
  input.value = String(st[key]);
  const text = el("label", { attrs: { for: id } });
  text.append(label, " ", span);
  const nodes: Node[] = [text, input];
  if (br) nodes.push(el("br"));
  return {
    nodes,
    sync: (next: SolverSettings) => {
      span.textContent = format(next[key]);
      setInputValue(input, String(next[key]));
    },
  };
}

// one <label>text " "<input type=checkbox></label> per entry, in order
export function checkboxRow({ st, set }: SectionContext, labels: Partial<Record<SettingKeys<boolean>, string>>) {
  const row = el("div", { className: "settings-checkbox-row" });
  const boxes = (Object.entries(labels) as [SettingKeys<boolean>, string][]).map(([key, label]) => {
    const cb = checkbox(key, set(key));
    cb.checked = st[key];
    const wrap = el("label", { attrs: { for: key }, text: label + " " }, [cb]);
    row.append(wrap);
    return [key, cb, wrap] as const;
  });
  return { row, boxes };
}

export function renderMaxit({ st, set }: SectionContext, id: string, key: MaxitSettingKey) {
  const span = el("span", { text: fmt(st[key]) });
  const update = set(key);
  const input = range(id, String(MAXIT_LOG_MIN), String(MAXIT_LOG_MAX), String(MAXIT_LOG_STEP), (v) => {
    const maxit = sliderValueToMaxit(v);
    span.textContent = fmt(maxit);
    update(maxit);
  });
  input.classList.add("log-slider");
  input.value = String(maxitToSliderValue(st[key]));
  const wrap = el("div", { className: "log-slider-control" });
  const label = el("label", { attrs: { for: id }, text: "Maximum iterations:" });
  label.append(" ", span);
  const scale = ["1", "10", "100", "1k", "10k", "100k"].map((text) => el("span", { text }));
  wrap.append(label, input, el("div", { className: "log-slider-scale", attrs: { "aria-hidden": "true" } }, scale));
  return {
    element: wrap,
    sync: (next: SolverSettings) => {
      span.textContent = fmt(next[key]);
      setInputValue(input, String(maxitToSliderValue(next[key])));
    },
  };
}
