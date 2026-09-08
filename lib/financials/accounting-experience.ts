/** Presentation policy shared by every money workspace. Never authorizes writes. */
export type FinancialLedgerMode = "official" | "parallel" | "shadow" | "external" | "none" | "unavailable"

export interface FinancialAccountingMode {
  ledger: FinancialLedgerMode
  external: { provider: string; label: string; healthy?: boolean } | null
  externalSyncPosture?: "normal" | "outbound_mirror" | "disconnected"
}

export const UNAVAILABLE_ACCOUNTING_MODE: FinancialAccountingMode = { ledger: "unavailable", external: null }

export function accountingExperience(mode: FinancialAccountingMode) {
  const official = mode.ledger === "official"
  const showBooks = official || mode.ledger === "parallel" || mode.ledger === "shadow"
  const showExternalSync = mode.external !== null && mode.externalSyncPosture !== "disconnected" &&
    (!official || mode.externalSyncPosture === "outbound_mirror")
  return {
    official,
    showBooks,
    showExternalSync,
    canRequestExternalSync: showExternalSync && ["external", "parallel", "shadow"].includes(mode.ledger) && mode.external?.healthy !== false,
    title: official ? "Arc Books" : mode.external?.label ?? (showBooks ? "Arc Books preview" : "Accounting"),
    recordPayment: official ? "Receive payment" : "Record payment",
    accountingState: official ? "Posting" : "Sync",
    description: official
      ? "Arc Books is your accounting ledger. Posting and reconciliation happen here."
      : mode.ledger === "parallel"
        ? `${mode.external?.label ?? "Your external accounting system"} remains your ledger while you compare your books in Arc.`
        : mode.ledger === "shadow"
          ? "Arc Books is in preview. Your external accounting records remain authoritative."
          : mode.ledger === "unavailable"
            ? "Accounting status could not be verified. Refresh before relying on posting or sync status."
            : mode.external
              ? `Arc manages the project; ${mode.external.label} maintains your accounting ledger.`
              : "Choose Arc Books or connect your accounting platform in Settings.",
  }
}
