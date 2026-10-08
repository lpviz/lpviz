import type { PointXYZ } from "@lpviz/math/types";

export const DEFAULT_VIEW_ANGLE: PointXYZ = { x: -1.15, y: 0.4, z: 0 };
export const DEFAULT_Z_SCALE = 0.1;
/** pixels per world unit at scale factor 1 */
export const DEFAULT_GRID_SPACING = 20;
/** pixels kept clear around content fitted to the viewport */
export const DEFAULT_FIT_PADDING = 50;
/** the 2D zoom range, as multiples of the grid spacing */
export const MIN_SCALE_FACTOR = 0.05;
export const MAX_SCALE_FACTOR = 400;
/** the perspective camera never comes closer than this to its target */
export const MIN_PERSPECTIVE_DISTANCE = 10;
