/**
 * Which sheets of a drawing set are floor plans, and the per-level input the
 * shared building engine reads from each.
 *
 * Pure and client-safe. Tested in tests/floorplan-model.test.js.
 */

import type { TextRun } from "@/lib/drawings/text-runs";

export interface InterpretLevelInput {
  region?: { x0: number; y0: number; x1: number; y1: number };
  scaleConfirmed?: boolean;
  sheetVersionId: string;
  sheetNumber: string | null;
  sheetTitle: string | null;
  name: string;
  order: number;
  imageWidth: number;
  imageHeight: number;
  /** Real-world feet per rendered-image pixel; required and must be > 0. */
  feetPerImagePx: number;
  /** Flat normalized [x0, y0, x1, y1, ...] exactly as `vectors.bin` stores it. */
  segments: ArrayLike<number>;
  /** Per-segment attribute flags from vectors.bin v2, or null for v1. */
  flags: ArrayLike<number> | null;
  textRuns: TextRun[];
  ceilingHeightFt?: number;
}

/** Sheet titles a floorplan goes by. Elevations and sections must not match. */
const FLOORPLAN_TITLE_PATTERN =
  /\b(?:floor\s*plan|first\s*floor|second\s*floor|third\s*floor|main\s*(?:floor|level)|upper\s*(?:floor|level)|lower\s*(?:floor|level)|ground\s*floor|basement\s*plan|loft\s*plan)\b/i;
/** Sheets that mention a plan but are never one. */
const NOT_FLOORPLAN_PATTERN =
  /\b(?:roof|foundation|footing|site|plot|plat|electrical|plumbing|mechanical|hvac|framing|truss|reflected\s*ceiling|elevation|section|detail|schedule|landscape|drainage|grading)\b/i;

export interface SheetCandidate {
  sheetVersionId: string;
  sheetNumber: string | null;
  sheetTitle: string | null;
  discipline: string | null;
  pageIndex: number;
  roomSizedLoopCount: number;
  hasVectors: boolean;
}

export interface SelectedSheet extends SheetCandidate {
  levelName: string;
  order: number;
  /** Why it was picked — surfaced in the UI so a wrong pick is explicable. */
  reason: string;
}

/** Level order implied by a sheet's title, lowest floor first. */
function levelOrderFromTitle(
  title: string,
): { order: number; name: string } | null {
  const text = title.toLowerCase();
  if (/basement|lower\s*(?:floor|level)/.test(text))
    return { order: -1, name: "Basement" };
  if (/first\s*floor|main\s*(?:floor|level)|ground\s*floor/.test(text))
    return { order: 0, name: "First Floor" };
  if (/second\s*floor|upper\s*(?:floor|level)/.test(text))
    return { order: 1, name: "Second Floor" };
  if (/third\s*floor/.test(text)) return { order: 2, name: "Third Floor" };
  if (/loft/.test(text)) return { order: 2, name: "Loft" };
  return null;
}

/**
 * Pick the floorplan sheets out of a plan set.
 *
 * Two independent signals have to agree: the sheet SAYS it is a floor plan
 * (discipline A, a title that names a floor, and no roof/electrical/elevation
 * word), and it LOOKS like one (the extractor already closed three or more
 * room-sized loops on it). Requiring both is what keeps the reflected ceiling
 * plan and the foundation plan out, and both of those would otherwise produce
 * a plausible, wrong house.
 */
export function selectFloorplanSheets(
  candidates: SheetCandidate[],
): SelectedSheet[] {
  const scored = candidates
    .map((candidate) => {
      const title =
        `${candidate.sheetNumber ?? ""} ${candidate.sheetTitle ?? ""}`.trim();
      const titled = FLOORPLAN_TITLE_PATTERN.test(title);
      const excluded = NOT_FLOORPLAN_PATTERN.test(title);
      const architectural = (candidate.discipline ?? "")
        .toUpperCase()
        .startsWith("A");
      return { candidate, title, titled, excluded, architectural };
    })
    .filter((entry) => entry.titled && !entry.excluded)
    .sort(
      (a, b) =>
        b.candidate.roomSizedLoopCount - a.candidate.roomSizedLoopCount ||
        a.candidate.pageIndex - b.candidate.pageIndex,
    );

  if (scored.length === 0) return [];

  const used = new Set<number>();
  const selected: SelectedSheet[] = [];
  for (const entry of scored) {
    const named = levelOrderFromTitle(entry.title);
    const order = named?.order ?? 0;
    // Alternatives/duplicates are presented in preparation, never invented
    // as extra storeys. Explicit source selections override this suggestion.
    if (used.has(order)) continue;
    used.add(order);
    selected.push({
      ...entry.candidate,
      levelName:
        named?.name ?? entry.candidate.sheetTitle ?? `Level ${order + 1}`,
      order,
      reason: `${entry.architectural ? "Discipline A, " : ""}title names a floor; ${entry.candidate.hasVectors ? "vector drawing" : "image tracing required"}`,
    });
  }

  return selected
    .sort((a, b) => a.order - b.order || a.pageIndex - b.pageIndex)
    .map((sheet, index) => ({ ...sheet, order: index }));
}
