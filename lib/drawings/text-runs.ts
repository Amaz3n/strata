/**
 * Positioned text runs extracted from a drawing sheet.
 *
 * `page_text` on the sheet version carries the sheet's words but not WHERE they
 * sit, which is enough for search and useless for anything geometric. Room
 * labelling needs position: "KITCHEN" is only a kitchen label because its
 * bounding box lands inside the kitchen polygon.
 *
 * The pipeline writes `text-runs.json` next to `vectors.bin` under the sheet
 * version's `tiles_base_path`, in the SAME normalized 0..1 y-down image space
 * the vectors and markups use, and gated behind the same `vectorAligned`
 * condition — a rotated page whose vectors are unusable has unusable text
 * positions too.
 *
 * Client-safe and pure: no imports, no DOM, no MuPDF.
 */

/** File name written under `tiles_base_path`, next to `vectors.bin`. */
export const TEXT_RUNS_FILE = "text-runs.json"

/** Format revision, so a reader can reject a payload it does not understand. */
export const TEXT_RUNS_VERSION = 1

export interface TextRun {
  /** Whitespace-normalized line text. Never empty. */
  text: string
  /** Bounding-box left/top, normalized 0..1 against the rendered image. */
  x: number
  y: number
  /** Bounding-box size, normalized the same way. */
  w: number
  h: number
}

interface TextRunsPayload {
  version: number
  runs: TextRun[]
}

/** Runs longer than this are legend blocks and general notes, never labels. */
const MAX_RUN_CHARS = 120
/** Hard cap: a sheet of schedules can carry thousands of lines. */
const MAX_RUNS = 4000

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * Encode runs for storage. Coordinates are rounded to 5 decimals — normalized
 * space against a ~5,000px raster, so that is sub-pixel and roughly halves the
 * payload against full float printing.
 */
export function encodeTextRuns(runs: TextRun[]): string {
  const round = (value: number) => Math.round(value * 1e5) / 1e5
  const payload: TextRunsPayload = {
    version: TEXT_RUNS_VERSION,
    runs: runs.slice(0, MAX_RUNS).map((run) => ({
      text: run.text.slice(0, MAX_RUN_CHARS),
      x: round(run.x),
      y: round(run.y),
      w: round(run.w),
      h: round(run.h),
    })),
  }
  return JSON.stringify(payload)
}

/**
 * Parse a stored `text-runs.json` body.
 *
 * Returns an empty array — never throws — on anything malformed. A sheet
 * without readable text positions is a sheet whose rooms stay unlabelled, not
 * a failed interpretation.
 */
export function parseTextRuns(body: string): TextRun[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const payload = parsed as Partial<TextRunsPayload>
  if (payload.version !== TEXT_RUNS_VERSION) return []
  if (!Array.isArray(payload.runs)) return []

  const runs: TextRun[] = []
  for (const raw of payload.runs) {
    if (!raw || typeof raw !== "object") continue
    const run = raw as Partial<TextRun>
    if (typeof run.text !== "string" || !run.text.trim()) continue
    if (!isFiniteNumber(run.x) || !isFiniteNumber(run.y)) continue
    if (!isFiniteNumber(run.w) || !isFiniteNumber(run.h)) continue
    runs.push({ text: run.text, x: run.x, y: run.y, w: run.w, h: run.h })
    if (runs.length >= MAX_RUNS) break
  }
  return runs
}

/** Center of a run's bounding box, in the same normalized space. */
export function textRunCenter(run: TextRun): { x: number; y: number } {
  return { x: run.x + run.w / 2, y: run.y + run.h / 2 }
}
