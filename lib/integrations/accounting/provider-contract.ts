import type { AccountingProvider } from "@/lib/integrations/accounting/provider"

/** Registration fails early when a capability promises an operation it lacks. */
export function assertAccountingProviderContract(provider: AccountingProvider): void {
  const requirements: Array<[boolean, string, unknown]> = [
    [provider.capabilities.supportsCDC, "ingestChanges", provider.ingestChanges],
    [provider.capabilities.supportsImport, "previewImport", provider.previewImport],
    [provider.capabilities.supportsImport, "applyImport", provider.applyImport],
    [provider.capabilities.supportsVendorCredits, "pushVendorCredit", provider.pushVendorCredit],
    [provider.capabilities.supportsBillPaymentVoid, "voidBillPayment", provider.voidBillPayment],
    [provider.capabilities.supportsJournalEntryPush, "pushJournalEntry", provider.pushJournalEntry],
    [provider.capabilities.supportsAttachments, "uploadInvoiceAttachment", provider.uploadInvoiceAttachment],
  ]
  for (const [enabled, name, operation] of requirements) if (enabled && typeof operation !== "function") throw new Error(`${provider.key} advertises accounting capability without ${name}`)
}
