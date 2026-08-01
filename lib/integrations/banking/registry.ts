import type { BankFeedProvider, BankFeedProviderKey } from "@/lib/integrations/banking/provider"
import { plaidBankFeedProvider } from "@/lib/integrations/banking/plaid"

const providers = new Map<BankFeedProviderKey, BankFeedProvider>([["plaid", plaidBankFeedProvider]])

export function getBankFeedProvider(key: BankFeedProviderKey) {
  const provider = providers.get(key)
  if (!provider) throw new Error(`Unsupported bank-feed provider: ${key}`)
  return provider
}

