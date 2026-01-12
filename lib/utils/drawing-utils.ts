import type { DrawingDiscipline } from "@/lib/validation/drawings"

/**
 * Discipline detection patterns for construction drawing sheet numbers.
 * Standard construction sheet numbering follows patterns like A-101, S-200, M-001.
 */
const DISCIPLINE_PATTERNS: Array<{ pattern: RegExp; discipline: DrawingDiscipline }> = [
  // Architectural - most common, check first
  { pattern: /^A[D]?[-./]?\d/i, discipline: "A" },
  { pattern: /^ARCH/i, discipline: "A" },

  // Structural
  { pattern: /^S[D]?[-./]?\d/i, discipline: "S" },
  { pattern: /^STR/i, discipline: "S" },

  // Mechanical
  { pattern: /^M[-./]?\d/i, discipline: "M" },
  { pattern: /^MECH/i, discipline: "M" },
  { pattern: /^HVAC/i, discipline: "M" },

  // Electrical
  { pattern: /^E[L]?[-./]?\d/i, discipline: "E" },
  { pattern: /^ELEC/i, discipline: "E" },

  // Plumbing
  { pattern: /^P[L]?[-./]?\d/i, discipline: "P" },
  { pattern: /^PLMB/i, discipline: "P" },
  { pattern: /^PLUM/i, discipline: "P" },

  // Fire Protection
  { pattern: /^F[PS][-./]?\d/i, discipline: "FP" },
  { pattern: /^FIRE/i, discipline: "FP" },

  // Civil
  { pattern: /^C[IV]?[-./]?\d/i, discipline: "C" },
  { pattern: /^CIV/i, discipline: "C" },

  // Landscape
  { pattern: /^L[A]?[-./]?\d/i, discipline: "L" },
  { pattern: /^LAND/i, discipline: "L" },

  // Interior
  { pattern: /^I[D]?[-./]?\d/i, discipline: "I" },
  { pattern: /^INT/i, discipline: "I" },

  // General/Title/Cover
  { pattern: /^G[-./]?\d/i, discipline: "G" },
  { pattern: /^T[-./]?\d/i, discipline: "T" },
  { pattern: /^GEN/i, discipline: "G" },
  { pattern: /^COVER/i, discipline: "T" },
  { pattern: /^TITLE/i, discipline: "T" },

  // Specifications
  { pattern: /^SP[-./]?\d/i, discipline: "SP" },
  { pattern: /^SPEC/i, discipline: "SP" },

  // Details
  { pattern: /^D[T]?[-./]?\d/i, discipline: "D" },
  { pattern: /^DTL/i, discipline: "D" },
  { pattern: /^DET/i, discipline: "D" },
]

/**
 * Detect the discipline of a drawing sheet based on its sheet number.
 * Uses standard construction industry naming conventions.
 *
 * @example
 * detectDiscipline('A-101')  // 'A' (Architectural)
 * detectDiscipline('S.200')  // 'S' (Structural)
 * detectDiscipline('M001')   // 'M' (Mechanical)
 * detectDiscipline('ELEC-1') // 'E' (Electrical)
 * detectDiscipline('random') // 'X' (Unknown)
 */
export function detectDiscipline(sheetNumber: string): DrawingDiscipline {
  if (!sheetNumber) return "X"

  const normalized = sheetNumber.trim().toUpperCase()

  for (const { pattern, discipline } of DISCIPLINE_PATTERNS) {
    if (pattern.test(normalized)) {
      return discipline
    }
  }

  return "X" // Unknown/Other
}

/**
 * Parse a sheet number into its components.
 *
 * @example
 * parseSheetNumber('A-101')
 * // { prefix: 'A', separator: '-', number: '101', suffix: '' }
 *
 * parseSheetNumber('A-101a')
 * // { prefix: 'A', separator: '-', number: '101', suffix: 'a' }
 */
