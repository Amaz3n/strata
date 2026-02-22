"use client"

import { useEffect, useMemo, useState, useTransition } from "react"

import type { ComplianceRequirementTemplateItem, ComplianceRules, ComplianceDocumentType } from "@/lib/types"
import {
  updateComplianceRulesAction,
  updateDefaultComplianceRequirementsAction,
} from "@/app/(app)/settings/compliance/actions"
import { listComplianceDocumentTypesAction } from "@/app/(app)/companies/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"

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

  const setRule = (key: keyof ComplianceRules, value: boolean) => {
    setRules((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = () => {
    startTransition(async () => {
      try {
        await updateComplianceRulesAction(rules)
        toast({ title: "Compliance rules updated" })
      } catch (error: any) {
        toast({ title: "Unable to update rules", description: error?.message ?? "Try again." })
      }
    })
  }

  const handleSaveDefaults = () => {
    startDefaultsTransition(async () => {
      try {
        const requirements: ComplianceRequirementTemplateItem[] = documentTypes
          .filter((dt) => selected[dt.id])
          .map((dt) => ({
            document_type_id: dt.id,
            is_required: true,
            min_coverage_cents: minCoverage[dt.id]
              ? Math.round(Number.parseFloat(minCoverage[dt.id]) * 100)
              : undefined,
            requires_additional_insured: requiresAdditionalInsured[dt.id] ?? false,
            requires_primary_noncontributory: requiresPrimaryNonContributory[dt.id] ?? false,
            requires_waiver_of_subrogation: requiresWaiverOfSubrogation[dt.id] ?? false,
            notes: notes[dt.id] || undefined,
          }))

        const saved = await updateDefaultComplianceRequirementsAction(requirements)
        setDefaults(saved ?? requirements)
        toast({ title: "Default compliance requirements updated" })
      } catch (error: any) {
        toast({ title: "Unable to update defaults", description: error?.message ?? "Try again." })
      }
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Payables policy</CardTitle>
          <CardDescription>
            Control whether vendor payments are blocked when a company is missing required compliance documents.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label className="text-sm font-medium">Require lien waiver</Label>
              <p className="text-xs text-muted-foreground">Block payments until a waiver is received.</p>
            </div>
            <Switch
              checked={rules.require_lien_waiver ?? false}
              onCheckedChange={(checked) => setRule("require_lien_waiver", checked)}
              disabled={!canManage}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label className="text-sm font-medium">Block payments when required docs are missing</Label>
              <p className="text-xs text-muted-foreground">
                Uses each company’s configured compliance requirements (Directory → Company → Compliance).
              </p>
            </div>
            <Switch
              checked={rules.block_payment_on_missing_docs ?? false}
              onCheckedChange={(checked) => setRule("block_payment_on_missing_docs", checked)}
              disabled={!canManage}
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={!canManage || isPending}>
              {isPending ? "Saving..." : "Save policy"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default compliance requirements</CardTitle>
          <CardDescription>
            Automatically applied to newly created subcontractor and supplier companies. Existing companies are unchanged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {documentTypes.length === 0 ? (
            <div className="text-sm text-muted-foreground">No document types found.</div>
          ) : (
            <div className="space-y-3">
              {documentTypes.map((dt) => {
                const checked = selected[dt.id] || false
                const showInsuranceRequirements =
                  checked &&
                  (dt.code.includes("coi") || dt.code.includes("insurance") || dt.code.includes("umbrella"))
                return (
                  <div key={dt.id} className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-center gap-3">
                      <Checkbox
                        id={`default-req-${dt.id}`}
                        checked={checked}
                        onCheckedChange={(value) =>
                          setSelected((prev) => ({ ...prev, [dt.id]: !!value }))
                        }
                        disabled={!canManage}
                      />
                      <div className="flex-1">
                        <Label htmlFor={`default-req-${dt.id}`} className="font-medium cursor-pointer">
                          {dt.name}
                        </Label>
                        {dt.description ? (
                          <p className="text-xs text-muted-foreground">{dt.description}</p>
                        ) : null}
                      </div>
                    </div>

                    {showInsuranceRequirements ? (
                      <div className="pl-7 space-y-2">
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
                            disabled={!canManage}
                          />
                        </div>
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={requiresAdditionalInsured[dt.id] || false}
                            onCheckedChange={(checked) =>
                              setRequiresAdditionalInsured((prev) => ({ ...prev, [dt.id]: checked === true }))
                            }
                            disabled={!canManage}
                          />
                          <span>Require additional insured endorsement</span>
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={requiresPrimaryNonContributory[dt.id] || false}
                            onCheckedChange={(checked) =>
                              setRequiresPrimaryNonContributory((prev) => ({ ...prev, [dt.id]: checked === true }))
                            }
                            disabled={!canManage}
                          />
                          <span>Require primary & non-contributory wording</span>
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={requiresWaiverOfSubrogation[dt.id] || false}
                            onCheckedChange={(checked) =>
                              setRequiresWaiverOfSubrogation((prev) => ({ ...prev, [dt.id]: checked === true }))
                            }
                            disabled={!canManage}
                          />
                          <span>Require waiver of subrogation endorsement</span>
                        </label>
                      </div>
                    ) : null}

                    {checked ? (
                      <div className="pl-7">
                        <Input
                          placeholder="Notes (e.g., Must list us as additional insured)"
                          className="h-8 text-sm"
                          value={notes[dt.id] || ""}
                          onChange={(e) => setNotes((prev) => ({ ...prev, [dt.id]: e.target.value }))}
                          disabled={!canManage}
                        />
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={handleSaveDefaults} disabled={!canManage || defaultsPending}>
              {defaultsPending ? "Saving..." : "Save defaults"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
