/** Separate CPU rendering from network-bound title-block verification. */
export const DRAWING_LANES = ["split", "render", "metadata", "analysis"] as const
export type DrawingLane = typeof DRAWING_LANES[number]
export const DRAWING_LANE_JOBS: Record<DrawingLane, string[]> = {
  split: ["process_drawing_set", "split_drawing_chunk"],
  render: ["process_drawing_page", "generate_drawing_tiles"],
  metadata: ["enrich_drawing_metadata"],
  analysis: ["backfill_drawing_page_text", "extract_drawing_vectors", "detect_drawing_changes"],
}
export const DRAWING_LANE_CONCURRENCY: Record<DrawingLane, number> = {
  split: 1, render: 2, metadata: 6, analysis: 2,
}
export function parseDrawingLane(value: string | null): DrawingLane | undefined {
  return DRAWING_LANES.find(lane => lane === value)
}
