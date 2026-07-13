"use client"

import { type ReactNode } from "react"
import { CheckCircle2, ClipboardCheck, FileCheck2, FileText, ListTree, ReceiptText } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { FeePresentation, ProjectBillingModel } from "@/lib/financials/billing-model"
import {
  defaultFeePresentationForBillingModel,
  normalizeFeePresentation,
  resolveProjectBillingModel,
} from "@/lib/financials/billing-model"
import type { Contract, Project } from "@/lib/types"
import type { ProjectInput } from "@/lib/validation/projects"
import { cn } from "@/lib/utils"
import type { ProjectPosture } from "@/lib/product-tier"
import { terminology } from "@/lib/terminology"

// Shared financial-setup form used as step 2 of the project create/edit sheets.
// Captures full parity with the legacy financial setup wizard: billing model,
// contract terms, and the four billing rules.
export type RetainageScheduleStepValue = {
  untilPercentComplete: string
  retainagePercent: string
}

export type FinancialSetupValue = {
  billingModel: ProjectBillingModel
  fixedPriceBillingBasis: "draws" | "progress"
  totalContractValue: string
  retainagePercent: string
  retainageAppliesToFee: boolean
  retainageSchedule: RetainageScheduleStepValue[]
  storedMaterialsRetainagePercent: string
  markupPercent: string
  fixedFee: string
  feePresentation: FeePresentation
  gmp: string
  contingency: string
  savingsSplitOwnerPct: string
  savingsSplitBuilderPct: string
  laborBurdenMultiplier: string
  rateScheduleId: string
  paidCostsRequired: boolean
  proofRequired: boolean
  clientCostApprovalRequired: boolean
  openBookRequired: boolean
  costCodesEnabled: boolean
}

export const billingModelOptions: Array<{ id: ProjectBillingModel; title: string; note: string }> = [
  { id: "fixed_price", title: "Fixed price", note: "Contract value, retainage, draw billing." },
  { id: "cost_plus_percent", title: "Cost plus %", note: "Approved costs plus markup." },
  { id: "cost_plus_fixed_fee", title: "Cost plus fixed fee", note: "Approved costs plus a fee amount." },
  { id: "cost_plus_gmp", title: "Cost plus GMP", note: "Approved costs under a guaranteed maximum." },
  { id: "time_and_materials", title: "Time & materials", note: "Labor, materials, and markup controls." },
]

export function billingModelOptionsForPosture(posture: ProjectPosture) {
  if (posture === "residential") return billingModelOptions
  const priority: ProjectBillingModel[] = [
    "fixed_price",
    "cost_plus_gmp",
    "cost_plus_percent",
    "cost_plus_fixed_fee",
    "time_and_materials",
  ]
  return priority.flatMap((model) => {
    const option = billingModelOptions.find((candidate) => candidate.id === model)
    return option ? [option] : []
  })
}

const feePresentationOptions: Array<{ id: FeePresentation; title: string; note: string }> = [
  { id: "embedded", title: "Embedded", note: "Markup stays inside each cost line." },
  { id: "separate_total", title: "Separate total", note: "One fee line for the invoice." },
  { id: "separate_by_code", title: "By cost code", note: "One fee line per cost-code group." },
]

export function isCostDrivenModel(model: ProjectBillingModel) {
  return model !== "fixed_price"
}

export function modelLabel(model: ProjectBillingModel) {
  return billingModelOptions.find((option) => option.id === model)?.title ?? model.replaceAll("_", " ")
}

function centsToMoney(value?: number | null) {
  if (value == null) return ""
  return (value / 100).toFixed(2)
}

function numberToField(value?: number | null, fallback = "") {
  if (value == null) return fallback
  return String(value)
}

function moneyToCents(value: string) {
  const cleaned = value.replace(/[$,\s]/g, "")
  if (!cleaned) return null
  const amount = Number(cleaned)
  if (!Number.isFinite(amount) || amount < 0) return null
  return Math.round(amount * 100)
}

function fieldToNumber(value: string, fallback: number | null = null) {
  const cleaned = value.trim()
  if (!cleaned) return fallback
  const amount = Number(cleaned)
  return Number.isFinite(amount) ? amount : fallback
}

// Strip a typed money string down to digits + a single decimal point.
function sanitizeMoneyInput(raw: string) {
  const cleaned = raw.replace(/[^\d.]/g, "")
  const firstDot = cleaned.indexOf(".")
  if (firstDot === -1) return cleaned
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "")
}

