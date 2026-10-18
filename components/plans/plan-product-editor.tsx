"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Plus, Save } from "@/components/icons"
import { getElevationChangeImpactAction, updateHousePlanAction, upsertElevationAction } from "@/app/(app)/plans/actions"
import { uploadDocumentForm as uploadFileAction } from "@/lib/files/upload-document-form"
import { PlanImageAttachment, PLAN_IMAGE_TYPES } from "@/components/plans/plan-image-attachment"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import { ElevationRevisionHistory } from "@/components/plans/elevation-revision-history"
import { ProductChangeImpactConfirm } from "@/components/plans/product-change-impact"
import type { HousePlanDto, HousePlanElevationDto } from "@/lib/services/house-plans"
import type { ProductChangeImpactDto } from "@/lib/services/product-change-impact"

const UNSET_SWING = "unset"

type ElevationDraft = {
  name: string
  swingApplicable: boolean
  heatedSqftDelta: string
  isActive: boolean
}

/** Said after a save that left pinned homes on lots they no longer fit; they stay pinned, and the start gate refuses them. */
function warnFit(lotsNoLongerFitting: number) {
  if (lotsNoLongerFitting === 0) return
  toast.warning(`${lotsNoLongerFitting} pinned ${lotsNoLongerFitting === 1 ? "lot no longer fits" : "lots no longer fit"} this plan`, {
    description: "Their homes stay pinned. The start gate and agreement pricing refuse them until the lot or plan changes or a fit override is recorded.",
  })
}

function toDraft(elevation: HousePlanElevationDto): ElevationDraft {
  return {
    name: elevation.name ?? "",
    swingApplicable: elevation.swing_applicable,
    heatedSqftDelta: String(elevation.heated_sqft_delta),
    isActive: elevation.is_active,
  }
}

/**
 * Specs, marketing copy, renderings and elevations. All of it is reference data
 * that changes a few times a year, so it lives behind an edit affordance instead
 * of standing permanently open as a form on a page people mostly read.
 */
