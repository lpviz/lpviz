import { COMPLETION_MODES } from "@/features/polytope-editor/editorState";
import { DEFAULT_SOLVER_SETTINGS, QUERY_POINTS, SOLVER_MODES } from "@/features/solver/solverState";
import { isDimension, vecFrom } from "@lpviz/math/vec";
import type { ShareSettings, SharedAppState } from "@/features/share/sharedState";
import type { Vec } from "@lpviz/math/types";

// A share link gets pasted into chat, email and papers, so the payload is restricted to the
// base64url alphabet (A-Z a-z 0-9 - _), which every auto-linker treats as part of the URL. The
// encoding is a small binary format: fixed field order (keys cost nothing), delta-coded varint
// coordinates, and settings left at their default omitted entirely.

// v2 added the extended-flags byte (and with it the solver start point); v3 a
// dimension byte after it, with that many coordinates per vertex, objective and
// start point. A two-variable problem is still written as v2, so its links are
// the same bytes they always were; v1 and v2 are still read, their headers
// being shorter and carrying two coordinates. Bumping rather than redefining a
// version matters even when it barely escaped — a stale link decoded against
// the wrong header layout would not fail, it would silently load a *different*
// problem, which is the exact failure this format was written to eliminate.
const PLANAR_VERSION = 2;
const VERSION = 3;
const MIN_VERSION = 1;
// 1e-4 of a world unit is far below one screen pixel at any usable zoom, and vertices are where the
// bytes go; the objective is printed to three decimals, so it gets enough precision that a
// round-tripped link renders identically rather than one ulp off.
const COORDINATE_SCALE = 1e4;
const OBJECTIVE_SCALE = 1e6;
const Z_SCALE_SCALE = 1e3;

// Extended flags (header byte 2), added in v2 because the first flags byte has
// no spare bit left. Only ever append.
const HAS_SOLVER_START = 0x01;

// ─── varints ────────────────────────────────────────────────────────────────
// Written with arithmetic rather than bit operations: quantized coordinates can
// exceed 2^31, where JavaScript's bitwise operators would silently truncate.

