require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { attachGestures } = require("../lib/viewer/gestures")

// Flick inertia schedules rAF frames; capture instead of running them.
const rafCalls = []
global.requestAnimationFrame = (callback) => {
  rafCalls.push(callback)
  return rafCalls.length
}
global.cancelAnimationFrame = () => {}

/**
 * Minimal gesture host + element harness: handlers are captured on attach and
 * driven directly with synthetic pointer events (local coords = client
 * coords, the element sits at the origin).
 */
function makeHarness(options) {
  const handlers = {}
  const element = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener: (type, handler) => {
      handlers[type] = handler
    },
    removeEventListener: () => {},
    setPointerCapture: () => {},
  }
  const pans = []
  const zooms = []
  const controller = attachGestures(
    element,
    {
      panByScreen: (dx, dy) => pans.push([dx, dy]),
      zoomBy: (factor, focal) => zooms.push([factor, focal]),
    },
    options,
  )
  return { handlers, pans, zooms, controller }
}

function pointerEvent(type, pointerId, x, y) {
  return {
    type,
    pointerId,
    clientX: x,
    clientY: y,
    pointerType: "touch",
    button: 0,
    preventDefault: () => {},
  }
}

test("lifting one finger of a pinch does not throw and the survivor pans with no jump", () => {
  const { handlers, pans, zooms, controller } = makeHarness()

  handlers.pointerdown(pointerEvent("pointerdown", 1, 100, 100))
  handlers.pointerdown(pointerEvent("pointerdown", 2, 200, 100))
  handlers.pointermove(pointerEvent("pointermove", 2, 220, 100))
  assert.equal(zooms.length, 1)
  assert.ok(Math.abs(zooms[0][0] - 1.2) < 1e-12, "pinch zoom factor")

  // The crash: 2 → 1 used to call refreshPinch() with a single pointer.
  assert.doesNotThrow(() => handlers.pointerup(pointerEvent("pointerup", 2, 220, 100)))

  // The surviving finger pans by exactly its own movement — no coordinate jump.
  const pansBefore = pans.length
  const zoomsBefore = zooms.length
  handlers.pointermove(pointerEvent("pointermove", 1, 110, 112))
  assert.equal(pans.length, pansBefore + 1)
  assert.deepEqual(pans[pans.length - 1], [10, 12])
  assert.equal(zooms.length, zoomsBefore, "no zoom from single-pointer movement")

  controller.destroy()
})

test("releasing both pinch fingers produces no phantom flick from stale velocity", () => {
  const { handlers, controller } = makeHarness()
  const rafBefore = rafCalls.length

  handlers.pointerdown(pointerEvent("pointerdown", 1, 100, 100))
  handlers.pointerdown(pointerEvent("pointerdown", 2, 200, 100))
  handlers.pointermove(pointerEvent("pointermove", 2, 240, 100))
  handlers.pointerup(pointerEvent("pointerup", 2, 240, 100))
  // Lift the survivor without further movement, past the click slop so the
  // flick path (not the click path) is what decides. Velocity was reset on
  // the 2 → 1 transition, so no inertia frame may be scheduled.
  handlers.pointerup(pointerEvent("pointerup", 1, 106, 100))
  assert.equal(rafCalls.length, rafBefore, "no flick frame scheduled")

  controller.destroy()
})

test("a fresh second finger after 2 → 1 re-seeds the pinch distance", () => {
  const { handlers, zooms, controller } = makeHarness()

  handlers.pointerdown(pointerEvent("pointerdown", 1, 100, 100))
  handlers.pointerdown(pointerEvent("pointerdown", 2, 200, 100))
  handlers.pointerup(pointerEvent("pointerup", 2, 200, 100))
  handlers.pointerdown(pointerEvent("pointerdown", 2, 200, 100))
  handlers.pointermove(pointerEvent("pointermove", 2, 210, 100))
  assert.equal(zooms.length, 1)
  // Distance re-seeded to 100 on the second touch; not carried from before.
  assert.ok(Math.abs(zooms[0][0] - 1.1) < 1e-12)

  controller.destroy()
})

test("3 → 2 re-seeds the pinch from the two remaining fingers", () => {
  const { handlers, zooms, controller } = makeHarness()

  handlers.pointerdown(pointerEvent("pointerdown", 1, 0, 0))
  handlers.pointerdown(pointerEvent("pointerdown", 2, 100, 0))
  handlers.pointerdown(pointerEvent("pointerdown", 3, 50, 200))
  assert.doesNotThrow(() => handlers.pointerup(pointerEvent("pointerup", 3, 50, 200)))

  handlers.pointermove(pointerEvent("pointermove", 2, 110, 0))
  assert.equal(zooms.length, 1)
  assert.ok(Math.abs(zooms[0][0] - 1.1) < 1e-12)

  controller.destroy()
})