export function PlanProductEditor({
  plan,
  open,
  onOpenChange,
}: {
  plan: HousePlanDto
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const elevations = plan.elevations ?? []
  const [drafts, setDrafts] = useState<Record<string, ElevationDraft>>(() =>
    Object.fromEntries(elevations.map((elevation) => [elevation.id, toDraft(elevation)])),
  )
  const [newCode, setNewCode] = useState("")
  const [newName, setNewName] = useState("")
  const [uploadTarget, setUploadTarget] = useState<string | null>(null)
  /** An elevation edit waiting on its confirm step, with the homes it reaches. */
  const [confirming, setConfirming] = useState<{ elevationId: string; impact: ProductChangeImpactDto } | null>(null)
  const [series, setSeries] = useState(plan.series ?? "")
  const [heatedSqft, setHeatedSqft] = useState(plan.heated_sqft?.toString() ?? "")
  const [totalSqft, setTotalSqft] = useState(plan.total_sqft?.toString() ?? "")
  const [beds, setBeds] = useState(plan.beds?.toString() ?? "")
  const [baths, setBaths] = useState(plan.baths?.toString() ?? "")
  const [stories, setStories] = useState(plan.stories?.toString() ?? "")
  const [garageBays, setGarageBays] = useState(plan.garage_bays?.toString() ?? "")
  const [footprintWidth, setFootprintWidth] = useState(plan.footprint_width_ft?.toString() ?? "")
  const [footprintDepth, setFootprintDepth] = useState(plan.footprint_depth_ft?.toString() ?? "")
  const [drawnSwing, setDrawnSwing] = useState<string>(plan.drawn_swing ?? UNSET_SWING)
  const [description, setDescription] = useState(plan.description ?? "")

  function run(operation: () => Promise<unknown>, success: string, failure: string) {
    startTransition(async () => {
      try {
        await operation()
        toast.success(success)
        router.refresh()
      } catch (error) {
        toast.error(failure, { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function saveSpecs() {
    run(
      async () => {
        const saved = unwrapAction(
          await updateHousePlanAction(plan.id, {
            series: series.trim() || null,
            heatedSqft: heatedSqft ? Number(heatedSqft) : null,
            totalSqft: totalSqft ? Number(totalSqft) : null,
            beds: beds ? Number(beds) : null,
            baths: baths ? Number(baths) : null,
            stories: stories ? Number(stories) : null,
            garageBays: garageBays ? Number(garageBays) : null,
            footprintWidthFt: footprintWidth ? Number(footprintWidth) : null,
            footprintDepthFt: footprintDepth ? Number(footprintDepth) : null,
            drawnSwing: drawnSwing === "left" || drawnSwing === "right" ? drawnSwing : null,
            description: description.trim() || null,
          }),
        )
        warnFit(saved.lotsNoLongerFitting)
      },
      "Plan details saved",
      "Unable to save plan details",
    )
  }

  function uploadCover(file: File | undefined, elevation: HousePlanElevationDto | null) {
    if (!file) return
    if (!PLAN_IMAGE_TYPES.includes(file.type)) {
      toast.error("Choose a PNG, JPEG, WebP or AVIF image")
      return
    }
    const target = elevation?.id ?? "plan"
    setUploadTarget(target)
    run(
      async () => {
        try {
          const formData = new FormData()
          formData.set("file", file)
          formData.set("category", "plans")
          formData.set("visibility", "private")
          const fileId = unwrapAction(await uploadFileAction(formData)).id
          if (elevation) {
            unwrapAction(
              await upsertElevationAction(plan.id, {
                id: elevation.id,
                code: elevation.code,
                name: elevation.name,
                swingApplicable: elevation.swing_applicable,
                heatedSqftDelta: elevation.heated_sqft_delta,
                isActive: elevation.is_active,
                coverFileId: fileId,
                sortOrder: elevation.sort_order,
              }),
            )
          } else {
            unwrapAction(await updateHousePlanAction(plan.id, { coverFileId: fileId }))
          }
        } finally {
          setUploadTarget(null)
        }
      },
      elevation ? `Elevation ${elevation.code} rendering uploaded` : "Plan rendering uploaded",
      "Upload failed",
    )
  }

  function persistElevation(elevation: HousePlanElevationDto) {
    const draft = drafts[elevation.id] ?? toDraft(elevation)
    run(
      async () => {
        const saved = unwrapAction(
          await upsertElevationAction(plan.id, {
            id: elevation.id,
            code: elevation.code,
            name: draft.name.trim() || null,
            swingApplicable: draft.swingApplicable,
            heatedSqftDelta: Math.round(Number(draft.heatedSqftDelta) || 0),
            isActive: draft.isActive,
            coverFileId: elevation.cover_file_id,
            sortOrder: elevation.sort_order,
          }),
        )
        setConfirming(null)
        warnFit(saved.lotsNoLongerFitting)
      },
      `Elevation ${elevation.code} saved`,
      "Unable to save elevation",
    )
  }

  /** A definition edit reaches every home on the elevation, so the homes it reaches are shown before it saves. */
  function saveElevation(elevation: HousePlanElevationDto) {
    startTransition(async () => {
      let impact: ProductChangeImpactDto
      try {
        impact = unwrapAction(await getElevationChangeImpactAction(elevation.id))
      } catch (error) {
        toast.error("Unable to check which homes this elevation reaches", {
          description: error instanceof Error ? error.message : undefined,
        })
        return
      }
      if (impact.homes.length === 0 && !impact.truncated && impact.homesElsewhere === 0) persistElevation(elevation)
      else setConfirming({ elevationId: elevation.id, impact })
    })
  }

  function addElevation() {
    if (!newCode.trim()) return
    run(
      async () => {
        unwrapAction(
          await upsertElevationAction(plan.id, {
            code: newCode.trim().toUpperCase(),
            name: newName.trim() || null,
            swingApplicable: false,
            heatedSqftDelta: 0,
            isActive: true,
            coverFileId: null,
            sortOrder: elevations.length,
          }),
        )
        setNewCode("")
        setNewName("")
      },
      "Elevation added",
      "Unable to add elevation",
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto rounded-none sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="text-sm">
            {plan.code} — {plan.name}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Specifications, marketing copy and elevations. These describe the product itself, so they are shared by every
            edition.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          <section>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Specifications</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-4">
              {(
                [
                  ["Series", series, setSeries, "text"],
                  ["Heated sqft", heatedSqft, setHeatedSqft, "numeric"],
                  ["Total sqft", totalSqft, setTotalSqft, "numeric"],
                  ["Stories", stories, setStories, "decimal"],
                  ["Beds", beds, setBeds, "numeric"],
                  ["Baths", baths, setBaths, "decimal"],
                  ["Garage bays", garageBays, setGarageBays, "numeric"],
                  ["Footprint width ft", footprintWidth, setFootprintWidth, "decimal"],
                  ["Footprint depth ft", footprintDepth, setFootprintDepth, "decimal"],
                ] as const
              ).map(([label, value, setter, mode]) => (
                <div key={label} className="grid gap-1.5">
                  <Label htmlFor={`spec-${label}`} className="text-xs">
                    {label}
                  </Label>
                  <Input
                    id={`spec-${label}`}
                    inputMode={mode === "text" ? undefined : mode}
                    className="h-8 rounded-none text-xs"
                    value={value}
                    onChange={(event) => setter(event.target.value)}
                  />
                </div>
              ))}
              <div className="grid gap-1.5">
                <Label htmlFor="spec-drawn-swing" className="text-xs">
                  Drawn garage
                </Label>
                <Select value={drawnSwing} onValueChange={setDrawnSwing}>
                  <SelectTrigger id="spec-drawn-swing" className="h-8 rounded-none text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNSET_SWING}>Not recorded</SelectItem>
                    <SelectItem value="left">Left</SelectItem>
                    <SelectItem value="right">Right</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              The footprint is the building&apos;s outside width across the lot and depth front to rear; lots check it
              against their setbacks. An elevation that cannot be flipped is built only with the drawn garage.
            </p>
            <div className="mt-3 grid gap-1.5">
              <Label htmlFor="spec-description" className="text-xs">
                Marketing description
              </Label>
              <Textarea
                id="spec-description"
                className="min-h-20 rounded-none text-xs"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Used on price sheets and the buyer portal."
              />
            </div>
            <Button size="sm" className="mt-3 rounded-none" onClick={saveSpecs} disabled={pending}>
              <Save className="mr-1.5 h-4 w-4" />
              {pending ? "Saving…" : "Save details"}
            </Button>
          </section>

          <section className="border-t pt-4">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Product imagery</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              The fallback exterior image used when an elevation does not have its own.
            </p>
            <div className="mt-2">
              <PlanImageAttachment
                existingUrl={plan.cover_file_id ? `/api/files/${plan.cover_file_id}/raw` : null}
                existingName={`${plan.code} fallback imagery`}
                description="Shown when an elevation-specific image is unavailable"
                uploading={uploadTarget === "plan"}
                disabled={pending}
                onSelect={(file) => uploadCover(file, null)}
              />
            </div>
          </section>

          <section className="border-t pt-4">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Elevations</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Deactivate an elevation instead of deleting it — takeoff deltas, community prices and lot pins reference it.
            </p>
            <div className="mt-2 divide-y border">
              {elevations.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">
                  No elevations yet. Most production plans carry two to four (A, B, C…).
                </p>
              ) : (
                elevations.map((elevation) => {
                  const draft = drafts[elevation.id] ?? toDraft(elevation)
                  const dirty =
                    draft.name !== (elevation.name ?? "") ||
                    draft.swingApplicable !== elevation.swing_applicable ||
                    draft.isActive !== elevation.is_active ||
                    (Number(draft.heatedSqftDelta) || 0) !== elevation.heated_sqft_delta
                  return (
                    <div key={elevation.id} className="space-y-2 p-2.5">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="w-8 font-mono font-medium">{elevation.code}</span>
                        <ElevationRevisionHistory elevationId={elevation.id} code={elevation.code} revision={elevation.revision} />
                        <Input
                          aria-label={`Name for elevation ${elevation.code}`}
                          className="h-8 w-36 rounded-none text-xs"
                          value={draft.name}
                          onChange={(event) =>
                            setDrafts((current) => ({ ...current, [elevation.id]: { ...draft, name: event.target.value } }))
                          }
                          placeholder="Craftsman"
                        />
                        <Input
                          aria-label={`Heated sqft delta for elevation ${elevation.code}`}
                          inputMode="numeric"
                          className="h-8 w-20 rounded-none text-right text-xs tabular-nums"
                          value={draft.heatedSqftDelta}
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [elevation.id]: { ...draft, heatedSqftDelta: event.target.value },
                            }))
                          }
                        />
                        <span className="text-[11px] text-muted-foreground">sf delta</span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto h-7 rounded-none px-2 text-[11px]"
                          disabled={pending || !dirty}
                          onClick={() => saveElevation(elevation)}
                        >
                          Save
                        </Button>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 pl-10">
                        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Checkbox
                            checked={draft.swingApplicable}
                            onCheckedChange={(checked) =>
                              setDrafts((current) => ({
                                ...current,
                                [elevation.id]: { ...draft, swingApplicable: checked === true },
                              }))
                            }
                          />
                          swing
                        </label>
                        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Checkbox
                            checked={draft.isActive}
                            onCheckedChange={(checked) =>
                              setDrafts((current) => ({
                                ...current,
                                [elevation.id]: { ...draft, isActive: checked === true },
                              }))
                            }
                          />
                          active
                        </label>
                      </div>
                      {confirming?.elevationId === elevation.id ? (
                        <ProductChangeImpactConfirm
                          impact={confirming.impact}
                          note={
                            elevation.is_active && !draft.isActive
                              ? "Retiring it: homes sold on this elevation can still start on it; nothing new can be sold on it."
                              : null
                          }
                          pending={pending}
                          onConfirm={() => persistElevation(elevation)}
                          onCancel={() => setConfirming(null)}
                        />
                      ) : null}
                      <PlanImageAttachment
                        compact
                        existingUrl={
                          elevation.cover_file_id ? `/api/files/${elevation.cover_file_id}/raw` : null
                        }
                        existingName={`Elevation ${elevation.code}${elevation.name ? ` · ${elevation.name}` : ""}`}
                        description="Elevation-specific exterior imagery"
                        uploading={uploadTarget === elevation.id}
                        disabled={pending}
                        onSelect={(file) => uploadCover(file, elevation)}
                      />
                    </div>
                  )
                })
              )}
            </div>

            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="new-elevation-code" className="text-xs">
                  Code
                </Label>
                <Input
                  id="new-elevation-code"
                  className="h-8 w-20 rounded-none text-xs"
                  value={newCode}
                  onChange={(event) => setNewCode(event.target.value.toUpperCase())}
                  placeholder="C"
                  maxLength={16}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="new-elevation-name" className="text-xs">
                  Name
                </Label>
                <Input
                  id="new-elevation-name"
                  className="h-8 w-44 rounded-none text-xs"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Farmhouse"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 rounded-none"
                disabled={pending || !newCode.trim()}
                onClick={addElevation}
              >
                <Plus className="mr-1 h-4 w-4" />
                Add elevation
              </Button>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}
