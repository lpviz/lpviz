import { unpackSolverResponse, type PackedSolverWorkerResponse } from "./resultPacking";
import type { SolverWorkerPayload, SolverWorkerResponse, SolverWorkerSuccessResponse } from "./solverWorker";
// oxlint-disable-next-line import/default -- vite's ?worker import provides the default export
import SolverWorker from "./solverWorker?worker";

const MAX_WORKER_QUEUE = 4;

type PendingResolver = {
  resolve: (value: SolverWorkerResponse) => void;
  reject: (reason?: unknown) => void;
};

type QueueEntry = PendingResolver & {
  id: number;
  payload: SolverWorkerPayload;
};

const worker = new SolverWorker();
const pending = new Map<number, PendingResolver>();
const requestQueue: QueueEntry[] = [];
let nextRequestId = 0;

worker.addEventListener("message", (event: MessageEvent<PackedSolverWorkerResponse>) => {
  const entry = pending.get(event.data.id);
  if (!entry) return;
  pending.delete(event.data.id);
  scheduleDispatch();
  entry.resolve(unpackSolverResponse(event.data));
});

function rejectAll(reason: unknown) {
  pending.forEach(({ reject }) => reject(reason));
  pending.clear();
  requestQueue.forEach(({ reject }) => reject(reason));
  requestQueue.length = 0;
}

worker.addEventListener("error", (event) => {
  rejectAll(event.error ?? event.message ?? event);
});

// A reply that fails structured deserialization would otherwise leave its
// pending entry stranded forever; once pending fills up, dispatch stops and
// all solving is dead until reload.
worker.addEventListener("messageerror", () => {
  rejectAll(new Error("Solver worker reply could not be deserialized"));
});

function scheduleDispatch() {
  while (pending.size < MAX_WORKER_QUEUE && requestQueue.length > 0) {
    const entry = requestQueue.shift()!;
    pending.set(entry.id, { resolve: entry.resolve, reject: entry.reject });
    worker.postMessage({ id: entry.id, ...entry.payload });
  }
}

function dropOverflow() {
  const allowedQueueLength = Math.max(1, MAX_WORKER_QUEUE - pending.size);
  while (requestQueue.length > allowedQueueLength) {
    const dropped = requestQueue.shift();
    if (!dropped) break;
    dropped.reject(new Error("Solver request dropped due to queue overflow"));
  }
}

export async function runSolverWorker(payload: SolverWorkerPayload): Promise<SolverWorkerSuccessResponse> {
  const id = ++nextRequestId;
  const response = await new Promise<SolverWorkerResponse>((resolve, reject) => {
    requestQueue.push({ id, payload, resolve, reject });
    dropOverflow();
    scheduleDispatch();
  });

  if (!response.success) {
    throw new Error(response.error);
  }
  return response;
}
