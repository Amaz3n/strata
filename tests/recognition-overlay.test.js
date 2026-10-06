require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { registerRecognitionImage } = require("../lib/drawings/recognition-overlay")

test("registering to a rounded crop keeps every path at its original sheet position", () => {
  const request = {
    region: { x0: 0.2, y0: 0.3, x1: 0.5, y1: 0.6 },
    catalogue: [
      {
        id: 8,
        prior: "wall",
        kind: "stroke",
        bounds: [0, 0, 1, 1],
        commands: [["M", 0, 0], ["L", 1, 1]],
      },
    ],
  }
  const crop = { x0: 0.19, y0: 0.29, x1: 0.51, y1: 0.61 }

  const registered = registerRecognitionImage(request, crop)

  const [path] = registered.catalogue
  const [, endX, endY] = path.commands[1]
  assert.equal(path.id, 8)
  assert.ok(Math.abs(crop.x0 + endX * (crop.x1 - crop.x0) - 0.5) < 1e-12)
  assert.ok(Math.abs(crop.y0 + endY * (crop.y1 - crop.y0) - 0.6) < 1e-12)
  assert.deepEqual(request.catalogue[0].commands, [["M", 0, 0], ["L", 1, 1]], "the request is not mutated")
})
