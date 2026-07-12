import { isObjectiveDirectionUnbounded } from "@lpviz/math/geometry";
import type { PointXY, PointXYZ } from "@lpviz/math/types";
import { hasPolytopeLines, type PolytopeRepresentation } from "./polytopeTypes";

export { isObjectiveDirectionUnbounded } from "@lpviz/math/geometry";

// Inclination-to-azimuth frequency ratio of the 3D objective sweep (the
// golden-ratio conjugate). Because it is irrational, the spiral's successive
// pole-to-pole sweeps interleave instead of retracing, so the visited
// directions are dense on the sphere — the 3D analogue of "spin the
// objective all the way around".
const SPHERE_SPIRAL_RATIO = 0.6180339887498949;

export interface SphereSpiralState {
  radius: number;
  theta0: number;
  zeta0: number;
}

// Anchor the spiral at the current objective so rotation starts without a
// jump: theta/zeta are the direction's azimuth and inclination at t = 0.
export function beginSphereSpiral(objective: PointXYZ): SphereSpiralState {
  const radius = Math.max(1e-3, Math.hypot(objective.x, objective.y, objective.z));
  const planar = Math.hypot(objective.x, objective.y);
  return {
    radius,
    theta0: planar > 1e-12 ? Math.atan2(objective.y, objective.x) : 0,
    zeta0: Math.atan2(objective.z, planar),
  };
}

// Objective direction after sweeping `t` radians of azimuth from the anchor.
export function sphereSpiralObjective(spiral: SphereSpiralState, t: number): PointXYZ {
  const theta = spiral.theta0 + t;
  const zeta = spiral.zeta0 + SPHERE_SPIRAL_RATIO * t;
  const planar = spiral.radius * Math.cos(zeta);
  return {
    x: planar * Math.cos(theta),
    y: planar * Math.sin(theta),
    z: spiral.radius * Math.sin(zeta),
  };
}

export interface ObjectiveRotationStep {
  nextObjective: PointXY;
  nextDirection: 1 | -1;
}

export function computeObjectiveRotationStep({ objectiveVector, angleStep, rotationDirection, polytope }: { objectiveVector: PointXY; angleStep: number; rotationDirection: 1 | -1; polytope: PolytopeRepresentation | null }): ObjectiveRotationStep {
  const angle = Math.atan2(objectiveVector.y, objectiveVector.x);
  const magnitude = Math.hypot(objectiveVector.x, objectiveVector.y);

  let nextDirection: 1 | -1 = rotationDirection;
  let nextAngle = angle + angleStep * nextDirection;

  if (hasPolytopeLines(polytope) && polytope.kind === "unbounded") {
    const candidateDirections: Array<1 | -1> = [rotationDirection, rotationDirection === 1 ? -1 : 1];
    const allowedDirection = candidateDirections.find((direction) => {
      const candidateAngle = angle + angleStep * direction;
      const candidateObjective: [number, number] = [magnitude * Math.cos(candidateAngle), magnitude * Math.sin(candidateAngle)];
      return !isObjectiveDirectionUnbounded(polytope.lines, candidateObjective);
    });

    if (allowedDirection !== undefined) {
      nextDirection = allowedDirection;
      nextAngle = angle + angleStep * nextDirection;
    }
    // When both directions lead into unbounded objective territory (the
    // bounded cone is narrower than angleStep), keep rotating rather than
    // stalling forever; the solver reports unboundedness for those frames.
  }

  return {
    nextObjective: {
      x: magnitude * Math.cos(nextAngle),
      y: magnitude * Math.sin(nextAngle),
    },
    nextDirection,
  };
}
