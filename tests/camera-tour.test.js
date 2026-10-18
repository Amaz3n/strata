require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { tourPose, tourDurationSec, shouldRecord, TOUR_SAMPLE_SEC } = require("../lib/plans/camera-tour")

const line = [0, 1, 2, 3].map((x) => [x * 2, 5.5, 0, x * 2 + 1, 5.5, 0])

test("playback passes through every sample at the recorded pace", () => {
  assert.equal(tourDurationSec(line), 3 * TOUR_SAMPLE_SEC)
  for (let i = 0; i < line.length; i++) assert.deepEqual(tourPose(line, i * TOUR_SAMPLE_SEC).map((v) => +v.toFixed(9)), line[i])
  const mid = tourPose(line, 1.5 * TOUR_SAMPLE_SEC)
  assert.ok(Math.abs(mid[0] - 3) < 1e-9, "straight line stays straight")
})

test("playback clamps to the ends and handles tiny tours", () => {
  assert.deepEqual(tourPose(line, -5), line[0])
  assert.deepEqual(tourPose(line, 999), line[3])
  assert.equal(tourPose([], 1), null)
  assert.deepEqual(tourPose([line[0]], 1), line[0])
})

test("recording keeps movement and about a second of stillness", () => {
  assert.equal(shouldRecord(undefined, line[0], 0), true)
  assert.equal(shouldRecord(line[0], line[1], 10), true)
  assert.equal(shouldRecord(line[0], line[0], 0), true)
  assert.equal(shouldRecord(line[0], line[0], 10), false)
})
