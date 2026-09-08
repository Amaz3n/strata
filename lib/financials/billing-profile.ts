import { accountingExperience, type FinancialAccountingMode, type FinancialLedgerMode } from "@/lib/financials/accounting-experience"
import type { OwnerBillingBasis, ProjectBillingModel, ProjectFinancialFeatureConfig } from "@/lib/financials/billing-model"
import type { ProjectPosture } from "@/lib/product-tier"
import type { ReceivablesPosturePolicy } from "@/lib/receivables/policy"

/**
 * How a project bills, resolved once.
 *
 * The billing page used to read the feature config, the posture policy and a
 * handful of "is there any data" conditions in five places and grow a tab for
 * each answer. This is the one place those questions are asked. It is pure so a
 * mixed org — a custom home and a purchase-agreement house side by side — gets a
 * different profile per project from the same code path.
 */

/** The planned billing events a project can have waiting in its Up next band. */
export type BillingUpNextSource = "draws" | "periods" | "fee" | "pay_apps" | "retainage" | "deposit" | "closing"

/** Setup surfaces that open from the page but are not the page. */
export type BillingManageSurface = "draws" | "sov" | "retainage" | "recurring"

export type BillingPrimaryActionKind = "new_invoice" | "new_pay_application"

export interface BillingProfile {
  posture: ProjectPosture
  billingModel: ProjectBillingModel
  basis: OwnerBillingBasis
  customerLabel: string
  customerPluralLabel: string
  sendActionLabel: string
  /** Sources the Up next band should query. Order is display order. */
  sources: BillingUpNextSource[]
  manageSurfaces: BillingManageSurface[]
  primaryAction: { kind: BillingPrimaryActionKind; label: string }
  /** Commercial owner billing has to be approved before it can be issued. */
  approvalRequired: boolean
  supportsRetainage: boolean
  /** Cost-driven models bill approved costs; the composer's cost picker is only offered there. */
  costDriven: boolean
  /** The owner is billed by pay application against a schedule of values. */
  progressBilling: boolean
}

/**
 * What the project already has on the books. The feature config says how a
 * project is SUPPOSED to bill; these say what it actually did. A commercial
 * job whose settings still say "draws" but that carries a schedule of values
 * and three pay applications bills by pay application, and the book must show
 * them — hiding a surface because a setting lags the data is how "I can't see
 * my pay apps" happens.
 */
export interface BillingProfileFacts {
  hasSov: boolean
  hasPayApplications: boolean
}

export const EMPTY_BILLING_FACTS: BillingProfileFacts = { hasSov: false, hasPayApplications: false }

export function resolveBillingProfile(input: {
  featureConfig: ProjectFinancialFeatureConfig
  policy: ReceivablesPosturePolicy
  facts?: BillingProfileFacts
}): BillingProfile {
  const { featureConfig, policy } = input
  const facts = input.facts ?? EMPTY_BILLING_FACTS
  const basis = featureConfig.ownerBillingBasis
  const costDriven =
    basis === "costs" || basis === "costs_plus_fee" || basis === "time_materials"

  const sources: BillingUpNextSource[] = []
  const manageSurfaces: BillingManageSurface[] = []

  // Progress billing is on when the settings say so, when the data says so, or
  // when the posture's whole billing story is the pay application (commercial):
  // a commercial GC with no SOV yet still needs the surface that creates one.
  const progressBilling =
    basis === "progress" ||
    facts.hasSov ||
    facts.hasPayApplications ||
    (basis === "draws" && policy.supportsProgressApplications)

  if (basis === "draws" && !progressBilling) {
    sources.push("draws")
    manageSurfaces.push("draws")
  }
  if (progressBilling) {
    sources.push("pay_apps")
    manageSurfaces.push("sov")
  }
  if (costDriven) sources.push("periods")
  if (featureConfig.billingModel === "cost_plus_fixed_fee") sources.push("fee")
  if (basis === "closing") {
    sources.push("deposit", "closing")
  }
  if (policy.supportsRetainage) {
    sources.push("retainage")
    manageSurfaces.push("retainage")
  }

  return {
    posture: policy.posture,
    billingModel: featureConfig.billingModel,
    basis,
    customerLabel: policy.customerLabel,
    customerPluralLabel: policy.customerPluralLabel,
    sendActionLabel: policy.sendActionLabel,
    sources,
    manageSurfaces,
    primaryAction:
      progressBilling
        ? { kind: "new_pay_application", label: "New pay application" }
        : { kind: "new_invoice", label: "New invoice" },
    approvalRequired: policy.approvalMode === "required_review",
    supportsRetainage: policy.supportsRetainage,
    costDriven,
    progressBilling,
  }
}

/**
 * The org AR desk reads every project's invoices but plans none of their
 * billing, so it has no Up next sources and no setup surfaces.
 */
export function resolveOrgBillingProfile(policy: ReceivablesPosturePolicy): BillingProfile {
  return {
    posture: policy.posture,
    billingModel: "fixed_price",
    basis: "draws",
    customerLabel: policy.customerLabel,
    customerPluralLabel: policy.customerPluralLabel,
    sendActionLabel: policy.sendActionLabel,
    sources: [],
    manageSurfaces: [],
    primaryAction: { kind: "new_invoice", label: "New invoice" },
    approvalRequired: policy.approvalMode === "required_review",
    supportsRetainage: policy.supportsRetainage,
    costDriven: false,
    progressBilling: false,
  }
}

/**
 * Where the org keeps its books, as far as receivables care.
 *
 * `official` means Arc Books is the ledger and an invoice's accounting truth is
 * its journal entry. `external` means a connected provider (QuickBooks today) is
 * the ledger and the truth is the sync record. `parallel` and `shadow` are the
 * cutover states where both exist and the external one still governs.
 */
export type ReceivablesLedgerMode = FinancialLedgerMode
export type ReceivablesAccountingMode = FinancialAccountingMode

export function receivablesLabels(mode: ReceivablesAccountingMode) {
  return accountingExperience(mode)
}
