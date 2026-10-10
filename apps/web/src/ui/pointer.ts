// Whether the primary input is a finger: no hover and a coarse pointer. The sidebar follows the
// drawing and the help text speaks of taps when it is; a connected mouse flips it back.
export const COARSE_POINTER_QUERY = "(hover: none) and (pointer: coarse)";
export const hasCoarsePointer = (): boolean => window.matchMedia(COARSE_POINTER_QUERY).matches;
