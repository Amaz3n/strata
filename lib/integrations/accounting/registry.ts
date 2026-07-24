import type { AccountingProvider, AccountingProviderKey } from "@/lib/integrations/accounting/provider"
import { qboProvider } from "@/lib/integrations/accounting/qbo/adapter"

const providers: Record<AccountingProviderKey, AccountingProvider> = { qbo: qboProvider }

export function getProvider(key: AccountingProviderKey): AccountingProvider {
  return providers[key]
}

export function listProviders(): AccountingProvider[] {
  return Object.values(providers)
}

export function isAccountingProviderKey(value: string): value is AccountingProviderKey {
  return value in providers
}