export function parseSheetNumber(sheetNumber: string): {
  prefix: string
  separator: string
  number: string
  suffix: string
  discipline: DrawingDiscipline
} {
  const match = sheetNumber.match(/^([A-Za-z]+)([-./]?)(\d+)([A-Za-z]*)$/)

  if (!match) {
    return {
      prefix: "",
      separator: "",
      number: sheetNumber,
      suffix: "",
      discipline: "X",
    }
  }

  const [, prefix, separator, number, suffix] = match

  return {
    prefix: prefix.toUpperCase(),
    separator,
    number,
    suffix: suffix.toLowerCase(),
    discipline: detectDiscipline(sheetNumber),
  }
}

/**
 * Standard discipline sort order for construction drawings.
 * General/Title sheets first, then trades in typical order.
 */
export const DISCIPLINE_SORT_ORDER: DrawingDiscipline[] = [
  "G",  // General
  "T",  // Title/Cover
  "C",  // Civil
  "L",  // Landscape
  "A",  // Architectural
  "I",  // Interior
  "S",  // Structural
  "M",  // Mechanical
  "E",  // Electrical
  "P",  // Plumbing
  "FP", // Fire Protection
  "SP", // Specifications
  "D",  // Details
  "X",  // Other/Unknown
]

/**
 * Sort sheet numbers in natural order.
 * First by discipline (standard trade order), then by number.
 */
export function sortSheetNumbers(a: string, b: string): number {
  const parsedA = parseSheetNumber(a)
  const parsedB = parseSheetNumber(b)

  // First sort by discipline
  const disciplineCompare =
    DISCIPLINE_SORT_ORDER.indexOf(parsedA.discipline) -
    DISCIPLINE_SORT_ORDER.indexOf(parsedB.discipline)

  if (disciplineCompare !== 0) return disciplineCompare

  // Then by prefix (for same discipline with different prefixes)
  const prefixCompare = parsedA.prefix.localeCompare(parsedB.prefix)
  if (prefixCompare !== 0) return prefixCompare

  // Then by number (numeric sort)
  const numA = parseInt(parsedA.number, 10) || 0
  const numB = parseInt(parsedB.number, 10) || 0

  if (numA !== numB) return numA - numB

  // Then by suffix
  return parsedA.suffix.localeCompare(parsedB.suffix)
}

/**
 * Short discipline labels for badges and compact displays.
 */
export const DISCIPLINE_SHORT_LABELS: Record<DrawingDiscipline, string> = {
  A: "Arch",
  S: "Struct",
  M: "Mech",
  E: "Elec",
  P: "Plumb",
  FP: "Fire",
  C: "Civil",
  L: "Land",
  I: "Int",
  G: "Gen",
  T: "Title",
  SP: "Spec",
  D: "Detail",
  X: "Other",
}

/**
 * Discipline colors for visual differentiation.
 */
export const DISCIPLINE_COLORS: Record<DrawingDiscipline, string> = {
  A: "#3B82F6",  // Blue
  S: "#8B5CF6",  // Purple
  M: "#F97316",  // Orange
  E: "#EAB308",  // Yellow
  P: "#22C55E",  // Green
  FP: "#EF4444", // Red
  C: "#78716C",  // Stone
  L: "#22C55E",  // Green (same as plumbing but different shade)
  I: "#EC4899",  // Pink
  G: "#6B7280",  // Gray
  T: "#6B7280",  // Gray
  SP: "#6B7280", // Gray
  D: "#6B7280",  // Gray
  X: "#9CA3AF",  // Light gray
}

/**
 * Group sheets by discipline for organized display.
 */
export function groupSheetsByDiscipline<T extends { discipline?: DrawingDiscipline | null }>(
  sheets: T[]
): Map<DrawingDiscipline, T[]> {
  const groups = new Map<DrawingDiscipline, T[]>()

  // Initialize all disciplines in order
  for (const discipline of DISCIPLINE_SORT_ORDER) {
    groups.set(discipline, [])
  }

  // Group sheets
  for (const sheet of sheets) {
    const discipline = sheet.discipline ?? "X"
    const group = groups.get(discipline)
    if (group) {
      group.push(sheet)
    }
  }

  // Remove empty groups
  for (const [discipline, sheets] of groups) {
    if (sheets.length === 0) {
      groups.delete(discipline)
    }
  }

  return groups
}
