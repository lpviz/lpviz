import { unpackSolverResponse } from "./resultPacking";
import type { SolverWireResponse, SolverWorkerPayload, SolverWorkerResponse, SolverWorkerSuccessResponse } from "./types";
// oxlint-disable-next-line import/default -- vite's ?worker import provides the default export
import SolverWorker from "./solverWorker?worker";

type Request = {
  id: number;
  payload: SolverWorkerPayload;
  resolve: (value: SolverWorkerResponse) => void;
  reject: (reason?: unknown) => void;
};

// One worker, one request in flight and at most one waiting behind it. The worker runs requests
// one after another and cannot abandon one, and every caller wants only the newest problem's
// answer (see solveRunner), so a request that arrives while one is waiting replaces it: the stale
// one is never computed, and during a drag the picture lags the pointer by at most one solve.
const worker = new SolverWorker();
let inFlight: Request | null = null;
let waiting: Request | null = null;
let nextRequestId = 0;

function dispatch() {
  if (inFlight || !waiting) return;
  inFlight = waiting;
  waiting = null;
  worker.postMessage({ id: inFlight.id, ...inFlight.payload });
}

worker.addEventListener("message", (event: MessageEvent<SolverWireResponse>) => {
  const request = inFlight;
  if (!request || event.data.id !== request.id) return;
  inFlight = null;
  dispatch();
  request.resolve(unpackSolverResponse(event.data));
});

function rejectAll(reason: unknown) {
  const requests = [inFlight, waiting];
  inFlight = null;
  waiting = null;
  for (const request of requests) request?.reject(reason);
}

worker.addEventListener("error", (event) => {
  rejectAll(event.error ?? event.message ?? event);
});

// A reply that fails structured deserialization would otherwise leave its request in flight
// forever, and with it every solve until reload.
worker.addEventListener("messageerror", () => {
  rejectAll(new Error("Solver worker reply could not be deserialized"));
});

export async function runSolverWorker(payload: SolverWorkerPayload): Promise<SolverWorkerSuccessResponse> {
  const response = await new Promise<SolverWorkerResponse>((resolve, reject) => {
    waiting?.reject(new Error("Solver request superseded by a newer one"));
    waiting = { id: ++nextRequestId, payload, resolve, reject };
    dispatch();
  });
  if (!response.success) throw new Error(response.error);
  return response;
}
