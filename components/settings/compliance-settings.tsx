"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"

import {
  updateComplianceRulesAction,
  updateDefaultComplianceRequirementsAction,
} from "@/app/(app)/settings/compliance/actions"
import { Plus } from "@/components/icons"
import { SettingsError, SettingsField, SettingsGroup, SettingsToggle } from "@/components/settings/settings-section"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { unwrapAction } from "@/lib/action-result"
import type { ComplianceDocumentType, ComplianceRequirementTemplateItem, ComplianceRules } from "@/lib/types"

const CONTAINER = "mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8"

const MIN_PREQUAL_DAYS = 30
const MAX_PREQUAL_DAYS = 1825

/** Coverage minimums and endorsements only mean something on an insurance certificate. */
function isInsuranceDoc(code: string) {
  return code.includes("coi") || code.includes("insurance") || code.includes("umbrella")
}

const ENDORSEMENTS = [
  { key: "requires_additional_insured", label: "Additional insured" },
  { key: "requires_primary_noncontributory", label: "Primary & non-contributory" },
  { key: "requires_waiver_of_subrogation", label: "Waiver of subrogation" },
] as const

type EndorsementKey = (typeof ENDORSEMENTS)[number]["key"]

/** Integer-dollar digit string -> grouped display, e.g. "1000000" -> "1,000,000". */
function groupDollars(digits: string) {
  return digits ? Number(digits).toLocaleString("en-US") : ""
}

/**
 * Warn and block are stored as two independent flags, but they describe one
 * escalating choice — a vendor with missing docs is either ignored, flagged, or
 * stopped. Blocking wins when both are set.
 */
type SubcontractMode = "allow" | "warn" | "block"

const SUBCONTRACT_MODES: { value: SubcontractMode; label: string; description: string }[] = [
  { value: "allow", label: "Allow", description: "Subcontracts and sub change orders send without a compliance check." },
  { value: "warn", label: "Warn", description: "Arc flags the missing documents but still lets you send for signature." },
  { value: "block", label: "Block", description: "Sending for signature is blocked until the vendor is compliant." },
]

function readSubcontractMode(rules: ComplianceRules): SubcontractMode {
  if (rules.block_subcontract_execution_on_missing_docs) return "block"
  if (rules.warn_subcontract_execution_on_missing_docs) return "warn"
  return "allow"
}

