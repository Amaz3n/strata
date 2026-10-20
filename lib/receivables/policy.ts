import { isTradeProfile, type BusinessProfile } from "@/lib/business-profile"
import type { ProductTier, ProjectPosture } from "@/lib/product-tier"

export type ReceivablesApprovalMode = "direct" | "optional_review" | "required_review"

export interface ReceivablesPosturePolicy {
  posture: ProjectPosture
  customerLabel: string
  customerPluralLabel: string
  workspaceLabel: string
  billingRunLabel: string
  primaryBillingStory: "draw_or_cost" | "progress_application" | "deposit_or_closing"
  /** Label on the composer's primary send action. */
  sendActionLabel: string
  approvalMode: ReceivablesApprovalMode
  /** The customer certifies a pay application before its invoice issues. */
  certifiesPayApplications: boolean
  /** Who the pay application is addressed to on the document (AIA's "Owner" for builders). */
  documentCustomerLabel: string
  /** What the work is called on that document: "Project" for a builder, "Job" for a trade. */
  documentProjectLabel: string
  /** The job's agreed payment terms; null leaves the org default in charge. */
  paymentTermsDays: number | null
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
    sendActionLabel: "Send invoice",
    approvalMode: "optional_review",
    certifiesPayApplications: false,
    documentCustomerLabel: "Owner",
    documentProjectLabel: "Project",
    paymentTermsDays: null,
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
    sendActionLabel: "Send owner billing",
    approvalMode: "required_review",
    certifiesPayApplications: true,
    documentCustomerLabel: "Owner",
    documentProjectLabel: "Project",
    paymentTermsDays: null,
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
    sendActionLabel: "Send buyer invoice",
    approvalMode: "optional_review",
    certifiesPayApplications: false,
    documentCustomerLabel: "Owner",
    documentProjectLabel: "Project",
    paymentTermsDays: null,
    supportsProgressApplications: false,
    supportsRetainage: false,
    supportsBuyerDeposits: true,
    supportsClosingInvoices: true,
    collectionTone: "buyer",
  },
}

/** General customer billing has no job-specific retainage or closing workflow. */
const GENERAL_POLICY: ReceivablesPosturePolicy = { ...POLICIES.residential, customerLabel: "Customer", customerPluralLabel: "Customers", approvalMode: "optional_review", supportsRetainage: false }
export function getGeneralReceivablesPolicy(): ReceivablesPosturePolicy {
  return GENERAL_POLICY
}

/**
 * How a trade job bills its customer, chosen when the job is created and kept
 * on `project_financial_settings.metadata.receivables`. A builder's job has no
 * such record and keeps its posture policy.
 */
export interface JobReceivablesTerms {
  /** A builder or GC the trade works under, or the homeowner directly. */
  customerKind: "company" | "homeowner"
  paymentTermsDays: number | null
  /** Someone in the office approves each invoice before it goes out. */
  reviewBeforeSend: boolean
  /** The customer certifies each pay application before its invoice issues. */
  customerCertifies: boolean
}

export const DEFAULT_JOB_RECEIVABLES_TERMS: JobReceivablesTerms = {
  customerKind: "homeowner",
  paymentTermsDays: null,
  reviewBeforeSend: false,
  customerCertifies: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads the terms a job was set up with; anything missing keeps the default. */
export function readJobReceivablesTerms(metadata: unknown): JobReceivablesTerms {
  const stored = isRecord(metadata) && isRecord(metadata.receivables) ? metadata.receivables : {}
  const days = stored.payment_terms_days
  return {
    customerKind: stored.customer_kind === "company" ? "company" : "homeowner",
    paymentTermsDays: typeof days === "number" && Number.isInteger(days) && days >= 0 ? days : null,
    reviewBeforeSend: stored.review_before_send === true,
    customerCertifies: stored.customer_certifies === true,
  }
}

export function writeJobReceivablesTerms(terms: JobReceivablesTerms) {
  return {
    customer_kind: terms.customerKind,
    payment_terms_days: terms.paymentTermsDays,
    review_before_send: terms.reviewBeforeSend,
    customer_certifies: terms.customerCertifies,
  }
}

/**
 * A trade bills whoever hired it, on whatever the job says, whatever kind of
 * building it is. Posture still names the job; it no longer decides the
 * billing: a sub on a custom home sends the builder a pay application when the
 * job bills by schedule of values, and nobody is called an Owner or a Client.
 */
function tradeReceivablesPolicy(posture: ProjectPosture, terms: JobReceivablesTerms): ReceivablesPosturePolicy {
  const company = terms.customerKind === "company"
  return {
    posture,
    customerLabel: company ? "Builder" : "Customer",
    customerPluralLabel: company ? "Builders" : "Customers",
    workspaceLabel: "Customer receivables",
    billingRunLabel: "Build this billing",
    primaryBillingStory: "draw_or_cost",
    sendActionLabel: "Send invoice",
    approvalMode: terms.reviewBeforeSend ? "required_review" : "direct",
    certifiesPayApplications: terms.customerCertifies,
    documentCustomerLabel: company ? "Builder" : "Customer",
    documentProjectLabel: "Job",
    paymentTermsDays: terms.paymentTermsDays,
    // The job's billing basis turns pay applications on, not the posture.
    supportsProgressApplications: false,
    supportsRetainage: true,
    supportsBuyerDeposits: false,
    supportsClosingInvoices: false,
    collectionTone: company ? "contractual" : "relationship",
  }
}

/**
 * The receivables policy for one job: the business profile decides whose
 * billing story it is, the posture decides it only for a builder. Every
 * project-scoped receivables surface asks here.
 */
export function resolveReceivablesPolicy(input: {
  posture: ProjectPosture
  profile: BusinessProfile
  settingsMetadata?: unknown
}): ReceivablesPosturePolicy {
  if (!isTradeProfile(input.profile)) return POLICIES[input.posture]
  return tradeReceivablesPolicy(input.posture, readJobReceivablesTerms(input.settingsMetadata))
}

/** The org-wide receivables desk: a trade's customers are mixed, so they are Customers. */
export function resolveOrgReceivablesPolicy(input: { tier: ProductTier; profile: BusinessProfile }): ReceivablesPosturePolicy {
  if (!isTradeProfile(input.profile)) return POLICIES[input.tier]
  return tradeReceivablesPolicy(input.tier, DEFAULT_JOB_RECEIVABLES_TERMS)
}
