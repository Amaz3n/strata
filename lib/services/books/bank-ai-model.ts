export type RawBankAiSuggestion = {
  transactionId: string
  accountId: string | null
  vendorId: string | null
  confidence: number
  rationale: string
}

export function completeBankAiBatch(transactionIds: string[], suggestions: RawBankAiSuggestion[]) {
  const expected = new Set(transactionIds)
  const returned = new Set(suggestions.map((row) => row.transactionId))
  return suggestions.length === expected.size && returned.size === expected.size && [...expected].every((id) => returned.has(id))
}

export function validatedBankAiIds(
  suggestion: RawBankAiSuggestion | undefined,
  allowedAccountIds: Set<string>,
  allowedVendorIds: Set<string>,
) {
  const confident = (suggestion?.confidence ?? 0) >= 0.75
  return {
    accountId: confident && suggestion?.accountId && allowedAccountIds.has(suggestion.accountId) ? suggestion.accountId : null,
    vendorId: confident && suggestion?.vendorId && allowedVendorIds.has(suggestion.vendorId) ? suggestion.vendorId : null,
  }
}

export function bankAiRetryState(input: {
  status: "pending" | "completed" | "failed"
  attemptCount: number
  unavailable: boolean
}) {
  if (input.status === "completed") return { shouldCallModel: false, attemptCount: input.attemptCount }
  if (input.unavailable) return { shouldCallModel: false, attemptCount: Math.max(0, input.attemptCount - 1) }
  return { shouldCallModel: input.attemptCount < 3, attemptCount: input.attemptCount }
}
