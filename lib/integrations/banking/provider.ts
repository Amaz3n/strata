export type BankFeedProviderKey = "plaid"

export type BankFeedAccount = {
  externalAccountId: string
  name: string
  officialName: string | null
  mask: string | null
  type: "depository" | "credit" | "loan" | "investment" | "other"
  subtype: string | null
  currency: string
  currentBalanceCents: number | null
  availableBalanceCents: number | null
}

export type BankFeedTransaction = {
  externalTransactionId: string
  externalAccountId: string
  lifecycleStatus: "pending" | "posted"
  transactionDate: string
  authorizedDate: string | null
  amountCents: number
  direction: "inflow" | "outflow"
  currency: string
  merchantName: string | null
  description: string
  pendingExternalId: string | null
  category: string[]
  raw: Record<string, unknown>
}

export type TransactionSyncPage = {
  added: BankFeedTransaction[]
  modified: BankFeedTransaction[]
  removedExternalIds: string[]
  nextCursor: string
  hasMore: boolean
}

export interface BankFeedProvider {
  key: BankFeedProviderKey
  createLinkToken(input: { clientUserId: string; organizationName: string; webhookUrl: string }): Promise<{ linkToken: string; expiresAt: string }>
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>
  listAccounts(accessToken: string): Promise<BankFeedAccount[]>
  syncTransactions(accessToken: string, cursor?: string | null): Promise<TransactionSyncPage>
  verifyWebhook(rawBody: string, verificationHeader: string | null): Promise<boolean>
}

