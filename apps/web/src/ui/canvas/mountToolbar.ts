import type { AppActions } from "@/app/appActions";
import { button, el } from "@/ui/dom";
import { renderOn } from "@/ui/renderOn";

const ICONS = {
  home: '<svg width="25" height="25" viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>',
  fit: '<svg width="25" height="25" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><mask id="hole-mask"><rect width="100" height="100" fill="white" /><circle cx="40" cy="40" r="20" fill="black" /></mask></defs><circle cx="40" cy="40" r="32.5" mask="url(#hole-mask)" /><g transform="translate(55,55) rotate(45)"><rect x="0" y="-4" width="52.5" height="15" /></g></svg>',
  reset:
    '<svg width="25" height="25" viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" /></svg>',
  share:
    '<svg fill="currentColor" width="25" height="25" viewBox="0 0 24 24"><path d="M20,21H4a2,2,0,0,1-2-2V6A2,2,0,0,1,4,4H8A1,1,0,0,1,8,6H4V19H20V13a1,1,0,0,1,2,0v6A2,2,0,0,1,20,21Z"></path><path d="M21.62,6.22l-5-4a1,1,0,0,0-1.05-.12A1,1,0,0,0,15,3V4.19a9.79,9.79,0,0,0-7,7.65,1,1,0,0,0,.62,1.09A1,1,0,0,0,9,13a1,1,0,0,0,.83-.45C11,10.78,13.58,10.24,15,10.07V11a1,1,0,0,0,.57.9,1,1,0,0,0,1.05-.12l5-4a1,1,0,0,0,0-1.56Z"></path></svg>',
};

// The column of view buttons in the canvas's top-right corner (home, fit, reset, 2D/3D, share)
// and, in 3D, the z-scale slider under them.
export function mountToolbar(parent: HTMLElement, actions: Pick<AppActions, "resetView" | "zoomToFit" | "reset" | "toggle3D" | "share" | "setZScale">) {
  const icon = (title: string, svg: string, onClick: () => void, id?: string) => el("button", { id, attrs: { title }, html: svg, on: { click: onClick } });
  const toggle3d = button("", () => actions.toggle3D(), { id: "toggle3DButton", attrs: { title: "Toggle 3D Mode" } });
  const zScaleSlider = el("input", {
    attrs: { type: "range", id: "zScaleSlider", min: "0.01", max: "10", step: "0.01", orient: "vertical", title: "Adjust Z-axis scale" },
    on: {
      input() {
        actions.setZScale(parseFloat(this.value));
      },
    },
  });
  const zScaleValue = el("div", { id: "zScaleValue" });
  const zScaleControl = el("div", { id: "zScaleSliderContainer" }, [el("label", { attrs: { for: "zScaleSlider" }, text: "Scale" }), zScaleSlider, zScaleValue]);
  const root = el("div", { id: "zoomControls" }, [
    icon("Reset Zoom (Home)", ICONS.home, () => actions.resetView()),
    icon("Zoom", ICONS.fit, () => actions.zoomToFit()),
    icon("Reset (clear everything)", ICONS.reset, () => actions.reset(), "resetButton"),
    toggle3d,
    icon("Share this configuration", ICONS.share, () => actions.share(), "shareButton"),
    zScaleControl,
  ]);
  parent.append(root);
  const stop = renderOn(["is3DMode", "zScale"], ({ is3DMode, zScale }) => {
    toggle3d.classList.toggle("button-active", is3DMode);
    toggle3d.textContent = is3DMode ? "2D" : "3D";
    zScaleSlider.value = String(zScale);
    zScaleValue.textContent = zScale.toFixed(2);
    zScaleControl.hidden = !is3DMode;
  });
  return {
    destroy: () => {
      stop();
      root.remove();
    },
  };
}
