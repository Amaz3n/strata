import "server-only"

import { requireAuthorization, type AuthorizeInput } from "@/lib/services/authorization"

/** Books controls and statutory statements require visibility of the entire ledger. */
export async function requireBooksAuthorization(input: AuthorizeInput) {
  const decision = await requireAuthorization(input)
  if (input.permission.startsWith("books.") && decision.divisionScope === "assigned") {
    throw new Error("Arc Books requires organization-wide accounting access. Use project financials for assigned-division activity.")
  }
  return decision
}
