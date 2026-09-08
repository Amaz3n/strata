import { assertAccountingProviderContract } from "@/lib/integrations/accounting/provider-contract"
import type { AccountingProvider, AccountingProviderKey } from "@/lib/integrations/accounting/provider"
import { fileProvider } from "@/lib/integrations/accounting/file/adapter"
import { qboProvider } from "@/lib/integrations/accounting/qbo/adapter"

const providers: Record<AccountingProviderKey, AccountingProvider> = { qbo: qboProvider, file: fileProvider }

export function getProvider(key: AccountingProviderKey): AccountingProvider {
  const provider = providers[key]
  if (!provider) throw new Error(`Unknown accounting provider: ${key}`)
  assertAccountingProviderContract(provider)
  return provider
}

export function listProviders(): AccountingProvider[] {
  return Object.values(providers)
}

export function isAccountingProviderKey(value: string): value is AccountingProviderKey {
  return value in providers
}
