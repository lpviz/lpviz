import { DEFAULT_SOLVER_SETTINGS, type SolverSettings } from "@/features/core/store";
import type { ShareSettings, SharedAppState } from "@/features/share/sharedState";

// A share link is a URL people paste into chat, email and papers, so the
// payload is restricted to the base64url alphabet — A-Z a-z 0-9 - _ — which
// every auto-linker treats as part of the URL. The previous JSONCrush payload
// was dense but full of quotes, parentheses, tildes and percent-escapes, and
// tended to end in punctuation like `*_`; linkifiers routinely swallowed the
// tail or stopped early, producing links that silently loaded a different
// problem.
//
// The encoding is a small binary format rather than JSON: field order is fixed
// so keys cost nothing, coordinates are delta-coded varints (polygon vertices
// sit close together, so each one costs a byte or two), and settings left at
// their default are omitted entirely. That runs shorter than the compressed
// JSON it replaces while staying paste-safe.

const VERSION = 1;
// 1e-4 of a world unit is far below one screen pixel at any usable zoom, and
// vertices are where the bytes go. The objective is only two numbers and is
// printed to three decimals in the problem panel, so it gets enough precision
// that a round-tripped link renders identically rather than one ulp off.
const COORDINATE_SCALE = 1e4;
const OBJECTIVE_SCALE = 1e6;
const Z_SCALE_SCALE = 1e3;

const SOLVER_MODES = [
  "central",
  "ipm",
  "simplex",
  "pdhg",
  "ellipsoid",
] as const;
const COMPLETION_MODES = ["draft", "closed", "open"] as const;
const QUERY_POINTS = [
  "ellipsoid",
  "chebyshev",
  "analytic",
  "volumetric",
] as const;

type SettingKey = keyof ShareSettings;

type SettingCodec =
  | { key: SettingKey; kind: "bool" }
  | { key: SettingKey; kind: "int" }
  | { key: SettingKey; kind: "scaled"; scale: number }
  | { key: SettingKey; kind: "enum"; values: readonly string[] };

// Index is the wire identity of a setting: only ever append to this list, and
// never reorder it, or old links decode into the wrong fields.
const SETTINGS: readonly SettingCodec[] = [
  { key: "alphaMax", kind: "scaled", scale: 1e4 },
  { key: "correctorThreshold", kind: "scaled", scale: 1e4 },
  { key: "maxitIPM", kind: "int" },
  { key: "simplexDualMode", kind: "bool" },
  { key: "pdhgEta", kind: "scaled", scale: 1e4 },
  { key: "pdhgTau", kind: "scaled", scale: 1e4 },
  { key: "maxitPDHG", kind: "int" },
  { key: "pdhgIneqMode", kind: "bool" },
  { key: "pdhgHalpernMode", kind: "bool" },
  { key: "pdhgColorByBasis", kind: "bool" },
  { key: "centralPathIter", kind: "int" },
  { key: "maxitEllipsoid", kind: "int" },
  { key: "ellipsoidDeepCuts", kind: "bool" },
  { key: "ellipsoidParallelCuts", kind: "bool" },
  { key: "ellipsoidRayShoot", kind: "bool" },
  { key: "ellipsoidQueryPoint", kind: "enum", values: QUERY_POINTS },
  { key: "ellipsoidInitialScale", kind: "scaled", scale: 1e4 },
  { key: "objectiveAngleStep", kind: "scaled", scale: 1e4 },
  { key: "objectiveRotationSpeed", kind: "scaled", scale: 1e4 },
];

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
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── encode / decode ────────────────────────────────────────────────────────

