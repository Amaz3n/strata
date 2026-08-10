/**
 * Ink-difference math shared by both GPU backends.
 *
 * The compare mode treats darkness as ink, splits it into common / removed /
 * added, and recolors: unchanged linework gray, removed (base only) red,
 * added (overlay only) blue. The WGSL (webgpu-renderer.ts) and GLSL
 * (webgl2-renderer.ts) fragment shaders interpolate these constants via
 * `vec3Literal`, so the numbers cannot drift between backends, and
 * `inkDiffPixel` is the CPU reference implementation of the identical
 * arithmetic, golden-tested in tests/drawing-viewer-ink-diff.test.js.
 *
 * A pixel-level golden-image test against real shader output is not possible
 * in the node:test environment: Node has no WebGPU device and the project
 * carries no headless-GL native dependency, so neither backend can execute a
 * fragment shader there. Sharing the constants by construction plus testing
 * this reference implementation is the enforceable substitute.
 */

export type Vec3 = readonly [number, number, number]

/** Rec. 601 luma weights: perceived brightness → "ink" is its complement. */
export const INK_LUMA: Vec3 = [0.299, 0.587, 0.114]
/** Linework present in both revisions renders gray. */
export const INK_COMMON_TINT: Vec3 = [0.62, 0.62, 0.62]
/** Linework only in the base revision renders red. */
export const INK_REMOVED_TINT: Vec3 = [0.14, 0.86, 0.8]
/** Linework only in the overlay revision renders blue. */
export const INK_ADDED_TINT: Vec3 = [0.86, 0.55, 0.08]

function formatFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value)
}

/** A vec3 constructor literal for shader source interpolation. */
export function vec3Literal(lang: "wgsl" | "glsl", v: Vec3): string {
  const parts = v.map(formatFloat).join(", ")
  return lang === "wgsl" ? `vec3<f32>(${parts})` : `vec3(${parts})`
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/**
 * Reference implementation of the diff shaders' per-pixel combine. `base` and
 * `overlay` are linear RGB in [0, 1]; returns the composited RGB in [0, 1].
 */
export function inkDiffPixel(base: Vec3, overlay: Vec3): [number, number, number] {
  const inkBase = 1 - dot(base, INK_LUMA)
  const inkOverlay = 1 - dot(overlay, INK_LUMA)
  const commonInk = Math.min(inkBase, inkOverlay)
  const removed = clamp01(inkBase - commonInk)
  const added = clamp01(inkOverlay - commonInk)
  const channel = (i: 0 | 1 | 2): number =>
    clamp01(
      1 -
        commonInk * INK_COMMON_TINT[i] -
        removed * INK_REMOVED_TINT[i] -
        added * INK_ADDED_TINT[i],
    )
  return [channel(0), channel(1), channel(2)]
}
