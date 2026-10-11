import { describe, expect, test } from "bun:test";
import { attachPointerGestures, type PointerGestureHandlers } from "./pointerGestures";

// The scaffolding's contract with both viewport controllers, on a canvas that is only an
// EventTarget: which handler a sequence of pointers reaches, and which events lose their default.
class FakeCanvas extends EventTarget {
  captured: number[] = [];
  focused = 0;
  setPointerCapture(id: number) {
    this.captured.push(id);
  }
  focus() {
    this.focused++;
  }
}

type Call = [string, ...unknown[]];

function harness(claims: Partial<Record<"dragStart" | "pinchStart" | "wheel", boolean>> = {}) {
  const canvas = new FakeCanvas();
  const calls: Call[] = [];
  const handlers: PointerGestureHandlers = {
    dragStart: () => {
      calls.push(["dragStart"]);
      return claims.dragStart ?? true;
    },
    dragMove: (x, y) => {
      calls.push(["dragMove", x, y]);
    },
    dragEnd: () => {
      calls.push(["dragEnd"]);
      return true;
    },
    pinchStart: (pair) => {
      calls.push(["pinchStart", pair]);
      return claims.pinchStart ?? true;
    },
    pinchMove: (pair) => {
      calls.push(["pinchMove", pair]);
    },
    pinchEnd: () => {
      calls.push(["pinchEnd"]);
    },
    wheel: (_event, delta) => {
      calls.push(["wheel", delta]);
      return claims.wheel ?? true;
    },
  };
  const detach = attachPointerGestures(canvas as unknown as HTMLCanvasElement, handlers);
  const pointer = (type: string, pointerId: number, x: number, y: number, pointerType = "touch") => {
    const event = Object.assign(new Event(type, { cancelable: true }), { pointerId, pointerType, clientX: x, clientY: y, isPrimary: pointerId === 1, button: 0 });
    canvas.dispatchEvent(event);
    return event;
  };
  const wheel = (deltaX: number, deltaY: number) => {
    const event = Object.assign(new Event("wheel", { cancelable: true }), { deltaX, deltaY });
    canvas.dispatchEvent(event);
    return event;
  };
  return { canvas, calls, detach, pointer, wheel };
}

describe("attachPointerGestures", () => {
  test("one pointer drags: captured, focused, and its events lose their default", () => {
    const { canvas, calls, pointer } = harness();
    expect(pointer("pointerdown", 1, 10, 20).defaultPrevented).toBe(true);
    expect(canvas.captured).toContain(1);
    expect(canvas.focused).toBe(1);
    expect(pointer("pointermove", 1, 12, 25).defaultPrevented).toBe(true);
    expect(pointer("pointerup", 1, 12, 25).defaultPrevented).toBe(true);
    expect(calls).toEqual([["dragStart"], ["dragMove", 12, 25], ["dragEnd"]]);
  });

  test("a pointer the handler declines is not a drag", () => {
    const { calls, pointer } = harness({ dragStart: false });
    expect(pointer("pointerdown", 1, 10, 20).defaultPrevented).toBe(false);
    pointer("pointermove", 1, 12, 25);
    pointer("pointerup", 1, 12, 25);
    expect(calls).toEqual([["dragStart"]]);
  });

  test("a second finger takes over: the pair is the gesture, and the first finger's drag is the handler's to end", () => {
    const { calls, pointer } = harness();
    pointer("pointerdown", 1, 0, 0);
    expect(pointer("pointerdown", 2, 4, 3).defaultPrevented).toBe(true);
    pointer("pointermove", 1, 0, 2);
    pointer("pointerup", 1, 0, 2);
    pointer("pointerup", 2, 4, 3);
    expect(calls).toEqual([["dragStart"], ["pinchStart", { center: { x: 2, y: 1.5 }, distance: 5 }], ["pinchMove", { center: { x: 2, y: 2.5 }, distance: Math.hypot(4, 1) }], ["pinchEnd"]]);
  });

  test("a pair the handler declines leaves the first finger dragging", () => {
    const { calls, pointer } = harness({ pinchStart: false });
    pointer("pointerdown", 1, 0, 0);
    pointer("pointerdown", 2, 4, 3);
    pointer("pointermove", 1, 1, 1);
    expect(calls.map(([name]) => name)).toEqual(["dragStart", "pinchStart", "dragMove"]);
  });

  test("a third finger and a mouse during a pinch are ignored", () => {
    const { calls, pointer } = harness();
    pointer("pointerdown", 1, 0, 0);
    pointer("pointerdown", 2, 4, 3);
    pointer("pointerdown", 3, 9, 9);
    pointer("pointerdown", 1, 5, 5, "mouse");
    expect(calls.map(([name]) => name)).toEqual(["dragStart", "pinchStart"]);
  });

  test("the wheel reports its dominant axis, and only a taken wheel is consumed", () => {
    const taken = harness();
    expect(taken.wheel(10, -30).defaultPrevented).toBe(true);
    expect(taken.wheel(0, 0).defaultPrevented).toBe(false);
    expect(taken.calls).toEqual([["wheel", -30]]);
    const declined = harness({ wheel: false });
    expect(declined.wheel(-7, 2).defaultPrevented).toBe(false);
    expect(declined.calls).toEqual([["wheel", -7]]);
  });

  test("nothing reaches the handlers once detached", () => {
    const { calls, detach, pointer } = harness();
    detach();
    pointer("pointerdown", 1, 0, 0);
    expect(calls).toEqual([]);
  });
});
