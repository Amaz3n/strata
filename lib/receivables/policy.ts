import type { ProductTier, ProjectPosture } from "@/lib/product-tier"

export type ReceivablesApprovalMode = "direct" | "optional_review" | "required_review"

export interface ReceivablesPosturePolicy {
  posture: ProjectPosture
  customerLabel: string
  customerPluralLabel: string
  workspaceLabel: string
  billingRunLabel: string
  primaryBillingStory: "draw_or_cost" | "progress_application" | "deposit_or_closing"
  approvalMode: ReceivablesApprovalMode
  supportsProgressApplications: boolean
  supportsRetainage: boolean
  supportsBuyerDeposits: boolean
  supportsClosingInvoices: boolean
  collectionTone: "relationship" | "contractual" | "buyer"
}

const POLICIES: Record<ProjectPosture, ReceivablesPosturePolicy> = {
  residential: {
    posture: "residential",
    customerLabel: "Client",
    customerPluralLabel: "Clients",
    workspaceLabel: "Client receivables",
    billingRunLabel: "Build this billing",
    primaryBillingStory: "draw_or_cost",
    approvalMode: "optional_review",
    supportsProgressApplications: false,
    supportsRetainage: true,
    supportsBuyerDeposits: false,
    supportsClosingInvoices: false,
    collectionTone: "relationship",
  },
  commercial: {
    posture: "commercial",
    customerLabel: "Owner",
    customerPluralLabel: "Owners",
    workspaceLabel: "Owner receivables",
    billingRunLabel: "Build this pay application",
    primaryBillingStory: "progress_application",
    approvalMode: "required_review",
    supportsProgressApplications: true,
    supportsRetainage: true,
    supportsBuyerDeposits: false,
    supportsClosingInvoices: false,
    collectionTone: "contractual",
  },
  production: {
    posture: "production",
    customerLabel: "Buyer",
    customerPluralLabel: "Buyers",
    workspaceLabel: "Buyer receivables",
    billingRunLabel: "Build this closing statement",
    primaryBillingStory: "deposit_or_closing",
    approvalMode: "optional_review",
    supportsProgressApplications: false,
    supportsRetainage: false,
    supportsBuyerDeposits: true,
    supportsClosingInvoices: true,
    collectionTone: "buyer",
  },
}

/** Project posture wins over org tier so hybrid builders keep the right workflow. */
export function getReceivablesPosturePolicy(posture: ProjectPosture): ReceivablesPosturePolicy {
  return POLICIES[posture]
}

export function getOrgReceivablesPolicy(tier: ProductTier): ReceivablesPosturePolicy {
  return POLICIES[tier]
}

