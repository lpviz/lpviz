import { describe, expect, test } from "bun:test";
import type { InterleavedBufferAttribute } from "three";
import { FatLine } from "./fatLine";

const endpoints = (line: FatLine) => line.object3D.geometry.getAttribute("instanceStart") as InterleavedBufferAttribute;

describe("FatLine.draw", () => {
  test("a line with as many segments as before keeps its buffer and takes the new endpoints", () => {
    const line = new FatLine({ color: "#000000", linewidth: 2, slot: "objective" });
    line.draw([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 1, 0], false);
    const first = endpoints(line);
    const version = first.data.version;
    line.draw([0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 2, 0], false);
    const second = endpoints(line);
    expect(second.data).toBe(first.data);
    expect(second.data.version).toBe(version + 1);
    expect(Array.from(second.data.array)).toEqual([0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 2, 0]);
    expect(line.object3D.geometry.instanceCount).toBe(2);
  });

  test("a different segment count gets a new buffer and the matching instance count", () => {
    const line = new FatLine({ color: "#000000", linewidth: 2, slot: "objective" });
    line.draw([0, 0, 0, 1, 0, 0], false);
    const first = endpoints(line);
    line.draw([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0, 2, 0, 0, 3, 0, 0], false);
    const second = endpoints(line);
    expect(second.data).not.toBe(first.data);
    expect(line.object3D.geometry.instanceCount).toBe(3);
  });
});
