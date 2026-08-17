import { formatReplayDuration } from "@/features/solver/replayDuration";
import { el } from "@/ui/dom";

// How long the readout stays up after the last +/- press. Long enough to read
// while holding a key down, short enough that it never reads as persistent UI.
const VISIBLE_MS = 900;

// A centred, non-interactive readout of the current replay duration, flashed by
// the +/- shortcuts. The duration has no visible control of its own (the speed
// slider is hidden), so without this the keys would change the setting with no
// feedback at all.
export function mountReplayDurationOverlay(parent: HTMLElement) {
  const root = el("div", {
    className: "replay-duration",
    attrs: { role: "status", "aria-live": "polite" },
  });
  const value = el("span", { className: "replay-duration__value" });
  root.append(
    // labelled, because "1.0s" alone would not say whether + means faster
    el("span", { className: "replay-duration__label", text: "Animation" }),
    value,
  );
  parent.append(root);

  // One timer, restarted on every press, is what makes the readout fade out
  // shortly after the *last* press rather than shortly after the first
  let hideTimer: number | null = null;

  return {
    show: (durationMs: number) => {
      value.textContent = formatReplayDuration(durationMs);
      root.classList.add("is-visible");
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        hideTimer = null;
        root.classList.remove("is-visible");
      }, VISIBLE_MS);
    },
    destroy: () => {
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      root.remove();
    },
  };
}
