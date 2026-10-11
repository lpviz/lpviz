import { getState, on, type State } from "@/features/core/store";

/** Renders now, and again whenever one of `keys` changes, for the app's lifetime. */
export function renderOn(keys: readonly (keyof State)[], render: (state: State) => void, signal: AbortSignal): void {
  render(getState());
  on(keys, () => render(getState()), signal);
}
