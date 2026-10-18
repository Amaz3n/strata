/** Recipient identity comes from the token's request, never from submitted roles. */
export function assertWaiverRecipientEmail(assignedEmail: unknown, submittedEmail: string) {
  const assigned = typeof assignedEmail === "string" ? assignedEmail.trim().toLowerCase() : ""
  if (!assigned || assigned !== submittedEmail.trim().toLowerCase()) {
    throw new Error("This signature request is assigned to a different email address")
  }
}

export function requiresWaiverCompanyMember(signerRole: string) {
  return signerRole === "claimant"
}

export function waiverRecipientConsent(signerRole: string) {
  return `${requiresWaiverCompanyMember(signerRole) ? "I am authorized to sign this waiver for my company. " : ""}I have reviewed this document, agree to electronic records and signatures, and intend my signature to be legally binding.`
}
