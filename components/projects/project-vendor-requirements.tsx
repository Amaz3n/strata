"use client"

import { useEffect, useMemo, useState, useTransition } from "react"

import {
  listProjectVendorRequirementsAction,
  setProjectVendorRequirementsAction,
} from "@/app/(app)/projects/[id]/compliance/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import { cn } from "@/lib/utils"
import type { ComplianceDocumentType, ComplianceRequirement } from "@/lib/types"

function formatMoneyInput(cents?: number | null) {
  if (cents == null) return ""
  return (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })
}

function parseMoneyToCents(value?: string | null) {
  const normalized = value?.replace(/[$,\s]/g, "") ?? ""
  if (!normalized) return undefined
  const parsed = Number.parseFloat(normalized)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.round(parsed * 100)
}

/**
 * What this job demands of every vendor on it, on top of any standing vendor rules.
 *
 * An owner mandating a $5M umbrella on one project used to mean raising the bar
 * for those vendors everywhere, because requirements were org-wide or per-vendor
 * and nothing else. A rule set here applies to this project only, and can raise
 * terms but never drop them — the waiver stays the one audited way out.
 */
export function ProjectVendorRequirements({ projectId }: { projectId: string }) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [loaded, setLoaded] = useState(false)
  const [documentTypes, setDocumentTypes] = useState<ComplianceDocumentType[]>([])
  const [existing, setExisting] = useState<ComplianceRequirement[]>([])

  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [coverage, setCoverage] = useState<Record<string, string>>({})
  const [endorsements, setEndorsements] = useState<
    Record<string, { ai: boolean; pnc: boolean; wos: boolean }>
  >({})

  useEffect(() => {
    let cancelled = false
    startTransition(async () => {
      try {
        const data = unwrapAction(await listProjectVendorRequirementsAction(projectId))
        if (cancelled) return
        setDocumentTypes(data.documentTypes)
        setExisting(data.requirements)
        const nextSelected: Record<string, boolean> = {}
        const nextCoverage: Record<string, string> = {}
        const nextEndorsements: Record<string, { ai: boolean; pnc: boolean; wos: boolean }> = {}
        for (const requirement of data.requirements) {
          nextSelected[requirement.document_type_id] = true
          if (requirement.min_coverage_cents) {
            nextCoverage[requirement.document_type_id] = formatMoneyInput(
              requirement.min_coverage_cents,
            )
          }
          nextEndorsements[requirement.document_type_id] = {
            ai: Boolean(requirement.requires_additional_insured),
            pnc: Boolean(requirement.requires_primary_noncontributory),
            wos: Boolean(requirement.requires_waiver_of_subrogation),
          }
        }
        setSelected(nextSelected)
        setCoverage(nextCoverage)
        setEndorsements(nextEndorsements)
        setLoaded(true)
      } catch {
        if (!cancelled) setLoaded(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const insuranceTypes = useMemo(
    () => documentTypes.filter((type) => type.kind === "insurance"),
    [documentTypes],
  )
  const otherTypes = useMemo(
    () => documentTypes.filter((type) => type.kind !== "insurance"),
    [documentTypes],
  )

  const save = () => {
    startTransition(async () => {
      try {
        const requirements = documentTypes
          .filter((type) => selected[type.id])
          .map((type) => ({
            document_type_id: type.id,
            is_required: true as const,
            company_id: null,
            min_coverage_cents: parseMoneyToCents(coverage[type.id]),
            requires_additional_insured: endorsements[type.id]?.ai ?? false,
            requires_primary_noncontributory: endorsements[type.id]?.pnc ?? false,
            requires_waiver_of_subrogation: endorsements[type.id]?.wos ?? false,
          }))
        const saved = unwrapAction(
          await setProjectVendorRequirementsAction(projectId, requirements),
        )
        setExisting(saved)
        toast({ title: "Project requirements saved" })
      } catch (error) {
        toast({ title: "Could not save", description: (error as Error).message })
      }
    })
  }

  if (!loaded) {
    return (
      <div className="border-t pt-5">
        <div className="h-4 w-48 animate-pulse bg-muted" />
        <div className="mt-3 h-24 animate-pulse bg-muted/60" />
      </div>
    )
  }

  if (documentTypes.length === 0) return null

  const selectedCount = documentTypes.filter((type) => selected[type.id]).length

  const renderType = (type: ComplianceDocumentType) => {
    const isSelected = selected[type.id] ?? false
    const current = endorsements[type.id] ?? { ai: false, pnc: false, wos: false }
    return (
      <div key={type.id} className={cn("border px-3 py-2.5", isSelected && "border-primary/40")}>
        <label className="flex items-start gap-2.5">
          <Checkbox
            checked={isSelected}
            onCheckedChange={(checked) =>
              setSelected((prev) => ({ ...prev, [type.id]: checked === true }))
            }
            className="mt-0.5"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm">{type.name}</span>
            <span className="block text-xs text-muted-foreground">
              {type.description || "Required from every vendor on this job"}
            </span>
          </span>
        </label>

        {isSelected && type.kind === "insurance" ? (
          <div className="mt-2.5 space-y-2 border-t pt-2.5">
            <div className="max-w-[14rem]">
              <Label className="microlabel mb-1 block">Minimum coverage</Label>
              <InputGroup>
                <InputGroupAddon>$</InputGroupAddon>
                <InputGroupInput
                  inputMode="decimal"
                  placeholder="5,000,000"
                  value={coverage[type.id] ?? ""}
                  onChange={(event) =>
                    setCoverage((prev) => ({ ...prev, [type.id]: event.target.value }))
                  }
                  onBlur={() =>
                    setCoverage((prev) => ({
                      ...prev,
                      [type.id]: formatMoneyInput(parseMoneyToCents(prev[type.id])),
                    }))
                  }
                />
              </InputGroup>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-3">
              {(
                [
                  ["ai", "Additional insured"],
                  ["pnc", "Primary & non-contributory"],
                  ["wos", "Waiver of subrogation"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 border px-2 py-1.5 text-xs">
                  <Checkbox
                    checked={current[key]}
                    onCheckedChange={(checked) =>
                      setEndorsements((prev) => ({
                        ...prev,
                        [type.id]: { ...current, [key]: checked === true },
                      }))
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="border-t pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">What this job demands of vendors</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Added on top of the vendor's standing requirements, for this project only. Raises terms — it never drops
            one, and waiving stays per vendor.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={pending} onClick={save}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>

      <div className="mt-3 space-y-2">
        {insuranceTypes.map(renderType)}
        {otherTypes.map(renderType)}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {selectedCount === 0
          ? "Nothing extra is required on this job."
          : `${selectedCount} extra ${selectedCount === 1 ? "requirement" : "requirements"} on this job · ${existing.length} saved`}
      </p>
    </div>
  )
}
