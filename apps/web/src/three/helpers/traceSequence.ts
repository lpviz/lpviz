import type { Object3D } from "three";

// Trace chunks are immutable once appended, so each of a chunk's objects (its ribbon, its sprites)
// carries the sequence number of its append; the trace cache keys its incremental accumulation on
// it (see TraceCache.ts).
const sequences = new WeakMap<Object3D, number>();

export const stampTraceSequence = (object: Object3D, sequence: number): void => {
  sequences.set(object, sequence);
};

export const traceSequenceOf = (object: Object3D): number | undefined => sequences.get(object);
