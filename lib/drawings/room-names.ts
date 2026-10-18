/** Shared room vocabulary: independent of either geometry consumer. */
export const ROOM_NAME_LEXICON: readonly string[] = [
  "ATTIC",
  "BALCONY",
  "BAR",
  "BASEMENT",
  "BATH",
  "BATHROOM",
  "BEDROOM",
  "BONUS",
  "BREAKFAST",
  "CABANA",
  "CLOSET",
  "COURTYARD",
  "COVERED",
  "DECK",
  "DEN",
  "DINETTE",
  "DINING",
  "ENTRY",
  "EXERCISE",
  "FAMILY",
  "FLEX",
  "FOYER",
  "GALLERY",
  "GAME",
  "GARAGE",
  "GREAT",
  "GUEST",
  "GYM",
  "HALL",
  "KITCHEN",
  "LANAI",
  "LAUNDRY",
  "LIBRARY",
  "LIVING",
  "LOFT",
  "MASTER",
  "MECH",
  "MECHANICAL",
  "MEDIA",
  "MUD",
  "MUDROOM",
  "NOOK",
  "NURSERY",
  "OFFICE",
  "OWNER",
  "PANTRY",
  "PATIO",
  "PLAYROOM",
  "PORCH",
  "POWDER",
  "PRIMARY",
  "SITTING",
  "STAIR",
  "STORAGE",
  "STUDY",
  "SUITE",
  "SUNROOM",
  "TERRACE",
  "THEATER",
  "UTILITY",
  "VESTIBULE",
  "WIC",
  "WORKSHOP",
] as const;

const LEXICON_SET = new Set(ROOM_NAME_LEXICON);

/** Dimension strings, scale notes, and keynotes are never room names. */
const DIMENSION_PATTERN = /\d+\s*['’]\s*-?\s*\d*\s*(?:["”]|$)/;
const SCALE_PATTERN = /scale|=\s*1['’]|n\.?t\.?s\.?/i;
const KEYNOTE_PATTERN = /^[A-Z]?\d+(\.\d+)?$/;

/**
 * Does this text run name a room? Returns the cleaned label, or null.
 *
 * Room tags carry their size on the same or the next line ("BEDROOM 2
 * 12'-0" × 11'-6""), so a trailing dimension is stripped rather than
 * disqualifying — but a run that is ONLY a dimension is rejected outright.
 */
export function roomLabelFromText(raw: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || text.length > 40) return null;
  if (SCALE_PATTERN.test(text)) return null;
  if (KEYNOTE_PATTERN.test(text)) return null;

  const cleaned = text
    .replace(
      /\s*\d+\s*['’]\s*-?\s*\d*\s*["”]?\s*[x×]\s*\d+\s*['’]\s*-?\s*\d*\s*["”]?\s*$/i,
      "",
    )
    .replace(/[.,:;]+$/, "")
    .trim();
  if (!cleaned) return null;
  if (DIMENSION_PATTERN.test(cleaned)) return null;

  const words = cleaned
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 4) return null;
  const matched = words.some(
    (word) =>
      LEXICON_SET.has(word) ||
      (word.length > 3 && LEXICON_SET.has(word.slice(0, -1))),
  );
  if (!matched) return null;
  return cleaned.slice(0, 40);
}
