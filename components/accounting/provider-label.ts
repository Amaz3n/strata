import { ACCOUNTING_PROVIDERS } from "@/lib/integrations/accounting/catalog"
import type { AccountingProviderKey } from "@/lib/integrations/accounting/provider"

/**
 * Short marks for dense chips and id prefixes. Keyed by provider so adding an
 * adapter fails the build here instead of silently rendering "QBO" for it.
 */
const SHORT_LABELS: Record<AccountingProviderKey, string> = {
  qbo: "QBO",
  file: "Export",
}

/**
 * Label for surfaces that genuinely cannot know which provider is connected.
 * Derived from the catalog so the string lives in exactly one place.
 */
export const DEFAULT_ACCOUNTING_PROVIDER_LABEL = "Accounting"

export function isAccountingProviderKey(value: string | null | undefined): value is AccountingProviderKey {
  return typeof value === "string" && value in ACCOUNTING_PROVIDERS
}

/**
 * Display name for a connected accounting provider. `provider` is the provider
 * key from the connection; `fallback` is a connection label for providers that
 * are not in the catalog (Arc Books) or connections carrying a custom name.
 */
export function accountingProviderLabel(provider?: string | null, fallback?: string | null): string {
  if (provider === "arc_books") return "Arc Books"
  if (isAccountingProviderKey(provider)) return ACCOUNTING_PROVIDERS[provider].name
  const trimmed = fallback?.trim()
  return trimmed ? trimmed : DEFAULT_ACCOUNTING_PROVIDER_LABEL
}

/** Short form of {@link accountingProviderLabel}, for chips and id prefixes. */
export function accountingProviderShortLabel(provider?: string | null, fallback?: string | null): string {
  if (provider === "arc_books") return "Arc Books"
  if (isAccountingProviderKey(provider)) return SHORT_LABELS[provider]
  const trimmed = fallback?.trim()
  return trimmed ? trimmed : "Accounting"
}
