// The media queries the scripts ask about (the stylesheet asks the same ones in its own words).

/** a finger: no hover, and a pointer too coarse for a tight hit radius */
export const COARSE_POINTER_QUERY = "(hover: none) and (pointer: coarse)";
export const hasCoarsePointer = (): boolean => window.matchMedia(COARSE_POINTER_QUERY).matches;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
export const prefersReducedMotion = (): boolean => window.matchMedia(REDUCED_MOTION_QUERY).matches;

/** a phone held upright: the sidebar moves below the canvas */
export const MOBILE_LAYOUT_QUERY = "(max-width: 700px) and (orientation: portrait)";
