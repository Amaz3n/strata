type Sheet = { sheet_id: string; sheet_number: string }
export function duplicateIssuanceNumbers(
  sheets: Sheet[],
  decisions: Record<string, boolean> = {},
  edits: Record<string, { sheet_number?: string }> = {},
): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const sheet of sheets) {
    if (decisions[sheet.sheet_id] === false) continue
    const number = edits[sheet.sheet_id]?.sheet_number?.trim() || sheet.sheet_number
    if (seen.has(number)) duplicates.add(number)
    seen.add(number)
  }
  return [...duplicates]
}
export function issuanceNumberConflictMessage(numbers: string[]): string {
  return `Multiple included sheets use the same number: ${numbers.join(", ")}. Correct their sheet numbers or exclude duplicate pages before publishing.`
}
