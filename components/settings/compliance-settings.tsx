"use client"

import { useEffect, useMemo, useState, useTransition } from "react"

import type { ComplianceRequirementTemplateItem, ComplianceRules, ComplianceDocumentType } from "@/lib/types"
import {
  updateComplianceRulesAction,
  updateDefaultComplianceRequirementsAction,
} from "@/app/(app)/settings/compliance/actions"
import { listComplianceDocumentTypesAction } from "@/app/(app)/companies/actions"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"

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
  const [isPending, startTransition] = useTransition()
  const [rules, setRules] = useState<ComplianceRules>(initialRules)
  const [documentTypes, setDocumentTypes] = useState<ComplianceDocumentType[]>([])
  const [defaults, setDefaults] = useState<ComplianceRequirementTemplateItem[]>(initialRequirementDefaults ?? [])
  const [defaultsPending, startDefaultsTransition] = useTransition()

  const defaultsByTypeId = useMemo(() => {
    const map = new Map<string, ComplianceRequirementTemplateItem>()
    for (const d of defaults) map.set(d.document_type_id, d)
    return map
  }, [defaults])

  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [minCoverage, setMinCoverage] = useState<Record<string, string>>({})
  const [requiresAdditionalInsured, setRequiresAdditionalInsured] = useState<Record<string, boolean>>({})
  const [requiresPrimaryNonContributory, setRequiresPrimaryNonContributory] = useState<Record<string, boolean>>({})
  const [requiresWaiverOfSubrogation, setRequiresWaiverOfSubrogation] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    listComplianceDocumentTypesAction()
      .then((types) => {
        if (cancelled) return
        setDocumentTypes(types ?? [])
      })
      .catch(() => {
        if (cancelled) return
        setDocumentTypes([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const sel: Record<string, boolean> = {}
    const n: Record<string, string> = {}
    const cov: Record<string, string> = {}
    const ai: Record<string, boolean> = {}
    const pnc: Record<string, boolean> = {}
    const wos: Record<string, boolean> = {}
    for (const dt of documentTypes) {
      const d = defaultsByTypeId.get(dt.id)
      if (d) {
        sel[dt.id] = true
        if (d.notes) n[dt.id] = d.notes
        if (d.min_coverage_cents) cov[dt.id] = (d.min_coverage_cents / 100).toString()
        ai[dt.id] = Boolean(d.requires_additional_insured)
        pnc[dt.id] = Boolean(d.requires_primary_noncontributory)
        wos[dt.id] = Boolean(d.requires_waiver_of_subrogation)
      }
    }
    setSelected(sel)
    setNotes(n)
    setMinCoverage(cov)
    setRequiresAdditionalInsured(ai)
    setRequiresPrimaryNonContributory(pnc)
    setRequiresWaiverOfSubrogation(wos)
  }, [documentTypes, defaultsByTypeId])

  const persistRules = (nextRules: ComplianceRules) => {
    startTransition(async () => {
      try {
        const saved = await updateComplianceRulesAction(nextRules)
        setRules(saved)
        toast({ title: "Compliance rules updated" })
      } catch (error: any) {
        setRules(rules)
        toast({ title: "Unable to update rules", description: error?.message ?? "Try again." })
      }
    })
  }

  const setRule = (key: keyof ComplianceRules, value: boolean) => {
    const nextRules = { ...rules, [key]: value }
    setRules(nextRules)
    persistRules(nextRules)
  }

  const buildRequirements = (overrides?: {
    selected?: Record<string, boolean>
    notes?: Record<string, string>
    minCoverage?: Record<string, string>
    requiresAdditionalInsured?: Record<string, boolean>
    requiresPrimaryNonContributory?: Record<string, boolean>
    requiresWaiverOfSubrogation?: Record<string, boolean>
  }) => {
    const nextSelected = overrides?.selected ?? selected
    const nextNotes = overrides?.notes ?? notes
    const nextMinCoverage = overrides?.minCoverage ?? minCoverage
    const nextRequiresAdditionalInsured = overrides?.requiresAdditionalInsured ?? requiresAdditionalInsured
    const nextRequiresPrimaryNonContributory =
      overrides?.requiresPrimaryNonContributory ?? requiresPrimaryNonContributory
    const nextRequiresWaiverOfSubrogation =
      overrides?.requiresWaiverOfSubrogation ?? requiresWaiverOfSubrogation

    return documentTypes
      .filter((dt) => nextSelected[dt.id])
      .map((dt) => ({
        document_type_id: dt.id,
        is_required: true,
        min_coverage_cents: nextMinCoverage[dt.id]
          ? Math.round(Number.parseFloat(nextMinCoverage[dt.id]) * 100)
          : undefined,
        requires_additional_insured: nextRequiresAdditionalInsured[dt.id] ?? false,
        requires_primary_noncontributory: nextRequiresPrimaryNonContributory[dt.id] ?? false,
        requires_waiver_of_subrogation: nextRequiresWaiverOfSubrogation[dt.id] ?? false,
        notes: nextNotes[dt.id] || undefined,
      }))
  }

  const persistDefaults = (requirements: ComplianceRequirementTemplateItem[]) => {
    startDefaultsTransition(async () => {
      try {
        const saved = await updateDefaultComplianceRequirementsAction(requirements)
        setDefaults(saved ?? requirements)
        toast({ title: "Default compliance requirements updated" })
      } catch (error: any) {
        toast({ title: "Unable to update defaults", description: error?.message ?? "Try again." })
      }
    })
  }

  const updateSelected = (documentTypeId: string, value: boolean) => {
    const nextSelected = { ...selected, [documentTypeId]: value }
    setSelected(nextSelected)
    persistDefaults(buildRequirements({ selected: nextSelected }))
  }

  const updateDefaultFlag = (
    setter: (value: Record<string, boolean>) => void,
    source: Record<string, boolean>,
    key:
      | "requiresAdditionalInsured"
      | "requiresPrimaryNonContributory"
      | "requiresWaiverOfSubrogation",
    documentTypeId: string,
    value: boolean,
  ) => {
    const next = { ...source, [documentTypeId]: value }
    setter(next)
    persistDefaults(buildRequirements({ [key]: next }))
  }

  const persistTextDefaults = () => {
    persistDefaults(buildRequirements())
  }

  const policyRows = [
    {
      id: "require-lien-waiver",
      label: "Require lien waiver",
      description: "Block vendor payments until a waiver is received.",
      checked: rules.require_lien_waiver ?? false,
      onCheckedChange: (checked: boolean) => setRule("require_lien_waiver", checked),
    },
    {
      id: "block-missing-docs",
      label: "Block payments when required documents are missing",
      description: "Uses each company’s configured requirements in Directory -> Company -> Compliance.",
      checked: rules.block_payment_on_missing_docs ?? false,
      onCheckedChange: (checked: boolean) => setRule("block_payment_on_missing_docs", checked),
    },
  ]

  return (
    <div className="space-y-8">
      <section className="overflow-hidden border border-border/80 bg-background/75 shadow-sm">
        <div className="divide-y divide-border/70">
          {policyRows.map((row) => (
            <div key={row.id} className="px-4 py-4 lg:px-5">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <Label htmlFor={row.id} className="min-w-0 truncate text-sm font-medium leading-5">
                  {row.label}
                </Label>
                <Switch
                  id={row.id}
                  checked={row.checked}
                  onCheckedChange={row.onCheckedChange}
                  disabled={!canManage || isPending}
                  className="shrink-0"
                />
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">{row.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="px-1">
          <h2 className="text-sm font-medium text-foreground">Default requirements</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Applied to newly created subcontractor and supplier companies. Existing companies are unchanged.
          </p>
        </div>

        <div className="overflow-hidden border border-border/80 bg-background/75 shadow-sm">
          {documentTypes.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground lg:px-5">No document types found.</div>
          ) : (
            <div className="divide-y divide-border/70">
              {documentTypes.map((dt) => {
                const checked = selected[dt.id] || false
                const showInsuranceRequirements =
                  checked &&
                  (dt.code.includes("coi") || dt.code.includes("insurance") || dt.code.includes("umbrella"))
                return (
                  <div key={dt.id} className={cn("space-y-3 px-4 py-4 lg:px-5", !checked && "bg-muted/10")}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <Label htmlFor={`default-req-${dt.id}`} className="font-medium cursor-pointer">
                          {dt.name}
                        </Label>
                        {dt.description ? (
                          <p className="text-xs text-muted-foreground">{dt.description}</p>
                        ) : null}
                      </div>
                      <Checkbox
                        id={`default-req-${dt.id}`}
                        checked={checked}
                        onCheckedChange={(value) => updateSelected(dt.id, value === true)}
                        disabled={!canManage || defaultsPending}
                        className="mt-0.5 shrink-0"
                      />
                    </div>

                    {showInsuranceRequirements ? (
                      <div className="ml-7 space-y-3 border-l border-border/70 pl-4">
                        <div className="flex items-center gap-2">
                          <Label className="text-xs text-muted-foreground whitespace-nowrap">Min coverage $</Label>
                          <Input
                            type="number"
                            placeholder="e.g. 1000000"
                            className="h-8 w-32"
                            value={minCoverage[dt.id] || ""}
                            onChange={(e) =>
                              setMinCoverage((prev) => ({ ...prev, [dt.id]: e.target.value }))
                            }
                            onBlur={persistTextDefaults}
                            disabled={!canManage || defaultsPending}
                          />
                        </div>
                        <label className="flex items-center justify-between gap-4 text-sm">
                          <span>Require additional insured endorsement</span>
                          <Checkbox
                            checked={requiresAdditionalInsured[dt.id] || false}
                            onCheckedChange={(checked) =>
                              updateDefaultFlag(
                                setRequiresAdditionalInsured,
                                requiresAdditionalInsured,
                                "requiresAdditionalInsured",
                                dt.id,
                                checked === true,
                              )
                            }
                            disabled={!canManage || defaultsPending}
                          />
                        </label>
                        <label className="flex items-center justify-between gap-4 text-sm">
                          <span>Require primary & non-contributory wording</span>
                          <Checkbox
                            checked={requiresPrimaryNonContributory[dt.id] || false}
                            onCheckedChange={(checked) =>
                              updateDefaultFlag(
                                setRequiresPrimaryNonContributory,
                                requiresPrimaryNonContributory,
                                "requiresPrimaryNonContributory",
                                dt.id,
                                checked === true,
                              )
                            }
                            disabled={!canManage || defaultsPending}
                          />
                        </label>
                        <label className="flex items-center justify-between gap-4 text-sm">
                          <span>Require waiver of subrogation endorsement</span>
                          <Checkbox
                            checked={requiresWaiverOfSubrogation[dt.id] || false}
                            onCheckedChange={(checked) =>
                              updateDefaultFlag(
                                setRequiresWaiverOfSubrogation,
                                requiresWaiverOfSubrogation,
                                "requiresWaiverOfSubrogation",
                                dt.id,
                                checked === true,
                              )
                            }
                            disabled={!canManage || defaultsPending}
                          />
                        </label>
                      </div>
                    ) : null}

                    {checked ? (
                      <div className="ml-7">
                        <Input
                          placeholder="Notes (e.g., Must list us as additional insured)"
                          className="h-8 text-sm"
                          value={notes[dt.id] || ""}
                          onChange={(e) => setNotes((prev) => ({ ...prev, [dt.id]: e.target.value }))}
                          onBlur={persistTextDefaults}
                          disabled={!canManage || defaultsPending}
                        />
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
