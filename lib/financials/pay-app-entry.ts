/** A focus/blur round trip is not an instruction to round the monetary value. */
export function changedPercentEntry(value: string, displayedValue: string): number | null {
  if (!value.trim() || value === displayedValue) return null
  const percent = Number(value)
  if (percent === Number(displayedValue)) return null
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null
  return percent
}

/** A stored-to-installed transfer is neutral to gross earned value. */
export function applyStoredMaterialMovement(input: {
  workCents: number; storedCents: number; addedCents: number; installedCents: number
}): { workCents: number; storedCents: number } {
  const { workCents, storedCents, addedCents, installedCents } = input
  if (![workCents, storedCents, addedCents, installedCents].every(Number.isSafeInteger) ||
      storedCents < 0 || addedCents < 0 || installedCents < 0 || installedCents > storedCents + addedCents) {
    throw new Error("Installed materials cannot exceed the available stored balance.")
  }
  return { workCents: workCents + installedCents, storedCents: storedCents + addedCents - installedCents }
}

export interface PayApplicationEntryDraft {
  this_period: string
  stored: string
  progress_evidence?: { source_bill_ids: string[]; suggested_percent_complete: number }
}

/** Manual changes to work detach a proposal; stored-only changes preserve it. */
export function mergePayApplicationEntry(current: PayApplicationEntryDraft, patch: Partial<PayApplicationEntryDraft>): PayApplicationEntryDraft {
  return {
    ...current,
    ...patch,
    ...(patch.this_period !== undefined && !patch.progress_evidence ? { progress_evidence: undefined } : {}),
  }
}
