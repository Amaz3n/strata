/** Geometry width is not automatically the scheduled window-unit size. */
export const OPENING_WIDTH_BASES = ["source-linework", "connected-frame", "pane-span", "jamb-span", "wall-flank-span", "manual"] as const;
export type OpeningWidthBasis = (typeof OPENING_WIDTH_BASES)[number];

export function openingWidthNote(basis: OpeningWidthBasis | undefined): string {
  if (basis === "wall-flank-span") return "Width follows the gap between measured wall flanks. Jamb stops, clear passage and scheduled leaf size may differ; confirm the required wall opening.";
  if (basis === "jamb-span") return "Width follows the drawn wall jambs. Check the frame, scheduled unit size and required installation clearances.";
  if (basis === "connected-frame") return "Width follows the drawn outer frame. Check the scheduled window size and required wall opening; they may differ.";
  if (basis === "pane-span") return "Width follows the drawn glass span. Check the full frame and scheduled window size before accepting it.";
  if (basis === "manual") return "Width was entered manually. Check it against the scheduled size and required wall opening.";
  return "Width follows the drawing and has not been matched to a scheduled window size. Check the frame and required wall opening.";
}
