/**
 * What a drawing sheet's revision is to the people building from it. A sheet
 * has one current revision; every earlier published revision is superseded, and
 * a revision still being processed or awaiting its reviewer's publish is an
 * unreviewed copy nobody may build from yet.
 */
export type DrawingReleaseState = "current" | "superseded" | "pending_review"

export const DRAWING_RELEASE_STATE_LABELS: Record<DrawingReleaseState, string> = {
  current: "Current",
  superseded: "Superseded",
  pending_review: "Pending review",
}

const STATE_ORDER: Record<DrawingReleaseState, number> = { current: 0, pending_review: 1, superseded: 2 }

export function drawingReleaseState(input: {
  revisionId: string
  revisionStatus: string
  sheetCurrentRevisionId: string | null
}): DrawingReleaseState {
  if (input.revisionStatus !== "published") return "pending_review"
  return input.sheetCurrentRevisionId === input.revisionId ? "current" : "superseded"
}

/** Sheet number, then current before pending before superseded, newest revision first within a state. */
export function compareReleasedSheets(
  a: { sheetNumber: string; state: DrawingReleaseState; issuedAt: string },
  b: { sheetNumber: string; state: DrawingReleaseState; issuedAt: string },
): number {
  return a.sheetNumber.localeCompare(b.sheetNumber, undefined, { numeric: true })
    || STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || b.issuedAt.localeCompare(a.issuedAt)
}
