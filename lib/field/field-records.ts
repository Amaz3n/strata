/** Past this a band stops being scannable; the rest is counted, never hidden. */
export const FIELD_RECORDS_ROW_CAP = 8

export type FieldRecordsHouse = {
  projectId: string
  lastDailyLogDate: string | null
  newPhotoCount: number
}

/**
 * Which houses the cross-home review lists: no daily log today, or photos
 * nobody has logged since. Worst first (missing log, then most new photos),
 * capped at `cap`, with the number the cap hid so the page can say so.
 */
export function fieldRecordsRows<House extends FieldRecordsHouse>(
  houses: House[],
  today: string,
  cap = FIELD_RECORDS_ROW_CAP,
): { rows: Array<{ house: House; missingLog: boolean }>; hidden: number } {
  const needing = houses
    .map((house) => ({ house, missingLog: !house.lastDailyLogDate || house.lastDailyLogDate < today }))
    .filter((row) => row.missingLog || row.house.newPhotoCount > 0)
    .sort((a, b) => Number(b.missingLog) - Number(a.missingLog) || b.house.newPhotoCount - a.house.newPhotoCount
      || a.house.projectId.localeCompare(b.house.projectId))
  return { rows: needing.slice(0, cap), hidden: Math.max(0, needing.length - cap) }
}
