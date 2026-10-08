import type { Object3D } from "three";

// Trace chunks are immutable once appended, so each ribbon mesh carries the sequence number of its
// append; the trace cache keys its incremental accumulation on it (see TraceCache.ts).
const sequences = new WeakMap<Object3D, number>();

export const stampTraceSequence = (mesh: Object3D, sequence: number): void => {
  sequences.set(mesh, sequence);
};

export const traceSequenceOf = (object: Object3D): number | undefined => sequences.get(object);
