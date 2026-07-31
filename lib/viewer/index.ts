/**
 * Shared GPU scene-graph module (WS-F9).
 *
 * The drawings viewer consumes all of it today; the camera, gesture, and
 * renderer layers are the reusable substrate for any future GPU surface
 * (capture-scene splats being the planned second consumer).
 */
export { Camera2D } from "./camera"
export { TilePyramid, type TilePlacement } from "./tile-pyramid"
export { attachGestures, type GestureController, type GestureOptions } from "./gestures"
export { TileLoader } from "./tile-loader"
export { createSceneRenderer } from "./webgpu-renderer"
export {
  GpuDrawingViewer,
  type GpuViewerOptions,
  type OverlaySpec,
  type TileSourceSpec,
  type ViewerTransform,
} from "./gpu-viewer"
export type {
  CompareMode,
  DrawQuad,
  FrameSpec,
  ImageToScreenMatrix,
  Rect,
  SceneRenderer,
  Size,
  TileManifest,
  TileTexture,
} from "./types"
