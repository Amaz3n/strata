export const BOOKS_POLICY_VERSION = 1

export const BOOKS_POLICY_V1 = {
  version: BOOKS_POLICY_VERSION,
  currency: "usd",
  basis: "accrual",
  revenueRecognition: "percentage_of_completion",
  retainage: {
    customer: "separate_receivable",
    vendor: "separate_payable",
  },
  customerDeposits: "liability_until_earned",
  corrections: "reversal_and_repost",
  closedPeriodCorrections: "next_open_period",
  externalAuthoritative: {
    inboundAllowed: true,
    outboundAllowed: true,
  },
  arcAuthoritativeMirror: {
    inboundAllowed: false,
    outboundAllowed: true,
  },
} as const

