import type { SolverMode } from "@/features/solver/solverSettings";
import type { Vec } from "@lpviz/math/types";
import type { Director } from "./director";

// The named demos `/?record=<name>` plays. Each is an async function of the director: write a new
// one here (or pass one to `lpvizRecord.run` from the console) to showcase something else.
// Coordinates are world coordinates; at 1600x900 the default view shows about x in [-28, 28],
// y in [-22, 22], centered on the origin beside the sidebar.

export type RecordScript = (d: Director) => Promise<void>;

// a lopsided hexagon, drawn clockwise from the top left, with integer corners so the
// formulation in the sidebar reads cleanly
const REGION: Vec[] = [
  [-14, 10],
  [4, 13],
  [16, 6],
  [15, -9],
  [-2, -13],
  [-16, -4],
];
const OBJECTIVE: Vec = [9, 6];

/** Draw the region, then aim the objective: the opening of every demo that draws. */
async function drawProblem(d: Director, { captions = true } = {}) {
  d.showCursor();
  await d.wait(500);
  if (captions) await d.caption("Click to draw the constraints");
  await d.move([-6, 2]);
  await d.wait(250);
  await d.draw(REGION);
  await d.wait(500);
  if (captions) await d.caption("Point the objective");
  await d.move([3, -3], { durationMs: 700 });
  await d.move([6, 1.5], { durationMs: 700 });
  await d.objective(OBJECTIVE);
  await d.wait(500);
  await d.caption(null);
}

/** Sweep the objective's tip around the origin in one smooth arc, the active solver re-solving as it goes. */
async function sweepObjective(d: Director, fromAngle: number, toAngle: number, durationMs = 3600) {
  const r = Math.hypot(OBJECTIVE[0], OBJECTIVE[1]);
  await d.drag(d.polar(r, fromAngle), (t) => d.polar(r, fromAngle + (toAngle - fromAngle) * t), { durationMs });
}

const OBJECTIVE_ANGLE = Math.atan2(OBJECTIVE[1], OBJECTIVE[0]);

