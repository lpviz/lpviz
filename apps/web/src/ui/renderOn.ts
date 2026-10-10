import { getState, on, type State } from "@/features/core/store";

/** Renders now, and again whenever one of `keys` changes; returns the stop. */
export function renderOn(keys: readonly (keyof State)[], render: (state: State) => void): () => void {
  render(getState());
  const controller = new AbortController();
  on(keys, () => render(getState()), controller.signal);
  return () => controller.abort();
}