// Display the stored raw money string with thousands separators (decimals preserved while typing).
function displayMoneyInput(raw: string) {
  if (!raw) return ""
  const [intPart, ...rest] = raw.split(".")
  const groupedInt = (intPart || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return rest.length > 0 ? `${groupedInt}.${rest.join("")}` : groupedInt
}

export function emptyFinancialSetup(
  model: ProjectBillingModel = "fixed_price",
  posture: ProjectPosture = "residential",
): FinancialSetupValue {
  const costDriven = isCostDrivenModel(model)
  return {
    billingModel: model,
    fixedPriceBillingBasis: posture === "commercial" ? "progress" : "draws",
    retainageSchedule: [],
    storedMaterialsRetainagePercent: "",
    totalContractValue: "",
    retainagePercent: posture === "commercial" ? "10" : "0",
    retainageAppliesToFee: false,
    markupPercent: costDriven ? "0" : "",
    fixedFee: "",
    feePresentation: defaultFeePresentationForBillingModel(model),
    gmp: "",
    contingency: "",
    savingsSplitOwnerPct: "0",
    savingsSplitBuilderPct: "0",
    laborBurdenMultiplier: "1",
    rateScheduleId: "",
    paidCostsRequired: false,
    proofRequired: false,
    clientCostApprovalRequired: false,
    openBookRequired: costDriven,
    costCodesEnabled: true,
  }
}

export function financialSetupFromProject(project: Project, contract?: Contract | null): FinancialSetupValue {
  const billingContract = contract ?? project.billing_contract ?? null
  const billingModel = resolveProjectBillingModel(project, billingContract)
  const costDriven = isCostDrivenModel(billingModel)
  const contractSnapshot = (billingContract?.snapshot ?? {}) as Record<string, any>
  const legacyFixedFeeCents =
    typeof contractSnapshot.fixed_fee_cents === "number" ? contractSnapshot.fixed_fee_cents : null
  const legacyContingencyCents =
    typeof contractSnapshot.contingency_cents === "number" ? contractSnapshot.contingency_cents : null
  const totalCents =
    (typeof contractSnapshot.base_total_cents === "number" ? contractSnapshot.base_total_cents : null) ??
    billingContract?.total_cents ??
    (typeof project.total_contract_value_cents === "number" ? project.total_contract_value_cents : null) ??
    (typeof project.total_value === "number" ? Math.round(project.total_value * 100) : null)

  return {
    billingModel,
    fixedPriceBillingBasis:
      project.financial_settings?.fixed_price_billing_basis === "progress" ? "progress" : "draws",
    retainageSchedule: Array.isArray(billingContract?.retainage_schedule)
      ? billingContract.retainage_schedule.map((step) => ({
          untilPercentComplete: numberToField(step.until_percent_complete),
          retainagePercent: numberToField(step.retainage_percent),
        }))
      : [],
    storedMaterialsRetainagePercent: numberToField(billingContract?.stored_materials_retainage_percent),
    totalContractValue: centsToMoney(totalCents),
    retainagePercent: numberToField(billingContract?.retainage_percent ?? project.retainage_percent, "0"),
    retainageAppliesToFee: Boolean(billingContract?.retainage_applies_to_fee ?? contractSnapshot.retainage_applies_to_fee ?? false),
    markupPercent: numberToField(billingContract?.markup_percent, costDriven ? "0" : ""),
    fixedFee: centsToMoney(billingContract?.fixed_fee_cents ?? legacyFixedFeeCents),
    feePresentation:
      normalizeFeePresentation(billingContract?.fee_presentation) ??
      normalizeFeePresentation(contractSnapshot.fee_presentation) ??
      "embedded",
    gmp: centsToMoney(billingContract?.gmp_cents),
    contingency: centsToMoney(billingContract?.contingency_cents ?? legacyContingencyCents),
    savingsSplitOwnerPct: numberToField(billingContract?.savings_split_owner_pct, "0"),
    savingsSplitBuilderPct: numberToField(billingContract?.savings_split_builder_pct, "0"),
    laborBurdenMultiplier: numberToField(billingContract?.labor_burden_multiplier, "1"),
    rateScheduleId: billingContract?.rate_schedule_id ?? contractSnapshot.rate_schedule_id ?? "",
    paidCostsRequired: Boolean(contractSnapshot.paid_costs_required ?? false),
    proofRequired: Boolean(contractSnapshot.proof_required ?? false),
    clientCostApprovalRequired: Boolean(billingContract?.requires_client_cost_approval ?? false),
    openBookRequired: billingContract?.open_book ?? costDriven,
    costCodesEnabled: project.financial_settings?.cost_codes_enabled ?? true,
  }
}

// Side effects when the billing model changes (markup default, open-book default).
export function applyBillingModel(value: FinancialSetupValue, model: ProjectBillingModel): FinancialSetupValue {
  const costDriven = isCostDrivenModel(model)
  return {
    ...value,
    billingModel: model,
    markupPercent: costDriven && !value.markupPercent ? "0" : value.markupPercent,
    feePresentation: defaultFeePresentationForBillingModel(model),
    openBookRequired: costDriven ? true : false,
  }
}

export function validateFinancialSetup(value: FinancialSetupValue): { blocking: string[]; warnings: string[] } {
  const blocking: string[] = []
  const warnings: string[] = []
  const retainage = fieldToNumber(value.retainagePercent)
  const markup = fieldToNumber(value.markupPercent)
  const ownerSplit = fieldToNumber(value.savingsSplitOwnerPct, 0) ?? 0
  const builderSplit = fieldToNumber(value.savingsSplitBuilderPct, 0) ?? 0
  const laborBurden = fieldToNumber(value.laborBurdenMultiplier)

  if (value.totalContractValue.trim() && moneyToCents(value.totalContractValue) == null) {
    blocking.push("Contract value must be a valid non-negative amount.")
  }
  if (retainage == null || retainage < 0 || retainage > 100) {
    blocking.push("Retainage must be between 0% and 100%.")
  }
  if (isCostDrivenModel(value.billingModel) && (markup == null || markup < 0 || markup > 200)) {
    blocking.push("Markup must be between 0% and 200%.")
  }
  if (value.billingModel === "fixed_price" && !moneyToCents(value.totalContractValue)) {
    warnings.push("Fixed-price projects should carry a contract value for draw billing and WIP.")
  }
  if (value.billingModel === "cost_plus_gmp" && !moneyToCents(value.gmp)) {
    blocking.push("Cost-plus GMP requires a GMP amount.")
  }
  if (value.billingModel === "cost_plus_gmp" && value.contingency.trim() && moneyToCents(value.contingency) == null) {
    blocking.push("GMP contingency must be a valid non-negative amount.")
  }
  if (value.billingModel === "cost_plus_fixed_fee" && !moneyToCents(value.fixedFee)) {
    blocking.push("Cost-plus fixed fee requires a fixed fee amount.")
  }
  if (ownerSplit + builderSplit > 100) {
    blocking.push("Savings split percentages cannot exceed 100%.")
  }
  if (laborBurden == null || laborBurden < 1) {
    blocking.push("Labor burden multiplier must be 1.0 or higher.")
  }
  if (isCostDrivenModel(value.billingModel) && !value.openBookRequired) {
    warnings.push("Cost-driven billing is most trustworthy when open-book billing is enabled.")
  }
  if (value.billingModel === "fixed_price" && value.fixedPriceBillingBasis === "progress") {
    let lastUntil = 0
    for (const step of value.retainageSchedule) {
      const until = fieldToNumber(step.untilPercentComplete)
      const percent = fieldToNumber(step.retainagePercent)
      if (until == null || until <= lastUntil || until > 100) {
        blocking.push("Retainage steps must have increasing thresholds between 1% and 100%.")
        break
      }
      if (percent == null || percent < 0 || percent > 100) {
        blocking.push("Retainage step rates must be between 0% and 100%.")
        break
      }
      lastUntil = until
    }
    const storedPct = value.storedMaterialsRetainagePercent.trim()
      ? fieldToNumber(value.storedMaterialsRetainagePercent)
      : 0
    if (storedPct == null || storedPct < 0 || storedPct > 100) {
      blocking.push("Stored-materials retainage must be between 0% and 100%.")
    }
  }

  return { blocking, warnings }
}

// Merge financial setup into the ProjectInput payload the create/update actions expect.
export function financialSetupToProjectInput(value: FinancialSetupValue): Partial<ProjectInput> {
  const costDriven = isCostDrivenModel(value.billingModel)
  const isGmp = value.billingModel === "cost_plus_gmp"
  const isFixedFee = value.billingModel === "cost_plus_fixed_fee"
  const usesMarkup =
    value.billingModel === "cost_plus_percent" || isGmp || value.billingModel === "time_and_materials"
  const showFeePresentation = costDriven && value.billingModel !== "time_and_materials"

  const isFixedPrice = value.billingModel === "fixed_price"
  const progressBilling = isFixedPrice && value.fixedPriceBillingBasis === "progress"
  const retainageSchedule = progressBilling
    ? value.retainageSchedule
        .map((step) => ({
          until_percent_complete: fieldToNumber(step.untilPercentComplete) ?? 0,
          retainage_percent: fieldToNumber(step.retainagePercent) ?? 0,
        }))
        .filter((step) => step.until_percent_complete > 0)
    : []

  return {
    billing_model: value.billingModel,
    fixed_price_billing_basis: isFixedPrice ? value.fixedPriceBillingBasis : null,
    retainage_schedule: retainageSchedule.length > 0 ? retainageSchedule : null,
    stored_materials_retainage_percent:
      progressBilling && value.storedMaterialsRetainagePercent.trim()
        ? fieldToNumber(value.storedMaterialsRetainagePercent)
        : null,
    contract_type:
      value.billingModel === "time_and_materials" ? "time_materials" : costDriven ? "cost_plus" : "fixed",
    total_contract_value_cents: moneyToCents(value.totalContractValue),
    retainage_percent: fieldToNumber(value.retainagePercent, 0) ?? 0,
    retainage_applies_to_fee: value.retainageAppliesToFee,
    markup_percent: usesMarkup ? fieldToNumber(value.markupPercent, 0) : null,
    gmp_cents: isGmp ? moneyToCents(value.gmp) : null,
    contingency_cents: isGmp ? moneyToCents(value.contingency) : null,
    fixed_fee_cents: isFixedFee ? moneyToCents(value.fixedFee) : null,
    fee_presentation: value.feePresentation,
    savings_split_owner_pct: isGmp ? fieldToNumber(value.savingsSplitOwnerPct, 0) : 0,
    savings_split_builder_pct: isGmp ? fieldToNumber(value.savingsSplitBuilderPct, 0) : 0,
    labor_burden_multiplier: fieldToNumber(value.laborBurdenMultiplier, 1) ?? 1,
    rate_schedule_id: value.billingModel === "time_and_materials" ? value.rateScheduleId || null : null,
    open_book: value.openBookRequired,
    requires_client_cost_approval: value.clientCostApprovalRequired,
    paid_costs_required: value.paidCostsRequired,
    proof_required: value.proofRequired,
    cost_codes_enabled: value.costCodesEnabled,
  }
}

export function ProjectFinancialSetupFields({
  value,
  onChange,
  posture = "residential",
}: {
  value: FinancialSetupValue
  onChange: (value: FinancialSetupValue) => void
  posture?: ProjectPosture
}) {
  const costDriven = isCostDrivenModel(value.billingModel)
  const isGmp = value.billingModel === "cost_plus_gmp"
  const isFixedFee = value.billingModel === "cost_plus_fixed_fee"
  const usesMarkup =
    value.billingModel === "cost_plus_percent" || isGmp || value.billingModel === "time_and_materials"
  const showFeePresentation = costDriven && value.billingModel !== "time_and_materials"

  function update<K extends keyof FinancialSetupValue>(key: K, next: FinancialSetupValue[K]) {
    onChange({ ...value, [key]: next })
  }

  const terms = terminology(posture)
  const options = billingModelOptionsForPosture(posture)
  const rules = [
    { id: "openBookRequired" as const, title: "Open book", detail: "Expose approved cost detail for cost-driven billing.", icon: FileText },
    { id: "clientCostApprovalRequired" as const, title: `${terms.owner} time approval`, detail: `Require ${terms.owner.toLowerCase()} approval before approved labor time can be billed.`, icon: ClipboardCheck },
    { id: "paidCostsRequired" as const, title: "Paid costs only", detail: "Block billing unpaid vendor bill costs.", icon: ReceiptText },
    { id: "proofRequired" as const, title: "Proof required", detail: "Require receipts, bills, or time attachments before billing.", icon: FileCheck2 },
  ]

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Billing model</h3>
          <p className="text-xs text-muted-foreground">Drives invoicing, WIP, contract terms, and guardrails.</p>
        </div>
        <div className="grid gap-2">
          {options.map((option) => {
            const active = option.id === value.billingModel
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => onChange(applyBillingModel(value, option.id))}
                className={cn(
                  "flex items-start justify-between gap-3 rounded-md border p-3 text-left transition-colors",
                  active ? "border-primary bg-primary/5" : "border-border/70 hover:bg-muted/40",
                )}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{option.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{option.note}</span>
                </span>
                {active ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : null}
              </button>
            )
          })}
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Contract terms</h3>
          <p className="text-xs text-muted-foreground">Stored on the active contract used by financial pages.</p>
        </div>
        {value.billingModel === "fixed_price" ? (
          <div className="space-y-2">
            <Label>Owner billing</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  { id: "draws" as const, title: "Draw schedule", note: "Milestone draws billed as they come due." },
                  {
                    id: "progress" as const,
                    title: "Progress billing (SOV)",
                    note: "Monthly pay applications against a schedule of values.",
                  },
                ]
              ).map((option) => {
                const active = value.fixedPriceBillingBasis === option.id
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => update("fixedPriceBillingBasis", option.id)}
                    className={cn(
                      "rounded-md border p-3 text-left transition-colors",
                      active ? "border-primary bg-primary/5" : "border-border/70 hover:bg-muted/40",
                    )}
                  >
                    <span className="block text-sm font-medium">{option.title}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{option.note}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={costDriven ? "Contract value or cap" : "Contract value"} htmlFor="fin-contract-value">
            <MoneyInput id="fin-contract-value" value={value.totalContractValue} onChange={(next) => update("totalContractValue", next)} />
          </Field>
          <Field label="Retainage %" htmlFor="fin-retainage">
            <PercentInput id="fin-retainage" value={value.retainagePercent} onChange={(next) => update("retainagePercent", next)} />
          </Field>
          {value.billingModel === "fixed_price" && value.fixedPriceBillingBasis === "progress" ? (
            <div className="space-y-3 rounded-md border p-3 sm:col-span-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Label className="text-sm font-medium">Stepped retainage</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Optional: reduce the rate as lines reach completion thresholds (e.g. 10% until 50%, then 5%).
                    Leave empty to hold the flat retainage rate.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    update("retainageSchedule", [
                      ...value.retainageSchedule,
                      { untilPercentComplete: "", retainagePercent: "" },
                    ])
                  }
                >
                  Add step
                </Button>
              </div>
              {value.retainageSchedule.map((step, index) => (
                <div key={index} className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Until</span>
                  <PercentInput
                    id={`fin-ret-step-until-${index}`}
                    value={step.untilPercentComplete}
                    onChange={(next) =>
                      update(
                        "retainageSchedule",
                        value.retainageSchedule.map((current, i) =>
                          i === index ? { ...current, untilPercentComplete: next } : current,
                        ),
                      )
                    }
                  />
                  <span className="text-xs text-muted-foreground">complete, hold</span>
                  <PercentInput
                    id={`fin-ret-step-rate-${index}`}
                    value={step.retainagePercent}
                    onChange={(next) =>
                      update(
                        "retainageSchedule",
                        value.retainageSchedule.map((current, i) =>
                          i === index ? { ...current, retainagePercent: next } : current,
                        ),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-muted-foreground"
                    onClick={() =>
                      update(
                        "retainageSchedule",
                        value.retainageSchedule.filter((_, i) => i !== index),
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Field label="Stored-materials retainage % (blank = same rate as work)" htmlFor="fin-stored-retainage">
                <PercentInput
                  id="fin-stored-retainage"
                  value={value.storedMaterialsRetainagePercent}
                  onChange={(next) => update("storedMaterialsRetainagePercent", next)}
                />
              </Field>
            </div>
          ) : null}
          {costDriven ? (
            <div className="flex items-center justify-between gap-4 rounded-md border p-3 sm:col-span-2">
              <div className="min-w-0">
                <Label htmlFor="retainageAppliesToFee" className="text-sm font-medium">
                  Apply retainage to fee
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">Hold retainage on {terms.fee.toLowerCase()} and markup lines.</p>
              </div>
              <Switch
                id="retainageAppliesToFee"
                checked={value.retainageAppliesToFee}
                onCheckedChange={(checked) => update("retainageAppliesToFee", checked)}
              />
            </div>
          ) : null}
          {usesMarkup ? (
            <Field label="Default markup %" htmlFor="fin-markup">
              <PercentInput id="fin-markup" value={value.markupPercent} onChange={(next) => update("markupPercent", next)} />
            </Field>
          ) : null}
          {costDriven ? (
            <Field label="Labor burden multiplier" htmlFor="fin-labor-burden">
              <Input
                id="fin-labor-burden"
                inputMode="decimal"
                value={value.laborBurdenMultiplier}
                onChange={(event) => update("laborBurdenMultiplier", event.target.value)}
                placeholder="1"
              />
            </Field>
          ) : null}
          {value.billingModel === "time_and_materials" ? (
            <Field label="Rate schedule ID" htmlFor="fin-rate-schedule">
              <Input
                id="fin-rate-schedule"
                value={value.rateScheduleId}
                onChange={(event) => update("rateScheduleId", event.target.value)}
                placeholder="Assign from Settings > Billing Rates"
              />
            </Field>
          ) : null}
          {isFixedFee ? (
            <Field label="Fixed fee" htmlFor="fin-fixed-fee">
              <MoneyInput id="fin-fixed-fee" value={value.fixedFee} onChange={(next) => update("fixedFee", next)} />
            </Field>
          ) : null}
          {isGmp ? (
            <>
              <Field label="GMP amount" htmlFor="fin-gmp">
                <MoneyInput id="fin-gmp" value={value.gmp} onChange={(next) => update("gmp", next)} />
              </Field>
              <Field label="Contingency" htmlFor="fin-contingency">
                <MoneyInput id="fin-contingency" value={value.contingency} onChange={(next) => update("contingency", next)} />
              </Field>
              <Field label="Owner savings split %" htmlFor="fin-owner-split">
                <PercentInput id="fin-owner-split" value={value.savingsSplitOwnerPct} onChange={(next) => update("savingsSplitOwnerPct", next)} />
              </Field>
              <Field label="Builder savings split %" htmlFor="fin-builder-split">
                <PercentInput id="fin-builder-split" value={value.savingsSplitBuilderPct} onChange={(next) => update("savingsSplitBuilderPct", next)} />
              </Field>
            </>
          ) : null}
          {showFeePresentation ? (
            <div className="space-y-2 sm:col-span-2">
              <Label>Fee presentation</Label>
              <div className="grid gap-2 sm:grid-cols-3">
                {feePresentationOptions.map((option) => {
                  const active = value.feePresentation === option.id
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => update("feePresentation", option.id)}
                      className={cn(
                        "rounded-md border p-3 text-left transition-colors",
                        active ? "border-primary bg-primary/5" : "border-border/70 hover:bg-muted/40",
                      )}
                    >
                      <span className="block text-sm font-medium">{option.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{option.note}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Cost structure</h3>
          <p className="text-xs text-muted-foreground">Controls whether this project uses cost code coding on financial pages.</p>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div className="flex min-w-0 items-start gap-3">
            <ListTree className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <Label htmlFor="costCodesEnabled" className="text-sm font-medium">
                Use cost codes
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">Show cost code columns and require coding before cost review.</p>
            </div>
          </div>
          <Switch
            id="costCodesEnabled"
            checked={value.costCodesEnabled}
            onCheckedChange={(checked) => update("costCodesEnabled", checked)}
          />
        </div>
      </section>

      {costDriven ? (
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Billing rules</h3>
            <p className="text-xs text-muted-foreground">These controls gate approved-cost invoicing and contract behavior.</p>
          </div>
          <div className="divide-y rounded-md border">
            {rules.map((rule) => {
              const Icon = rule.icon
              return (
                <div key={rule.id} className="flex items-center justify-between gap-4 p-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <Label htmlFor={rule.id} className="text-sm font-medium">
                        {rule.title}
                      </Label>
                      <p className="mt-0.5 text-xs text-muted-foreground">{rule.detail}</p>
                    </div>
                  </div>
                  <Switch
                    id={rule.id}
                    checked={Boolean(value[rule.id])}
                    onCheckedChange={(checked) => update(rule.id, checked)}
                  />
                </div>
              )
            })}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

function MoneyInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-muted-foreground">$</span>
      <Input
        id={id}
        inputMode="decimal"
        className="pl-7"
        value={displayMoneyInput(value)}
        onChange={(event) => onChange(sanitizeMoneyInput(event.target.value))}
        placeholder="0.00"
      />
    </div>
  )
}

function PercentInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <Input
        id={id}
        inputMode="decimal"
        className="pr-7"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="0"
      />
      <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-sm text-muted-foreground">%</span>
    </div>
  )
}