function requirementSummary(item: ComplianceRequirementTemplateItem | undefined, insurance: boolean) {
  if (!item) return null
  const parts: string[] = []
  if (insurance && item.min_coverage_cents) {
    parts.push(`$${Math.round(item.min_coverage_cents / 100).toLocaleString("en-US")} minimum`)
  }
  if (insurance) {
    for (const endorsement of ENDORSEMENTS) {
      if (item[endorsement.key]) parts.push(endorsement.label)
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

export function ComplianceSettings({
  initialRules,
  initialRequirementDefaults,
  documentTypes,
  canManage,
}: {
  initialRules: ComplianceRules
  initialRequirementDefaults: ComplianceRequirementTemplateItem[]
  documentTypes: ComplianceDocumentType[]
  canManage: boolean
}) {
  const [rules, setRules] = useState<ComplianceRules>(initialRules)
  const [savingRules, setSavingRules] = useState(false)
  const [requirements, setRequirements] = useState<ComplianceRequirementTemplateItem[]>(initialRequirementDefaults)
  const [editingTypeId, setEditingTypeId] = useState<string | null>(null)
  const [prequalDays, setPrequalDays] = useState(String(initialRules.prequalification_validity_days ?? 365))
  const [prequalError, setPrequalError] = useState<string | null>(null)

  const byTypeId = useMemo(() => {
    const map = new Map<string, ComplianceRequirementTemplateItem>()
    for (const item of requirements) map.set(item.document_type_id, item)
    return map
  }, [requirements])

  // Document order comes from the catalog (system types first, then alphabetical), so a
  // save never reshuffles the list.
  const requiredDocs = documentTypes.filter((type) => byTypeId.has(type.id))
  const availableDocs = documentTypes.filter((type) => !byTypeId.has(type.id))
  const editingDoc = documentTypes.find((type) => type.id === editingTypeId) ?? null

  const disabled = !canManage || savingRules

  /** Every rule change persists the whole object; a failure puts the control back. */
  const persistRules = (next: ComplianceRules) => {
    const previous = rules
    setRules(next)
    setSavingRules(true)
    void (async () => {
      try {
        setRules(unwrapAction(await updateComplianceRulesAction(next)))
      } catch (error) {
        setRules(previous)
        setPrequalDays(String(previous.prequalification_validity_days ?? 365))
        toast.error("Couldn't save that change", {
          description: error instanceof Error ? error.message : "We put the setting back the way it was.",
        })
      } finally {
        setSavingRules(false)
      }
    })()
  }

  /** Requirements are stored as one array on the org — every edit writes the whole set.
   *  Entries for document types that are no longer active pass through untouched. */
  const persistRequirements = async (next: ComplianceRequirementTemplateItem[]): Promise<string | null> => {
    try {
      const saved = unwrapAction(await updateDefaultComplianceRequirementsAction(next))
      setRequirements(saved ?? next)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : "Unable to save this requirement."
    }
  }

  const commitPrequalDays = () => {
    const saved = rules.prequalification_validity_days ?? 365
    const parsed = Number.parseInt(prequalDays, 10)
    if (!Number.isFinite(parsed) || parsed < MIN_PREQUAL_DAYS || parsed > MAX_PREQUAL_DAYS) {
      setPrequalError(`Enter a number of days between ${MIN_PREQUAL_DAYS} and ${MAX_PREQUAL_DAYS}.`)
      setPrequalDays(String(saved))
      return
    }
    setPrequalError(null)
    setPrequalDays(String(parsed))
    if (parsed === saved) return
    persistRules({ ...rules, prequalification_validity_days: parsed })
  }

  const subcontractMode = readSubcontractMode(rules)
  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || availableDocs.length === 0}
          title={availableDocs.length === 0 ? "Every document type is already required." : undefined}
        >
          <Plus className="mr-1.5 size-3.5" />
          Add document
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {availableDocs.map((type) => (
          <DropdownMenuItem key={type.id} onSelect={() => setEditingTypeId(type.id)}>
            <span className="min-w-0 flex-1 truncate">{type.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div className={CONTAINER}>
      <SettingsGroup
        title="Required documents"
        description="The baseline every vendor must satisfy before work and money move. Per-vendor additions and waivers live on the vendor's record in Directory."
        action={documentTypes.length > 0 ? addMenu : null}
      >
        {documentTypes.length === 0 ? (
          <div className="py-6">
            <p className="text-sm leading-5 text-foreground">No document types yet</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Arc seeds a standard set — insurance, licenses, W-9, lien waivers — when an organization is created. Contact
              support if this list is empty.
            </p>
          </div>
        ) : requiredDocs.length === 0 ? (
          <div className="py-6">
            <p className="text-sm leading-5 text-foreground">Nothing required org-wide</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Vendors are only checked against requirements set on their own record. Add a document to hold every vendor to
              the same baseline.
            </p>
          </div>
        ) : (
          requiredDocs.map((type) => {
            const item = byTypeId.get(type.id)
            const summary = requirementSummary(item, isInsuranceDoc(type.code))
            return (
              <SettingsField key={type.id} label={type.name} hint={type.description ?? undefined}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm leading-6 text-foreground">
                      {summary ?? <span className="text-muted-foreground">Required — no conditions</span>}
                    </p>
                    {item?.notes ? (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.notes}</p>
                    ) : null}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => setEditingTypeId(type.id)}
                    disabled={!canManage}
                  >
                    Edit
                  </Button>
                </div>
              </SettingsField>
            )
          })
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Enforcement"
        description="What Arc does when a vendor is missing a required document. Applies across every project."
      >
        <SettingsToggle
          id="compliance-block-payment"
          label="Hold payments to non-compliant vendors"
          description="Vendor payments are blocked while a required document is missing or expired. Active waivers and per-vendor overrides still apply."
          checked={rules.block_payment_on_missing_docs ?? false}
          onCheckedChange={(checked) => persistRules({ ...rules, block_payment_on_missing_docs: checked })}
          disabled={disabled}
        />
        <SettingsToggle
          id="compliance-require-lien-waiver"
          label="Require a signed lien waiver"
          description="A vendor payment can't be released until a signed waiver is on file for it."
          checked={rules.require_lien_waiver ?? false}
          onCheckedChange={(checked) => persistRules({ ...rules, require_lien_waiver: checked })}
          disabled={disabled}
        />
        <SettingsField
          label="Subcontract execution"
          hint="When you send a subcontract or sub change order to a vendor with missing documents."
        >
          <div className="space-y-2">
            <ToggleGroup
              type="single"
              variant="outline"
              value={subcontractMode}
              onValueChange={(value) => {
                if (!value) return
                persistRules({
                  ...rules,
                  warn_subcontract_execution_on_missing_docs: value === "warn",
                  block_subcontract_execution_on_missing_docs: value === "block",
                })
              }}
              disabled={disabled}
              className="grid w-full max-w-sm grid-cols-3"
              aria-label="Subcontract execution"
            >
              {SUBCONTRACT_MODES.map((mode) => (
                <ToggleGroupItem key={mode.value} value={mode.value} className="h-9 px-2 text-sm">
                  {mode.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="min-h-5 text-xs leading-5 text-muted-foreground">
              {SUBCONTRACT_MODES.find((mode) => mode.value === subcontractMode)?.description}
            </p>
          </div>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup
        title="Prequalification"
        description="How Arc treats a vendor's financial and safety prequalification when you commit work to them."
      >
        <SettingsToggle
          id="compliance-block-commitment"
          label="Block commitments over the prequal limit"
          description="Stops approval when a vendor's prequalification is missing, expired, or the commitment exceeds their single-job limit. When off, Arc warns and accepts an override note."
          checked={rules.block_commitment_on_prequal ?? false}
          onCheckedChange={(checked) => persistRules({ ...rules, block_commitment_on_prequal: checked })}
          disabled={disabled}
        />
        <SettingsField
          label="Valid for"
          htmlFor="compliance-prequal-days"
          hint="How long a completed prequalification counts before the vendor has to requalify."
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                id="compliance-prequal-days"
                type="number"
                inputMode="numeric"
                min={MIN_PREQUAL_DAYS}
                max={MAX_PREQUAL_DAYS}
                className="h-9 w-24 tabular-nums"
                value={prequalDays}
                disabled={disabled}
                onChange={(event) => {
                  setPrequalDays(event.target.value)
                  setPrequalError(null)
                }}
                onBlur={commitPrequalDays}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur()
                }}
              />
              <span className="text-sm text-muted-foreground">days</span>
            </div>
            {prequalError ? <SettingsError>{prequalError}</SettingsError> : null}
          </div>
        </SettingsField>
      </SettingsGroup>

      {canManage ? (
        <p className="text-xs text-muted-foreground">
          Vendor documents, expirations, and waivers are tracked in{" "}
          <Link href="/directory" className="font-medium text-primary hover:underline">
            Directory
          </Link>
          .
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Only organization admins can change compliance settings.</p>
      )}

      {editingDoc ? (
        <RequirementDialog
          key={editingDoc.id}
          documentType={editingDoc}
          item={byTypeId.get(editingDoc.id) ?? null}
          onOpenChange={(open) => {
            if (!open) setEditingTypeId(null)
          }}
          onSave={(item) =>
            persistRequirements([...requirements.filter((row) => row.document_type_id !== item.document_type_id), item])
          }
          onRemove={() =>
            persistRequirements(requirements.filter((row) => row.document_type_id !== editingDoc.id))
          }
        />
      ) : null}
    </div>
  )
}

/**
 * Editing always happens here rather than inline, so a half-typed coverage minimum
 * never reaches the org baseline. Adding and editing are the same dialog — the only
 * difference is whether Remove is offered.
 */
function RequirementDialog({
  documentType,
  item,
  onOpenChange,
  onSave,
  onRemove,
}: {
  documentType: ComplianceDocumentType
  item: ComplianceRequirementTemplateItem | null
  onOpenChange: (open: boolean) => void
  onSave: (item: ComplianceRequirementTemplateItem) => Promise<string | null>
  onRemove: () => Promise<string | null>
}) {
  const insurance = isInsuranceDoc(documentType.code)
  const [coverage, setCoverage] = useState(
    item?.min_coverage_cents ? String(Math.round(item.min_coverage_cents / 100)) : "",
  )
  const [endorsements, setEndorsements] = useState<Record<EndorsementKey, boolean>>({
    requires_additional_insured: Boolean(item?.requires_additional_insured),
    requires_primary_noncontributory: Boolean(item?.requires_primary_noncontributory),
    requires_waiver_of_subrogation: Boolean(item?.requires_waiver_of_subrogation),
  })
  const [notes, setNotes] = useState(item?.notes ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<"save" | "remove" | null>(null)

  const submit = async () => {
    setPending("save")
    setError(null)
    const coverageDollars = Number.parseInt(coverage, 10)
    const result = await onSave({
      document_type_id: documentType.id,
      is_required: true,
      min_coverage_cents:
        insurance && Number.isFinite(coverageDollars) && coverageDollars > 0 ? coverageDollars * 100 : undefined,
      requires_additional_insured: insurance && endorsements.requires_additional_insured,
      requires_primary_noncontributory: insurance && endorsements.requires_primary_noncontributory,
      requires_waiver_of_subrogation: insurance && endorsements.requires_waiver_of_subrogation,
      notes: notes.trim() || undefined,
    })
    setPending(null)
    if (result) {
      setError(result)
      return
    }
    toast.success(item ? `${documentType.name} updated` : `${documentType.name} is now required`)
    onOpenChange(false)
  }

  const remove = async () => {
    setPending("remove")
    setError(null)
    const result = await onRemove()
    setPending(null)
    if (result) {
      setError(result)
      return
    }
    toast.success(`${documentType.name} is no longer required`)
    onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{documentType.name}</DialogTitle>
          <DialogDescription>
            {documentType.description ??
              (documentType.has_expiry
                ? `Tracked with an expiry date — Arc warns ${documentType.expiry_warning_days} days ahead.`
                : "Required from every vendor unless waived on their record.")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {insurance ? (
            <>
              <div className="space-y-2">
                <label htmlFor="requirement-coverage" className="microlabel">
                  Minimum coverage
                </label>
                <div className="relative w-44">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="requirement-coverage"
                    inputMode="numeric"
                    placeholder="1,000,000"
                    className="h-9 pl-6 tabular-nums"
                    value={groupDollars(coverage)}
                    onChange={(event) => {
                      setCoverage(event.target.value.replace(/[^\d]/g, ""))
                      setError(null)
                    }}
                    disabled={pending !== null}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Leave empty to accept any coverage amount on the certificate.
                </p>
              </div>

              <div className="space-y-2">
                <span className="microlabel">Required endorsements</span>
                <div className="space-y-2 pt-0.5">
                  {ENDORSEMENTS.map((endorsement) => (
                    <label
                      key={endorsement.key}
                      htmlFor={`requirement-${endorsement.key}`}
                      className="flex items-center gap-2.5 text-sm leading-5 text-foreground"
                    >
                      <Checkbox
                        id={`requirement-${endorsement.key}`}
                        checked={endorsements[endorsement.key]}
                        onCheckedChange={(checked) =>
                          setEndorsements((previous) => ({ ...previous, [endorsement.key]: checked === true }))
                        }
                        disabled={pending !== null}
                      />
                      {endorsement.label}
                    </label>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          <div className="space-y-2">
            <label htmlFor="requirement-notes" className="microlabel">
              Note
            </label>
            <Textarea
              id="requirement-notes"
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value)
                setError(null)
              }}
              placeholder="Shown to vendors and reviewers alongside this requirement."
              maxLength={1000}
              className="min-h-20"
              disabled={pending !== null}
            />
          </div>

          {error ? <SettingsError>{error}</SettingsError> : null}
        </div>

        <DialogFooter className="sm:justify-between">
          {item ? (
            <Button
              variant="ghost"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={() => void remove()}
              disabled={pending !== null}
            >
              {pending === "remove" ? "Removing…" : "Remove"}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending !== null}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={pending !== null}>
              {pending === "save" ? "Saving…" : item ? "Save" : "Add requirement"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
