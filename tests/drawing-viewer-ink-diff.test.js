require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  INK_LUMA,
  INK_COMMON_TINT,
  INK_REMOVED_TINT,
  INK_ADDED_TINT,
  inkDiffPixel,
  vec3Literal,
} = require("../lib/viewer/ink-diff")
const { DIFF_WGSL } = require("../lib/viewer/webgpu-renderer")
const { DIFF_FRAG } = require("../lib/viewer/webgl2-renderer")

// ---------------------------------------------------------------------------
// Golden values for the shared ink-diff math.
//
// A pixel-level golden-image test against real shader output is not possible
// here: node:test has no WebGPU device and the project has no headless-GL
// dependency, so neither fragment shader can execute. Instead the math lives
// once in lib/viewer/ink-diff.ts — the CPU reference implementation below is
// golden-tested, and both shaders interpolate the same constants (asserted at
// the bottom), so the three implementations cannot drift apart.
// ---------------------------------------------------------------------------

function assertRgb(actual, expected, label) {
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) < 1e-9,
      `${label} channel ${i}: ${actual[i]} vs ${expected[i]}`,
    )
  }
}

test("blank paper stays blank", () => {
  assertRgb(inkDiffPixel([1, 1, 1], [1, 1, 1]), [1, 1, 1], "white/white")
})

test("linework in both revisions renders the common gray", () => {
  // Full ink on both sides: 1 - 1·0.62 per channel.
  assertRgb(inkDiffPixel([0, 0, 0], [0, 0, 0]), [0.38, 0.38, 0.38], "black/black")
  // Half ink on both sides: 1 - 0.5·0.62.
  assertRgb(
    inkDiffPixel([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]),
    [0.69, 0.69, 0.69],
    "gray/gray",
  )
})

test("linework only in the base renders red (removed)", () => {
  assertRgb(inkDiffPixel([0, 0, 0], [1, 1, 1]), [0.86, 0.14, 0.2], "black base")
  // Pure red base: ink = 1 - 0.299 = 0.701, all of it removed.
  assertRgb(
    inkDiffPixel([1, 0, 0], [1, 1, 1]),
    [1 - 0.701 * 0.14, 1 - 0.701 * 0.86, 1 - 0.701 * 0.8],
    "red base",
  )
})

test("linework only in the overlay renders blue (added)", () => {
  assertRgb(inkDiffPixel([1, 1, 1], [0, 0, 0]), [0.14, 0.45, 0.92], "black overlay")
})

test("asymmetric ink splits into common plus the difference tint", () => {
  // Base darker than overlay: common = 0.31 (overlay ink), removed = 0.31.
  const base = [0.38, 0.38, 0.38]
  const overlay = [0.69, 0.69, 0.69]
  const common = 1 - 0.69
  const removed = (1 - 0.38) - common
  assertRgb(
    inkDiffPixel(base, overlay),
    [
      1 - common * 0.62 - removed * 0.14,
      1 - common * 0.62 - removed * 0.86,
      1 - common * 0.62 - removed * 0.8,
    ],
    "darker base",
  )
})

test("output stays clamped to [0, 1] across the input range", () => {
  const steps = [0, 0.25, 0.5, 0.75, 1]
  for (const a of steps) {
    for (const b of steps) {
      const rgb = inkDiffPixel([a, a, a], [b, b, b])
      for (const channel of rgb) {
        assert.ok(channel >= 0 && channel <= 1, `clamped for base ${a} overlay ${b}`)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Shader-source sync: both backends must interpolate the shared constants.
// ---------------------------------------------------------------------------

test("vec3Literal formats floats per shading language", () => {
  assert.equal(vec3Literal("wgsl", [0.62, 0.62, 0.62]), "vec3<f32>(0.62, 0.62, 0.62)")
  assert.equal(vec3Literal("glsl", [0.62, 0.62, 0.62]), "vec3(0.62, 0.62, 0.62)")
  assert.equal(vec3Literal("glsl", [1, 0, 0]), "vec3(1.0, 0.0, 0.0)")
})

test("the WGSL and GLSL diff shaders embed the shared constants", () => {
  for (const weights of [INK_LUMA, INK_COMMON_TINT, INK_REMOVED_TINT, INK_ADDED_TINT]) {
    assert.ok(
      DIFF_WGSL.includes(vec3Literal("wgsl", weights)),
      `WGSL embeds ${weights.join(",")}`,
    )
    assert.ok(
      DIFF_FRAG.includes(vec3Literal("glsl", weights)),
      `GLSL embeds ${weights.join(",")}`,
    )
  }
})