function writeVarint(out: number[], value: number): void {
  let remaining = Math.max(0, Math.round(value));
  while (remaining >= 0x80) {
    out.push((remaining % 0x80) + 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  out.push(remaining);
}

function writeZigZag(out: number[], value: number): void {
  writeVarint(out, value >= 0 ? value * 2 : -value * 2 - 1);
}

type Cursor = { at: number };

function readVarint(bytes: Uint8Array, cursor: Cursor): number {
  let result = 0;
  let shift = 1;
  for (let i = 0; i < 8; i++) {
    if (cursor.at >= bytes.length) throw new Error("truncated varint");
    const byte = bytes[cursor.at++]!;
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return result;
    shift *= 0x80;
  }
  throw new Error("varint too long");
}

function readZigZag(bytes: Uint8Array, cursor: Cursor): number {
  const value = readVarint(bytes, cursor);
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

const quantize = (value: number, scale: number) => Math.round(value * scale);
const dequantize = (value: number, scale: number) => value / scale;

// ─── base64url ──────────────────────────────────────────────────────────────

function toBase64Url(bytes: number[]): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── setting codecs ─────────────────────────────────────────────────────────

const readByte = (bytes: Uint8Array, cursor: Cursor): number => {
  if (cursor.at >= bytes.length) throw new Error("truncated setting");
  return bytes[cursor.at++]!;
};

type SettingCodec = { key: keyof ShareSettings; write: (out: number[], value: unknown) => void; read: (bytes: Uint8Array, cursor: Cursor) => boolean | number | string | undefined };

const bool = (key: SettingCodec["key"]): SettingCodec => ({ key, write: (out, value) => out.push(value ? 1 : 0), read: (bytes, cursor) => readByte(bytes, cursor) !== 0 });
const int = (key: SettingCodec["key"]): SettingCodec => ({ key, write: (out, value) => writeVarint(out, value as number), read: readVarint });
const scaled = (key: SettingCodec["key"], scale: number): SettingCodec => ({
  key,
  write: (out, value) => writeZigZag(out, quantize(value as number, scale)),
  read: (bytes, cursor) => dequantize(readZigZag(bytes, cursor), scale),
});
// an unknown value writes index 0; an unknown index reads as undefined (left unset)
const enumeration = (key: SettingCodec["key"], values: readonly string[]): SettingCodec => ({
  key,
  write: (out, value) => {
    const at = values.indexOf(value as string);
    out.push(at < 0 ? 0 : at);
  },
  read: (bytes, cursor) => values[readByte(bytes, cursor)],
});

// Index is the wire identity of a setting: only ever append to this list, and
// never reorder it, or old links decode into the wrong fields.
const SETTINGS: readonly SettingCodec[] = [
  scaled("alphaMax", 1e4),
  scaled("correctorThreshold", 1e4),
  int("maxitIPM"),
  bool("simplexDualMode"),
  scaled("pdhgEta", 1e4),
  scaled("pdhgTau", 1e4),
  int("maxitPDHG"),
  bool("pdhgIneqMode"),
  bool("pdhgHalpernMode"),
  bool("pdhgColorByBasis"),
  int("centralPathIter"),
  int("maxitEllipsoid"),
  bool("ellipsoidDeepCuts"),
  bool("ellipsoidRayShoot"),
  enumeration("ellipsoidQueryPoint", QUERY_POINTS),
  scaled("ellipsoidInitialScale", 1e4),
  scaled("objectiveAngleStep", 1e4),
  scaled("objectiveRotationSpeed", 1e4),
];

// ─── encode / decode ────────────────────────────────────────────────────────

export function encodeSharedState(state: SharedAppState): string {
  const dimension = state.dimension ?? 2;
  const version = dimension === 2 ? PLANAR_VERSION : VERSION;
  const bytes: number[] = [version];
  // the first `dimension` coordinates of a point, or null when any is missing or not finite
  const coordinates = (point: Vec | null | undefined): number[] | null => {
    if (point == null) return null;
    const values = Array.from({ length: dimension }, (_, j) => point[j] ?? NaN);
    return values.every(Number.isFinite) ? values : null;
  };

  const completion = Math.max(0, COMPLETION_MODES.indexOf(state.completionMode ?? "draft"));
  const solver = Math.max(0, SOLVER_MODES.indexOf(state.solverMode));
  const objective = coordinates(state.objective);
  const hasZScale = state.zScale !== undefined && Number.isFinite(state.zScale);
  // null is the meaningful value here: it says "wherever this solver starts by
  // default", so an untouched marker costs no bytes and stays correct even if
  // that default later moves. Only a point the user actually dragged is pinned.
  const start = coordinates(state.solverStartPoint);
  bytes.push(completion | (solver << 2) | (state.is3DMode ? 0x20 : 0) | (objective ? 0x40 : 0) | (hasZScale ? 0x80 : 0));
  bytes.push(start ? HAS_SOLVER_START : 0);
  if (version >= 3) bytes.push(dimension);

  const vertices = state.vertices ?? [];
  writeVarint(bytes, vertices.length);
  const previous = new Array<number>(dimension).fill(0);
  for (const vertex of vertices) {
    for (let j = 0; j < dimension; j++) {
      const quantized = quantize(vertex[j] ?? 0, COORDINATE_SCALE);
      writeZigZag(bytes, quantized - previous[j]!);
      previous[j] = quantized;
    }
  }

  if (objective) for (const value of objective) writeZigZag(bytes, quantize(value, OBJECTIVE_SCALE));
  if (hasZScale) writeVarint(bytes, quantize(state.zScale!, Z_SCALE_SCALE));
  // a world coordinate the user placed by hand, so vertex precision applies
  if (start) for (const value of start) writeZigZag(bytes, quantize(value, COORDINATE_SCALE));

  const settings = state.settings ?? {};
  const written: number[] = [];
  const payload: number[] = [];
  SETTINGS.forEach((codec, index) => {
    const value = settings[codec.key];
    if (value === undefined) return;
    // a setting still at its default costs nothing to leave out
    if (value === DEFAULT_SOLVER_SETTINGS[codec.key]) {
      return;
    }
    written.push(index);
    codec.write(payload, value);
  });
  // keys first, then values, so a reader can validate the count cheaply
  writeVarint(bytes, written.length);
  for (const index of written) bytes.push(index);
  bytes.push(...payload);

  return toBase64Url(bytes);
}

export function decodeSharedState(text: string): SharedAppState | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const bytes = fromBase64Url(text);
    const version = bytes[0]!;
    // the header: version, flags, then (v2+) the extended flags and (v3+) the dimension
    const headerLength = version >= 3 ? 4 : version >= 2 ? 3 : 2;
    if (bytes.length < headerLength || version < MIN_VERSION || version > VERSION) {
      return null;
    }
    const extended = version >= 2 ? bytes[2]! : 0;
    const dimension = version >= 3 ? bytes[3] : 2;
    if (!isDimension(dimension)) return null;
    const cursor: Cursor = { at: headerLength };

    const flags = bytes[1]!;
    const completionMode = COMPLETION_MODES[flags & 0x03];
    const solverMode = SOLVER_MODES[(flags >> 2) & 0x07];
    if (!completionMode || !solverMode) return null;

    const readPoint = (scale: number): Vec => vecFrom(Array.from({ length: dimension }, () => dequantize(readZigZag(bytes, cursor), scale)));

    const vertexCount = readVarint(bytes, cursor);
    if (vertexCount > 100_000) return null;
    const vertices: Vec[] = [];
    const running = new Array<number>(dimension).fill(0);
    for (let i = 0; i < vertexCount; i++) {
      for (let j = 0; j < dimension; j++) running[j] = running[j]! + readZigZag(bytes, cursor);
      vertices.push(vecFrom(running.map((value) => dequantize(value, COORDINATE_SCALE))));
    }

    const objective: Vec | null = (flags & 0x40) !== 0 ? readPoint(OBJECTIVE_SCALE) : null;
    const zScale = (flags & 0x80) !== 0 ? dequantize(readVarint(bytes, cursor), Z_SCALE_SCALE) : undefined;
    const solverStartPoint: Vec | null = (extended & HAS_SOLVER_START) !== 0 ? readPoint(COORDINATE_SCALE) : null;

    const settingCount = readVarint(bytes, cursor);
    if (settingCount > SETTINGS.length) return null;
    const keys: number[] = [];
    for (let i = 0; i < settingCount; i++) {
      if (cursor.at >= bytes.length) return null;
      keys.push(bytes[cursor.at++]!);
    }
    const settings: ShareSettings = {};
    for (const index of keys) {
      const codec = SETTINGS[index];
      // an unknown index means a link from a newer build; the rest of the
      // payload can no longer be located, so stop rather than mis-read it
      if (!codec) break;
      const value = codec.read(bytes, cursor);
      if (value !== undefined) (settings as Record<string, unknown>)[codec.key] = value;
    }

    return {
      dimension,
      vertices,
      completionMode,
      objective,
      solverMode,
      settings,
      solverStartPoint,
      ...(zScale !== undefined ? { zScale } : {}),
      ...((flags & 0x20) !== 0 ? { is3DMode: true } : {}),
    };
  } catch {
    return null;
  }
}
