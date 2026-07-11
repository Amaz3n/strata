"use client"

import { useEffect, useMemo, useState, useTransition } from "react"

import type { ComplianceRequirementTemplateItem, ComplianceRules, ComplianceDocumentType } from "@/lib/types"
import {
  updateComplianceRulesAction,
  updateDefaultComplianceRequirementsAction,
} from "@/app/(app)/settings/compliance/actions"
import { listComplianceDocumentTypesAction } from "@/app/(app)/companies/actions"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
import {
  BadgeCheck,
  Ban,
  Check,
  ChevronDown,
  ClipboardCheck,
  FileText,
  Loader2,
  Lock,
  Plus,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from "@/components/icons"

import { unwrapAction } from "@/lib/action-result"

function isInsuranceDoc(code: string) {
  return code.includes("coi") || code.includes("insurance") || code.includes("umbrella")
}

function docIcon(code: string): LucideIcon {
  if (isInsuranceDoc(code)) return ShieldCheck
  if (code.includes("license") || code.includes("registration")) return BadgeCheck
  if (code.includes("lien") || code.includes("waiver")) return ClipboardCheck
  return FileText
}

/** Integer-dollar digit string -> grouped display, e.g. "1000000" -> "1,000,000". */
function groupDollars(digits: string) {
  return digits ? Number(digits).toLocaleString("en-US") : ""
}

function RequirementChip({
  active,
  label,
  onClick,
  disabled,
}: {
  active: boolean
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        active
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border/70 bg-background text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      <Check className={cn("size-3 shrink-0 transition-opacity", active ? "opacity-100" : "opacity-30")} />
      {label}
    </button>
  )
}

type DraftSnapshot = {
  selected: Record<string, boolean>
  notes: Record<string, string>
  minCoverage: Record<string, string>
  requiresAdditionalInsured: Record<string, boolean>
  requiresPrimaryNonContributory: Record<string, boolean>
  requiresWaiverOfSubrogation: Record<string, boolean>
}

function buildDraftSnapshot(
  documentTypes: ComplianceDocumentType[],
  defaultsByTypeId: Map<string, ComplianceRequirementTemplateItem>,
): DraftSnapshot {
  const snapshot: DraftSnapshot = {
    selected: {},
    notes: {},
    minCoverage: {},
    requiresAdditionalInsured: {},
    requiresPrimaryNonContributory: {},
    requiresWaiverOfSubrogation: {},
  }
  for (const dt of documentTypes) {
    const d = defaultsByTypeId.get(dt.id)
    if (!d) continue
    snapshot.selected[dt.id] = true
    if (d.notes) snapshot.notes[dt.id] = d.notes
    if (d.min_coverage_cents) snapshot.minCoverage[dt.id] = String(Math.round(d.min_coverage_cents / 100))
    snapshot.requiresAdditionalInsured[dt.id] = Boolean(d.requires_additional_insured)
    snapshot.requiresPrimaryNonContributory[dt.id] = Boolean(d.requires_primary_noncontributory)
    snapshot.requiresWaiverOfSubrogation[dt.id] = Boolean(d.requires_waiver_of_subrogation)
  }
  return snapshot
}

/** Canonical key for change detection — order-independent, coerces empties. */
function reqsKey(items: ComplianceRequirementTemplateItem[], knownIds: Set<string>) {
  return JSON.stringify(
    items
      .filter((it) => knownIds.has(it.document_type_id))
      .map((it) => ({
        id: it.document_type_id,
        cov: it.min_coverage_cents ?? 0,
        ai: Boolean(it.requires_additional_insured),
        pnc: Boolean(it.requires_primary_noncontributory),
        wos: Boolean(it.requires_waiver_of_subrogation),
        notes: (it.notes ?? "").trim(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  )
}

export function ComplianceSettings({
  initialRules,
  initialRequirementDefaults,
  canManage,
}: {
  initialRules: ComplianceRules
  initialRequirementDefaults: ComplianceRequirementTemplateItem[]
  canManage: boolean
}) {
  const { toast } = useToast()
  const [isSaving, startSaving] = useTransition()

  // Draft rules + saved baseline.
  const [rules, setRules] = useState<ComplianceRules>(initialRules)
  const [savedRules, setSavedRules] = useState<ComplianceRules>(initialRules)

  const [documentTypes, setDocumentTypes] = useState<ComplianceDocumentType[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Saved requirement baseline.
  const [defaults, setDefaults] = useState<ComplianceRequirementTemplateItem[]>(initialRequirementDefaults ?? [])

  const defaultsByTypeId = useMemo(() => {
    const map = new Map<string, ComplianceRequirementTemplateItem>()
    for (const d of defaults) map.set(d.document_type_id, d)
    return map
  }, [defaults])

  // Draft requirement edits (staged until Save).
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [minCoverage, setMinCoverage] = useState<Record<string, string>>({})
  const [requiresAdditionalInsured, setRequiresAdditionalInsured] = useState<Record<string, boolean>>({})
  const [requiresPrimaryNonContributory, setRequiresPrimaryNonContributory] = useState<Record<string, boolean>>({})
  const [requiresWaiverOfSubrogation, setRequiresWaiverOfSubrogation] = useState<Record<string, boolean>>({})

  const applyDraft = (snapshot: DraftSnapshot) => {
    setSelected(snapshot.selected)
    setNotes(snapshot.notes)
    setMinCoverage(snapshot.minCoverage)
    setRequiresAdditionalInsured(snapshot.requiresAdditionalInsured)
    setRequiresPrimaryNonContributory(snapshot.requiresPrimaryNonContributory)
    setRequiresWaiverOfSubrogation(snapshot.requiresWaiverOfSubrogation)
  }

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    listComplianceDocumentTypesAction()
      .then((types) => {
        if (cancelled) return
        setDocumentTypes(types ?? [])
      })
      .catch(() => {
        if (cancelled) return
        setDocumentTypes([])
      })
      .finally(() => {
        if (cancelled) return
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Re-sync draft whenever the saved baseline (or doc types) changes.
  useEffect(() => {
    applyDraft(buildDraftSnapshot(documentTypes, defaultsByTypeId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentTypes, defaultsByTypeId])

  const setRule = (key: keyof ComplianceRules, value: boolean) => {
    setRules((prev) => ({ ...prev, [key]: value }))
  }

  const buildRequirements = (): ComplianceRequirementTemplateItem[] =>
    documentTypes
      .filter((dt) => selected[dt.id])
      .map((dt) => ({
        document_type_id: dt.id,
        is_required: true,
        min_coverage_cents: minCoverage[dt.id]
          ? Math.round(Number.parseInt(minCoverage[dt.id], 10) * 100)
          : undefined,
        requires_additional_insured: requiresAdditionalInsured[dt.id] ?? false,
        requires_primary_noncontributory: requiresPrimaryNonContributory[dt.id] ?? false,
        requires_waiver_of_subrogation: requiresWaiverOfSubrogation[dt.id] ?? false,
        notes: notes[dt.id] || undefined,
      }))

  const addDocument = (id: string) => setSelected((prev) => ({ ...prev, [id]: true }))
  const removeDocument = (id: string) => setSelected((prev) => ({ ...prev, [id]: false }))

  const requiredDocs = useMemo(
    () => documentTypes.filter((dt) => selected[dt.id]),
    [documentTypes, selected],
  )
  const availableDocs = useMemo(
    () => documentTypes.filter((dt) => !selected[dt.id]),
    [documentTypes, selected],
  )

  const knownIds = useMemo(() => new Set(documentTypes.map((dt) => dt.id)), [documentTypes])

  const rulesDirty =
    Boolean(savedRules.require_lien_waiver) !== Boolean(rules.require_lien_waiver) ||
    Boolean(savedRules.block_payment_on_missing_docs) !== Boolean(rules.block_payment_on_missing_docs) ||
    Boolean(savedRules.warn_subcontract_execution_on_missing_docs) !==
      Boolean(rules.warn_subcontract_execution_on_missing_docs) ||
    Boolean(savedRules.block_subcontract_execution_on_missing_docs) !==
      Boolean(rules.block_subcontract_execution_on_missing_docs) ||
    Boolean(savedRules.block_commitment_on_prequal) !== Boolean(rules.block_commitment_on_prequal)
    || Number(savedRules.prequalification_validity_days ?? 365) !== Number(rules.prequalification_validity_days ?? 365)
  const reqsDirty = reqsKey(buildRequirements(), knownIds) !== reqsKey(defaults, knownIds)
  const dirty = !isLoading && (rulesDirty || reqsDirty)

  const handleSave = () => {
    startSaving(async () => {
      try {
        let nextRules = rules
        let nextDefaults = defaults
        if (rulesDirty) nextRules = unwrapAction(await updateComplianceRulesAction(rules))
        if (reqsDirty) nextDefaults = (unwrapAction(await updateDefaultComplianceRequirementsAction(buildRequirements()))) ?? buildRequirements()
        setRules(nextRules)
        setSavedRules(nextRules)
        setDefaults(nextDefaults)
        toast({ title: "Compliance settings saved" })
      } catch (error: any) {
        toast({ title: "Unable to save", description: error?.message ?? "Try again." })
      }
    })
  }

  const handleDiscard = () => {
    setRules(savedRules)
    applyDraft(buildDraftSnapshot(documentTypes, defaultsByTypeId))
  }

  const policyRows: {
    id: string
    icon: LucideIcon
    label: string
    description: string
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }[] = [
    {
      id: "block-commitment-prequal",
      icon: Ban,
      label: "Block commitment approval when prequalification is missing or over limit",
      description: "When off, Arc shows a warning and allows an override note.",
      checked: rules.block_commitment_on_prequal ?? false,
      onCheckedChange: (checked) => setRule("block_commitment_on_prequal", checked),
    },
    {
      id: "require-lien-waiver",
      icon: Lock,
      label: "Require lien waiver",
      description: "Block vendor payments until a signed waiver is received.",
      checked: rules.require_lien_waiver ?? false,
      onCheckedChange: (checked) => setRule("require_lien_waiver", checked),
    },
    {
      id: "block-missing-docs",
      icon: Ban,
      label: "Block payments when required documents are missing",
      description: "Uses the org-wide baseline, vendor overrides, active waivers, and uploaded documents.",
      checked: rules.block_payment_on_missing_docs ?? false,
      onCheckedChange: (checked) => setRule("block_payment_on_missing_docs", checked),
    },
    {
      id: "warn-subcontract-execution",
      icon: ShieldCheck,
      label: "Warn before executing subcontracts with missing documents",
      description: "Show a compliance warning while still allowing the subcontract or sub change order to be sent.",
      checked: rules.warn_subcontract_execution_on_missing_docs ?? true,
      onCheckedChange: (checked) => setRule("warn_subcontract_execution_on_missing_docs", checked),
    },
    {
      id: "block-subcontract-execution",
      icon: Ban,
      label: "Block subcontract execution when required documents are missing",
      description: "Prevent subcontract and sub change order e-signature sends until the vendor is compliant.",
      checked: rules.block_subcontract_execution_on_missing_docs ?? false,
      onCheckedChange: (checked) => setRule("block_subcontract_execution_on_missing_docs", checked),
    },
  ]

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          disabled={!canManage || isLoading || availableDocs.length === 0}
          className="w-full sm:w-auto"
        >
          <Plus className="mr-2 size-4" />
          Add document
          <ChevronDown className="ml-2 size-4 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Add a required document</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {availableDocs.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">All document types are already required.</div>
        ) : (
          availableDocs.map((dt) => {
            const Icon = docIcon(dt.code)
            return (
              <DropdownMenuItem key={dt.id} onSelect={() => addDocument(dt.id)} className="gap-2">
                <Icon className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{dt.name}</span>
              </DropdownMenuItem>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border-t border-border/70 bg-background">
      <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 lg:flex-row lg:items-center lg:justify-between lg:px-6">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Vendor compliance</h2>
          <p className="text-sm text-muted-foreground">
            Set the document baseline every vendor must meet and when payments are held.
          </p>
        </div>
        <div className="flex shrink-0">{addMenu}</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-10 px-4 py-6 lg:px-6 lg:py-8">
          <section className="space-y-3">
            <header className="space-y-1">
              <h3 className="text-sm font-semibold text-foreground">Payment enforcement</h3>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Control when vendor payments are held back. These rules apply across every project.
              </p>
            </header>

            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
              {policyRows.map((row) => {
                const Icon = row.icon
                return (
                  <div
                    key={row.id}
                    className={cn(
                      "flex flex-col gap-3 border bg-card p-4 shadow-sm transition-colors",
                      row.checked ? "border-primary/40 bg-primary/[0.03]" : "border-border/70",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span
                        className={cn(
                          "flex size-9 shrink-0 items-center justify-center border transition-colors",
                          row.checked
                            ? "border-primary/30 bg-primary/10 text-primary"
                            : "border-border/70 bg-muted/40 text-muted-foreground",
                        )}
                      >
                        <Icon className="size-4" />
                      </span>
                      <Switch
                        checked={row.checked}
                        onCheckedChange={row.onCheckedChange}
                        disabled={!canManage || isSaving}
                        aria-label={row.label}
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium leading-5 text-foreground">{row.label}</p>
                      <p className="text-sm leading-5 text-muted-foreground">{row.description}</p>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="mt-3 max-w-xs space-y-2 border p-4">
              <Label htmlFor="prequal-validity-days">Prequalification validity (days)</Label>
              <Input
                id="prequal-validity-days"
                type="number"
                min={30}
                max={1825}
                value={rules.prequalification_validity_days ?? 365}
                disabled={!canManage || isSaving}
                onChange={(event) => setRules((previous) => ({ ...previous, prequalification_validity_days: Number(event.target.value) }))}
              />
            </div>
          </section>

          <section className="space-y-3">
            <header className="flex flex-wrap items-end justify-between gap-3">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-foreground">Required vendor documents</h3>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  The baseline every vendor must satisfy. Per-vendor overrides and waivers are managed from Directory.
                </p>
              </div>
              {!isLoading && documentTypes.length > 0 ? (
                <Badge variant={requiredDocs.length > 0 ? "secondary" : "outline"}>
                  {requiredDocs.length} required
                </Badge>
              ) : null}
            </header>

            {isLoading ? (
              <div className="divide-y divide-border/60 border border-border/70 bg-card shadow-sm">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                    <Skeleton className="size-9 shrink-0" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-3 w-56" />
                    </div>
                    <Skeleton className="size-4 shrink-0" />
                  </div>
                ))}
              </div>
            ) : documentTypes.length === 0 ? (
              <div className="border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
                No document types found.
              </div>
            ) : requiredDocs.length === 0 ? (
              <div className="flex flex-col items-center gap-3 border border-dashed border-border/70 px-4 py-12 text-center">
                <span className="flex size-10 items-center justify-center border border-border/70 bg-muted/40 text-muted-foreground">
                  <FileText className="size-5" />
                </span>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">No required documents yet</p>
                  <p className="text-sm text-muted-foreground">
                    Use “Add document” to define the baseline every vendor must meet.
                  </p>
                </div>
              </div>
            ) : (
              <Accordion
                type="multiple"
                className="border border-border/70 bg-card shadow-sm [&>div]:border-border/60"
              >
                {requiredDocs.map((dt) => {
                  const Icon = docIcon(dt.code)
                  const showInsurance = isInsuranceDoc(dt.code)
                  const disabled = !canManage || isSaving
                  const endorsementCount =
                    (requiresAdditionalInsured[dt.id] ? 1 : 0) +
                    (requiresPrimaryNonContributory[dt.id] ? 1 : 0) +
                    (requiresWaiverOfSubrogation[dt.id] ? 1 : 0)
                  const summaryParts: string[] = []
                  if (showInsurance && minCoverage[dt.id]) summaryParts.push(`$${groupDollars(minCoverage[dt.id])} min`)
                  if (endorsementCount > 0)
                    summaryParts.push(`${endorsementCount} endorsement${endorsementCount > 1 ? "s" : ""}`)
                  if (notes[dt.id]) summaryParts.push("Note")

                  return (
                    <AccordionItem key={dt.id} value={dt.id} className="px-0">
                      <div className="flex items-center gap-1 pr-2">
                        <AccordionTrigger className="flex-1 items-center px-4 py-3 hover:no-underline">
                          <div className="flex min-w-0 flex-1 items-center gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center border border-primary/30 bg-primary/10 text-primary">
                              <Icon className="size-4" />
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium leading-5 text-foreground">{dt.name}</p>
                              {summaryParts.length > 0 ? (
                                <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
                                  {summaryParts.join(" · ")}
                                </p>
                              ) : dt.description ? (
                                <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
                                  {dt.description}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </AccordionTrigger>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="mr-2 size-8 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeDocument(dt.id)}
                          disabled={disabled}
                          aria-label={`Remove ${dt.name}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>

                      <AccordionContent className="space-y-3 px-4">
                        {showInsurance ? (
                          <>
                            <div className="space-y-1.5">
                              <label className="text-xs font-medium text-muted-foreground">Minimum coverage</label>
                              <div className="relative w-44">
                                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                                  $
                                </span>
                                <Input
                                  inputMode="numeric"
                                  placeholder="1,000,000"
                                  className="h-8 pl-6 text-sm"
                                  value={groupDollars(minCoverage[dt.id] || "")}
                                  onChange={(e) =>
                                    setMinCoverage((prev) => ({
                                      ...prev,
                                      [dt.id]: e.target.value.replace(/[^\d]/g, ""),
                                    }))
                                  }
                                  disabled={disabled}
                                />
                              </div>
                            </div>

                            <div className="space-y-1.5">
                              <span className="block text-xs font-medium text-muted-foreground">
                                Required endorsements
                              </span>
                              <div className="flex flex-wrap gap-1.5">
                                <RequirementChip
                                  label="Additional insured"
                                  active={requiresAdditionalInsured[dt.id] || false}
                                  disabled={disabled}
                                  onClick={() =>
                                    setRequiresAdditionalInsured((prev) => ({
                                      ...prev,
                                      [dt.id]: !(prev[dt.id] || false),
                                    }))
                                  }
                                />
                                <RequirementChip
                                  label="Primary & non-contributory"
                                  active={requiresPrimaryNonContributory[dt.id] || false}
                                  disabled={disabled}
                                  onClick={() =>
                                    setRequiresPrimaryNonContributory((prev) => ({
                                      ...prev,
                                      [dt.id]: !(prev[dt.id] || false),
                                    }))
                                  }
                                />
                                <RequirementChip
                                  label="Waiver of subrogation"
                                  active={requiresWaiverOfSubrogation[dt.id] || false}
                                  disabled={disabled}
                                  onClick={() =>
                                    setRequiresWaiverOfSubrogation((prev) => ({
                                      ...prev,
                                      [dt.id]: !(prev[dt.id] || false),
                                    }))
                                  }
                                />
                              </div>
                            </div>
                          </>
                        ) : null}

                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-muted-foreground">Note</label>
                          <Input
                            placeholder="e.g. must list us as additional insured"
                            className="h-8 text-sm"
                            value={notes[dt.id] || ""}
                            onChange={(e) => setNotes((prev) => ({ ...prev, [dt.id]: e.target.value }))}
                            disabled={disabled}
                          />
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  )
                })}
              </Accordion>
            )}
          </section>
        </div>
      </div>

      <div className="sticky bottom-0 z-20 flex shrink-0 flex-col gap-3 border-t bg-background px-4 py-3 sm:flex-row sm:items-center sm:justify-between lg:px-6">
        <p className="text-sm text-muted-foreground">
          {dirty ? "You have unsaved changes." : "All changes saved."}
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDiscard}
            disabled={!dirty || isSaving}
          >
            Discard
          </Button>
          <Button type="button" size="sm" onClick={handleSave} disabled={!canManage || isSaving || !dirty}>
            {isSaving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Save changes
          </Button>
        </div>
      </div>
    </div>
  )
}