export function encodeSharedState(state: SharedAppState): string {
  const bytes: number[] = [VERSION];

  const completion = Math.max(
    0,
    COMPLETION_MODES.indexOf(
      (state.completionMode ?? "draft") as (typeof COMPLETION_MODES)[number],
    ),
  );
  const solver = Math.max(
    0,
    SOLVER_MODES.indexOf(state.solverMode as (typeof SOLVER_MODES)[number]),
  );
  const hasObjective = state.objective !== null && state.objective !== undefined;
  const hasZScale =
    state.zScale !== undefined && Number.isFinite(state.zScale);
  bytes.push(
    completion |
      (solver << 2) |
      (state.is3DMode ? 0x20 : 0) |
      (hasObjective ? 0x40 : 0) |
      (hasZScale ? 0x80 : 0),
  );

  const vertices = state.vertices ?? [];
  writeVarint(bytes, vertices.length);
  let previousX = 0;
  let previousY = 0;
  for (const vertex of vertices) {
    const x = quantize(vertex.x, COORDINATE_SCALE);
    const y = quantize(vertex.y, COORDINATE_SCALE);
    writeZigZag(bytes, x - previousX);
    writeZigZag(bytes, y - previousY);
    previousX = x;
    previousY = y;
  }

  if (hasObjective) {
    writeZigZag(bytes, quantize(state.objective!.x, OBJECTIVE_SCALE));
    writeZigZag(bytes, quantize(state.objective!.y, OBJECTIVE_SCALE));
  }
  if (hasZScale) writeVarint(bytes, quantize(state.zScale!, Z_SCALE_SCALE));

  const settings = state.settings ?? {};
  const written: number[] = [];
  const payload: number[] = [];
  SETTINGS.forEach((codec, index) => {
    const value = settings[codec.key];
    if (value === undefined) return;
    // a setting still at its default costs nothing to leave out
    if (value === DEFAULT_SOLVER_SETTINGS[codec.key as keyof SolverSettings]) {
      return;
    }
    written.push(index);
    switch (codec.kind) {
      case "bool":
        payload.push(value ? 1 : 0);
        break;
      case "int":
        writeVarint(payload, value as number);
        break;
      case "scaled":
        writeZigZag(payload, quantize(value as number, codec.scale));
        break;
      case "enum": {
        const at = codec.values.indexOf(value as string);
        payload.push(at < 0 ? 0 : at);
        break;
      }
    }
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
    if (bytes.length < 3 || bytes[0] !== VERSION) return null;
    const cursor: Cursor = { at: 2 };

    const flags = bytes[1]!;
    const completionMode = COMPLETION_MODES[flags & 0x03];
    const solverMode = SOLVER_MODES[(flags >> 2) & 0x07];
    if (!completionMode || !solverMode) return null;

    const vertexCount = readVarint(bytes, cursor);
    if (vertexCount > 100_000) return null;
    const vertices: { x: number; y: number }[] = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < vertexCount; i++) {
      x += readZigZag(bytes, cursor);
      y += readZigZag(bytes, cursor);
      vertices.push({
        x: dequantize(x, COORDINATE_SCALE),
        y: dequantize(y, COORDINATE_SCALE),
      });
    }

    const objective =
      (flags & 0x40) !== 0
        ? {
            x: dequantize(readZigZag(bytes, cursor), OBJECTIVE_SCALE),
            y: dequantize(readZigZag(bytes, cursor), OBJECTIVE_SCALE),
          }
        : null;
    const zScale =
      (flags & 0x80) !== 0
        ? dequantize(readVarint(bytes, cursor), Z_SCALE_SCALE)
        : undefined;

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
      switch (codec.kind) {
        case "bool":
          if (cursor.at >= bytes.length) return null;
          (settings[codec.key] as boolean) = bytes[cursor.at++] !== 0;
          break;
        case "int":
          (settings[codec.key] as number) = readVarint(bytes, cursor);
          break;
        case "scaled":
          (settings[codec.key] as number) = dequantize(
            readZigZag(bytes, cursor),
            codec.scale,
          );
          break;
        case "enum": {
          if (cursor.at >= bytes.length) return null;
          const value = codec.values[bytes[cursor.at++]!];
          if (value !== undefined) {
            (settings[codec.key] as string) = value;
          }
          break;
        }
      }
    }

    return {
      vertices,
      completionMode,
      objective,
      solverMode,
      settings,
      ...(zScale !== undefined ? { zScale } : {}),
      ...((flags & 0x20) !== 0 ? { is3DMode: true } : {}),
    };
  } catch {
    return null;
  }
}
