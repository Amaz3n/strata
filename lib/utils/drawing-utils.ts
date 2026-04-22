import {
  Bolt,
  Building2,
  Droplets,
  FileText,
  Flame,
  Layers3,
  Ruler,
  ScrollText,
  Sofa,
  TreePine,
  Wrench,
  type LucideIcon,
} from "lucide-react"
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
 * Tailwind gradient/border/text classes for a discipline chip.
 * Used in the drawings table and the drawing viewer for consistency.
 */
export const DISCIPLINE_GRADIENT_CLASSES: Record<string, string> = {
  G: "bg-gradient-to-br from-slate-500/10 to-slate-600/5 border-slate-500/30 text-slate-600 dark:from-slate-400/20 dark:to-slate-500/10 dark:border-slate-400/30 dark:text-slate-300",
  T: "bg-gradient-to-br from-zinc-500/10 to-zinc-600/5 border-zinc-500/30 text-zinc-600 dark:from-zinc-400/20 dark:to-zinc-500/10 dark:border-zinc-400/30 dark:text-zinc-300",
  A: "bg-gradient-to-br from-blue-500/10 to-blue-600/5 border-blue-500/30 text-blue-600 dark:from-blue-500/20 dark:to-blue-600/10 dark:border-blue-500/30 dark:text-blue-400",
  S: "bg-gradient-to-br from-purple-500/10 to-purple-600/5 border-purple-500/30 text-purple-600 dark:from-purple-500/20 dark:to-purple-600/10 dark:border-purple-500/30 dark:text-purple-400",
  M: "bg-gradient-to-br from-orange-500/10 to-orange-600/5 border-orange-500/30 text-orange-600 dark:from-orange-500/20 dark:to-orange-600/10 dark:border-orange-500/30 dark:text-orange-400",
  E: "bg-gradient-to-br from-amber-500/10 to-amber-600/5 border-amber-500/30 text-amber-600 dark:from-amber-500/20 dark:to-amber-600/10 dark:border-amber-500/30 dark:text-amber-400",
  P: "bg-gradient-to-br from-cyan-500/10 to-cyan-600/5 border-cyan-500/30 text-cyan-600 dark:from-cyan-500/20 dark:to-cyan-600/10 dark:border-cyan-500/30 dark:text-cyan-400",
  FP: "bg-gradient-to-br from-rose-500/10 to-rose-600/5 border-rose-500/30 text-rose-600 dark:from-rose-500/20 dark:to-rose-600/10 dark:border-rose-500/30 dark:text-rose-400",
  C: "bg-gradient-to-br from-emerald-500/10 to-teal-600/5 border-emerald-500/30 text-emerald-600 dark:from-emerald-500/20 dark:to-teal-600/10 dark:border-emerald-500/30 dark:text-emerald-400",
  L: "bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border-emerald-500/30 text-emerald-600 dark:from-emerald-500/20 dark:to-emerald-600/10 dark:border-emerald-500/30 dark:text-emerald-400",
  I: "bg-gradient-to-br from-violet-500/10 to-violet-600/5 border-violet-500/30 text-violet-600 dark:from-violet-500/20 dark:to-violet-600/10 dark:border-violet-500/30 dark:text-violet-400",
  SP: "bg-gradient-to-br from-fuchsia-500/10 to-fuchsia-600/5 border-fuchsia-500/30 text-fuchsia-600 dark:from-fuchsia-500/20 dark:to-fuchsia-600/10 dark:border-fuchsia-500/30 dark:text-fuchsia-400",
  D: "bg-gradient-to-br from-indigo-500/10 to-indigo-600/5 border-indigo-500/30 text-indigo-600 dark:from-indigo-500/20 dark:to-indigo-600/10 dark:border-indigo-500/30 dark:text-indigo-400",
  X: "bg-gradient-to-br from-muted/80 to-muted/30 border-border text-muted-foreground dark:from-muted/60 dark:to-muted/20 dark:border-border dark:text-muted-foreground",
}

export function disciplineGradientClass(code?: string | null) {
  if (!code) return DISCIPLINE_GRADIENT_CLASSES.X
  return DISCIPLINE_GRADIENT_CLASSES[code] ?? DISCIPLINE_GRADIENT_CLASSES.X
}

export function disciplineIcon(code?: string | null): LucideIcon {
  switch (code) {
    case "A":
      return Building2
    case "S":
      return Layers3
    case "M":
      return Wrench
    case "E":
      return Bolt
    case "P":
      return Droplets
    case "FP":
      return Flame
    case "C":
      return Ruler
    case "L":
      return TreePine
    case "I":
      return Sofa
    case "SP":
      return ScrollText
    case "D":
      return Ruler
    default:
      return FileText
  }
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
