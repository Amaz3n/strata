/**
 * Shared scene-graph types for GPU-rendered viewers.
 *
 * The drawings viewer is the first consumer; the capture-scene (splat) viewer
 * is the planned second. Everything lives in one of three coordinate spaces:
 *
 *  - image px:  the full-resolution sheet raster. Markups, takeoff geometry,
 *    and vector snapping all use this space (or its 0..1 normalized form).
 *  - screen px: CSS pixels relative to the viewer container's top-left. The
 *    SVG overlay and pointer events use this space.
 *  - device px: screen px × devicePixelRatio. Only renderers see these.
 *
 * Client-safe and pure: no DOM types beyond ImageBitmap/canvas in the
 * renderer contract, no React.
 */

/** Affine image→screen transform in CSS pixels (SVG `matrix()` order). */
export interface ImageToScreenMatrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * DZI-style tile manifest written by the drawings pipeline next to the tiles.
 * `Levels` is our worker's non-standard helper for reliable level detection;
 * legacy manifests without it hold a single full-size image.
 */
export interface TileManifest {
  Image: {
    xmlns?: string
    Format: string
    Overlap: number
    TileSize: number
    Size: { Width: number; Height: number }
  }
  Levels?: number
}

/**
 * Opaque handle to a tile uploaded to the GPU. Renderers return their own
 * concrete subclass and recognize it again by instanceof — callers never
 * look inside.
 */
export interface TileTexture {
  readonly width: number
  readonly height: number
}

/** One textured quad to draw, positioned in image px. */
export interface DrawQuad {
  texture: TileTexture
  rect: Rect
}

/**
 * How a frame with an overlay source composites it over the base:
 *  - `composite`: overlay alpha-blended at `overlayOpacity` (onion skin)
 *  - `difference`: both sources rasterized offscreen, combined by an ink-diff
 *    shader — unchanged linework gray, removed (base only) red, added
 *    (overlay only) blue
 */
export type CompareMode = "composite" | "difference"

export interface FrameSpec {
  matrix: ImageToScreenMatrix
  /** Viewer container size in CSS px. */
  viewport: Size
  dpr: number
  /** Coarse-to-fine ordered: later quads draw over earlier ones. */
  base: DrawQuad[]
  overlay: DrawQuad[]
  overlayOpacity: number
  mode: CompareMode
  /** Sheet bounds in image px; difference output is clipped to this quad. */
  imageRect: Rect
}

export interface SceneRenderer {
  readonly backend: "webgpu" | "webgl2"
  /**
   * Fired when the GPU device / context is lost out from under the renderer
   * (driver reset, GPU process crash, tab backgrounding on iOS). Never fired
   * for a deliberate destroy(). The renderer and everything it uploaded are
   * dead once this fires — the owner must tear down and re-negotiate.
   */
  onDeviceLost: ((reason: string) => void) | null
  uploadTile(bitmap: ImageBitmap): TileTexture
  destroyTile(texture: TileTexture): void
  render(frame: FrameSpec): void
  resize(viewport: Size, dpr: number): void
  destroy(): void
}