export const RECORD_SCRIPTS: Record<string, { description: string; run: RecordScript }> = {
  full: {
    description: "draw, aim, then IPM, Simplex, PDHG, Active-Set and the central path, then a live objective sweep",
    run: async (d) => {
      await drawProblem(d);
      await d.caption("Pick a solver");
      await d.solver("ipm");
      await d.wait(700);
      await d.caption(null);
      for (const mode of ["simplex", "pdhg", "activeSet", "central"] as const) {
        await d.solver(mode);
        await d.wait(900);
      }
      await d.solver("ipm", { animate: false });
      await d.caption("Drag anything; it re-solves live");
      await sweepObjective(d, OBJECTIVE_ANGLE, OBJECTIVE_ANGLE + Math.PI * 0.9);
      await d.wait(400);
      await d.drag(REGION[2]!, [[20, 9]], { durationMs: 1400 });
      await d.caption(null);
      await d.wait(800);
      d.hideCursor();
      await d.wait(800);
    },
  },
  draw: {
    description: "draw the region and the objective, then solve with IPM",
    run: async (d) => {
      await drawProblem(d);
      await d.solver("ipm");
      await d.wait(1200);
      d.hideCursor();
      await d.wait(600);
    },
  },
  drag: {
    description: "draw, aim, solve once with the central path, then drag the objective, a vertex and an edge (no solver switching)",
    run: async (d) => {
      await drawProblem(d);
      await d.solver("central");
      await d.wait(800);
      await d.caption("Drag anything; it re-solves live");
      await sweepObjective(d, OBJECTIVE_ANGLE, OBJECTIVE_ANGLE + Math.PI * 1.2, 4800);
      await d.wait(500);
      await d.drag(
        REGION[2]!,
        [
          [21, 11],
          [11, 2],
          [16, 6],
        ],
        { durationMs: 3000 },
      );
      await d.wait(500);
      // the middle of the bottom-right edge, pushed out and back
      await d.drag(
        [6.5, -11],
        [
          [8, -15.5],
          [6.5, -11],
        ],
        { durationMs: 2000 },
      );
      await d.caption(null);
      await d.wait(800);
      d.hideCursor();
      await d.wait(800);
    },
  },
  rotate: {
    description: "one solver (`&solver=ipm|central|pdhg|simplex|activeSet|ellipsoid`) on a ready-made problem, the objective turning once plainly and once leaving a trace",
    run: async (d) => {
      const mode = (new URLSearchParams(window.location.search).get("solver") ?? "ipm") as SolverMode;
      d.hideCursor();
      await d.load(REGION, OBJECTIVE);
      await d.frame(REGION, { durationMs: 0, margin: 0.4 });
      // a step every other frame: a smooth turn, about 4.2 s around, and a trace of 126 paths
      // (sparse enough to read; a finer step fills the region solid)
      d.setting("objectiveAngleStep", 0.05);
      d.setting("objectiveRotationSpeed", 1);
      await d.solver(mode, { animate: false });
      await d.wait(700);
      await d.spin(1, { trace: false, stop: false });
      await d.spin(1, { trace: true });
      await d.wait(900);
    },
  },
  rotate3d: {
    description: "`rotate` lifted into 3D: each iterate raised by the solver's convergence measure, the camera orbiting as the objective turns",
    run: async (d) => {
      const params = new URLSearchParams(window.location.search);
      const mode = (params.get("solver") ?? "ipm") as SolverMode;
      const orbitDeg = Number(params.get("orbit") ?? 120);
      d.hideCursor();
      await d.load(REGION, OBJECTIVE);
      await d.frame(REGION, { durationMs: 0, margin: 0.4 });
      d.setting("objectiveAngleStep", 0.05);
      d.setting("objectiveRotationSpeed", 1);
      await d.solver(mode, { animate: false });
      // every solver's measure has its own range (IPM's mu starts in the hundreds, PDHG's residual
      // is scaled): size the lift so this solve's tallest point stands `height` world units high
      const { lift } = d.state().originalIteratePath;
      const tallest = lift ? Math.max(...lift) : 0;
      if (tallest > 0) d.actions.setZScale((100 * Number(params.get("height") ?? 14)) / tallest);
      d.mark();
      await d.wait(500);
      await d.toggle3D();
      await d.wait(400);
      // two turns of the objective (about 8.4 s) under one slow orbit of the camera
      const orbiting = d.orbit((orbitDeg * Math.PI) / 180, { durationMs: 8400, ease: true, tilt: 0.12 });
      await d.spin(1, { trace: false, stop: false });
      await d.spin(1, { trace: true });
      await orbiting;
      await d.wait(900);
    },
  },
  solvers: {
    description: "a ready-made problem, solved by each solver in turn",
    run: async (d) => {
      await d.load(REGION, OBJECTIVE);
      d.showCursor();
      await d.wait(600);
      for (const mode of ["ipm", "simplex", "pdhg", "activeSet", "ellipsoid", "central"] as const) {
        await d.solver(mode);
        await d.wait(1000);
      }
      d.hideCursor();
      await d.wait(600);
    },
  },
  interactive: {
    description: "a ready-made problem with IPM: sweep the objective, drag a vertex and an edge",
    run: async (d) => {
      await d.load(REGION, OBJECTIVE);
      d.showCursor();
      await d.wait(500);
      await d.solver("ipm");
      await d.wait(600);
      await sweepObjective(d, OBJECTIVE_ANGLE, OBJECTIVE_ANGLE + Math.PI * 1.2, 4800);
      await d.wait(500);
      await d.drag(
        REGION[2]!,
        [
          [21, 11],
          [11, 2],
          [16, 6],
        ],
        { durationMs: 3000 },
      );
      await d.wait(500);
      // the middle of the bottom-right edge, pushed out and back
      await d.drag(
        [6.5, -11],
        [
          [8, -15.5],
          [6.5, -11],
        ],
        { durationMs: 2000 },
      );
      await d.wait(800);
      d.hideCursor();
      await d.wait(600);
    },
  },
  "3d": {
    description: "a ready-made problem with IPM, lifted into 3D, the objective rotating with a trace",
    run: async (d) => {
      await d.load(REGION, OBJECTIVE);
      await d.solver("ipm", { animate: false });
      await d.wait(400);
      await d.toggle3D();
      await d.wait(600);
      await d.animate();
      await d.wait(500);
      await d.rotate(6000, { trace: true });
      await d.wait(1000);
    },
  },
};
