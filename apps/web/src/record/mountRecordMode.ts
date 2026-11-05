import type { AppActions } from "@/app/appActions";
import { setCurrentMouse } from "@/features/core/currentMouse";
import { onAbort } from "@/features/core/lifetime";
import { getState } from "@/features/core/store";
import type { EditorTools } from "@/features/polytope-editor/editorTools";
import type { ViewportApi } from "@/features/viewport/runtime";
import { createCursor } from "./cursor";
import { createDirector, type DirectorOptions } from "./director";
import { createParts, partsFromParams, type RecordPart } from "./parts";
import "./record.css";
import { RECORD_SCRIPTS, type RecordScript } from "./scripts";

// Record mode, a dev-only page for capturing presentation footage: `/?record=<script>` strips the
// interface down to the drawing, the formulation and the solver buttons, hides the real cursor,
// and plays a scripted demo with a drawn cursor once Space is pressed.
//
//   Space   start (or restart) the script
//   R       stop and reset to an empty canvas, ready for Space
//   Esc     stop where it is and hand the canvas back to the mouse
//
// Query options: `pace` (2 = half speed), `replay` (ms each path takes to draw on, default 2500),
// `captions` (show the script's captions), `autostart` (ms after load to start without Space),
// `zoom` (start each take this many times closer in, e.g. 1.5 to fill the frame with the drawing),
// `hide` (parts to leave out of the shot: sidebar, brand, formulation, solvers, label, cursor) and
// `focus=plot` (the plot alone, in the full window; the same as hide=sidebar).
// From the console: `lpvizRecord.run(async (d) => { ... })` runs an ad-hoc script with the same
// director, and `lpvizRecord.scripts` lists the named ones.

type Deps = { actions: AppActions; tools: EditorTools; viewportApi: ViewportApi; signal: AbortSignal };

declare global {
  interface Window {
    lpvizRecord?: { run: (script: RecordScript) => Promise<void>; play: (name: string) => Promise<void>; stop: () => void; reset: () => void; scripts: string[] };
  }
}

const BLOCKED_EVENTS = ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu", "touchstart"] as const;

export function maybeMountRecordMode(deps: Deps): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("record")) return;
  const name = params.get("record") || "full";
  const options: DirectorOptions = {
    pace: Number(params.get("pace")) || 1,
    replayMs: Number(params.get("replay")) || 2500,
    captions: params.has("captions"),
    zoom: Number(params.get("zoom")) || 1,
  };
  mountRecordMode(deps, name, options, partsFromParams(params), params.get("autostart"));
}

function mountRecordMode({ actions, tools, viewportApi, signal }: Deps, initialScript: string, options: DirectorOptions, initialHidden: RecordPart[], autostart: string | null) {
  const html = document.documentElement;
  html.classList.add("record-mode");
  onAbort(signal, () => html.classList.remove("record-mode"));

  const rootNode = document.getElementById("root") ?? document.body;
  const parts = createParts(rootNode, actions, signal);
  parts.set(initialHidden);

  const cursor = createCursor();
  const captionNode = Object.assign(document.createElement("div"), { className: "record-caption" });
  const hint = Object.assign(document.createElement("div"), { className: "record-hint" });
  // in the root, which carries the sidebar width the caption centers beside
  rootNode.append(captionNode, hint);
  const caption = (text: string | null) => {
    if (text) captionNode.textContent = text;
    captionNode.classList.toggle("record-caption--visible", Boolean(text));
  };
  onAbort(signal, () => {
    cursor.destroy();
    captionNode.remove();
    hint.remove();
  });

  // While a script runs the real mouse must not touch anything: its moves would fight the
  // scripted hover and its clicks would edit the drawing. Synthetic events (the director's button
  // clicks) are not trusted, so they pass.
  let running: AbortController | null = null;
  const block = (event: Event) => {
    if (!running || !event.isTrusted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of BLOCKED_EVENTS) window.addEventListener(type, block, { capture: true, passive: false, signal });

  const showHint = (text: string | null) => {
    hint.textContent = text ?? "";
    hint.hidden = !text;
  };

  // every take starts from the URL's parts (a script may have changed them) and the default view
  const resetCanvas = () => {
    parts.set(initialHidden);
    const replayDurationMs = options.replayMs;
    const confirm = window.confirm;
    window.confirm = () => true;
    try {
      actions.reset();
    } finally {
      window.confirm = confirm;
    }
    actions.updateSolverSetting("replayDurationMs", replayDurationMs);
    setCurrentMouse(null);
    caption(null);
  };

  const stop = () => {
    running?.abort(new DOMException("record stopped", "AbortError"));
    running = null;
    cursor.release();
    tools.handleDragEnd();
    html.classList.remove("record-mode--running");
  };

  const run = async (script: RecordScript) => {
    stop();
    resetCanvas();
    const controller = new AbortController();
    running = controller;
    html.classList.add("record-mode--running");
    showHint(null);
    const director = createDirector({ actions, tools, viewportApi, cursor, caption, parts, options, signal: controller.signal });
    // let the reset's view transition settle before anything moves
    await new Promise((r) => setTimeout(r, 350));
    if (options.zoom !== 1) {
      const [x0, y0] = director.at(0, 0);
      const [x1, y1] = director.at(1, 1);
      // the half-height of the window, so the frame keeps the window's shape whatever the sidebar
      const hy = Math.abs(y0 - y1) / 2 / options.zoom;
      const hx = (Math.abs(x1 - x0) / 2 / options.zoom) * 0.5;
      const fit = (h: number) => director.frame({ minX: -hx * (h / hy), maxX: hx * (h / hy), minY: -h, maxY: h }, { durationMs: 0, margin: 0 });
      await fit(hy);
      // the view's fit pads the box; one correction makes the zoom exact
      const shown = Math.abs(director.at(0, 0)[1] - director.at(1, 1)[1]) / 2;
      await fit((hy * hy) / shown);
    }
    try {
      await script(director);
    } catch (error) {
      if (!controller.signal.aborted) console.error("record script failed", error);
    } finally {
      if (running === controller) {
        running = null;
        html.classList.remove("record-mode--running");
      }
    }
  };

  const play = (name: string) => {
    const script = RECORD_SCRIPTS[name];
    if (!script) {
      showHint(`No record script "${name}". Try: ${Object.keys(RECORD_SCRIPTS).join(", ")}`);
      return Promise.resolve();
    }
    return run(script.run);
  };

  const ready = () => {
    stop();
    resetCanvas();
    cursor.hide();
    showHint(`Record: ${initialScript}  ·  Space to start`);
  };

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === " ") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void play(initialScript);
      } else if (event.key === "r" || event.key === "R") {
        event.stopImmediatePropagation();
        ready();
      } else if (event.key === "Escape") {
        stop();
        cursor.hide();
        showHint(null);
      }
    },
    { capture: true, signal },
  );

  window.lpvizRecord = {
    run: (script) => run(script),
    play,
    stop,
    reset: ready,
    scripts: Object.keys(RECORD_SCRIPTS),
  };
  onAbort(signal, () => {
    stop();
    delete window.lpvizRecord;
  });

  ready();
  const autostartMs = autostart === null ? NaN : Number(autostart) || 0;
  if (Number.isFinite(autostartMs)) window.setTimeout(() => void play(initialScript), autostartMs);
  // a stale objective preview or sketch cursor from before the mount
  if (getState().vertices.length === 0) setCurrentMouse(null);
}
