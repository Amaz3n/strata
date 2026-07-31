"use client"

import { type CSSProperties, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { createHousePlanAction, updateHousePlanAction, upsertElevationAction } from "@/app/(app)/plans/actions"
import { uploadFileAction } from "@/app/(app)/documents/actions"
import { Home, Plus, Trash2 } from "@/components/icons"
import { PlanImageAttachment } from "@/components/plans/plan-image-attachment"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { DivisionDTO } from "@/lib/services/divisions"

type ElevationDraft = {
  id: number
  code: string
  name: string
  swingApplicable: boolean
}

const FAST_SHEET_STYLE = { animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties
const ELEVATION_CODE_PATTERN = /^[A-Z][A-Z0-9]?$/

function optionalNumber(value: string): number | null {
  const trimmed = value.trim()
  return trimmed ? Number(trimmed) : null
}

function nextElevationCode(elevations: ElevationDraft[]): string {
  const used = new Set(elevations.map((elevation) => elevation.code.trim().toUpperCase()))
  for (let index = 0; index < 26; index += 1) {
    const code = String.fromCharCode(65 + index)
    if (!used.has(code)) return code
  }
  return ""
}

export function NewPlanSheet({ divisions }: { divisions: DivisionDTO[] }) {
  const router = useRouter()
  const nextElevationId = useRef(2)
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [series, setSeries] = useState("")
  const [divisionId, setDivisionId] = useState("none")
  const [heatedSqft, setHeatedSqft] = useState("")
  const [totalSqft, setTotalSqft] = useState("")
  const [stories, setStories] = useState("")
  const [beds, setBeds] = useState("")
  const [baths, setBaths] = useState("")
  const [garageBays, setGarageBays] = useState("")
  const [description, setDescription] = useState("")
  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [elevations, setElevations] = useState<ElevationDraft[]>([
    { id: 1, code: "A", name: "", swingApplicable: true },
  ])

  const activeDivisions = divisions.filter((division) => !division.archived)
  const normalizedElevationCodes = elevations
    .map((elevation) => elevation.code.trim().toUpperCase())
    .filter(Boolean)
  const elevationError = normalizedElevationCodes.some((elevationCode) => !ELEVATION_CODE_PATTERN.test(elevationCode))
    ? "Elevation codes must start with A–Z and may include one letter or number."
    : new Set(normalizedElevationCodes).size !== normalizedElevationCodes.length
      ? "Each elevation needs a unique code."
      : null
  const canCreate = code.trim().length > 0 && name.trim().length > 0 && !elevationError && !pending

  function updateElevation(id: number, patch: Partial<Omit<ElevationDraft, "id">>) {
    setElevations((current) =>
      current.map((elevation) => (elevation.id === id ? { ...elevation, ...patch } : elevation)),
    )
  }

  function addElevation() {
    setElevations((current) => [
      ...current,
      {
        id: nextElevationId.current++,
        code: nextElevationCode(current),
        name: "",
        swingApplicable: true,
      },
    ])
  }

  function create() {
    startTransition(async () => {
      try {
        const plan = unwrapAction(
          await createHousePlanAction({
            code,
            name,
            series: series.trim() || null,
            divisionId: divisionId === "none" ? null : divisionId,
            status: "draft",
            heatedSqft: optionalNumber(heatedSqft),
            totalSqft: optionalNumber(totalSqft),
            stories: optionalNumber(stories),
            beds: optionalNumber(beds),
            baths: optionalNumber(baths),
            garageBays: optionalNumber(garageBays),
            description: description.trim() || null,
          }),
        )

        const setupTasks: Promise<unknown>[] = elevations
          .filter((elevation) => elevation.code.trim())
          .map(async (elevation, index) =>
            unwrapAction(
              await upsertElevationAction(plan.id, {
                code: elevation.code.trim().toUpperCase(),
                name: elevation.name.trim() || null,
                swingApplicable: elevation.swingApplicable,
                heatedSqftDelta: 0,
                isActive: true,
                coverFileId: null,
                sortOrder: index,
              }),
            ),
          )

        if (coverFile) {
          setupTasks.push(
            (async () => {
              const formData = new FormData()
              formData.set("file", coverFile)
              formData.set("category", "plans")
              formData.set("visibility", "private")
              const uploaded = unwrapAction(await uploadFileAction(formData))
              unwrapAction(await updateHousePlanAction(plan.id, { coverFileId: uploaded.id }))
            })(),
          )
        }

        const setupResults = await Promise.allSettled(setupTasks)
        const setupWarning = setupResults.some((result) => result.status === "rejected")

        toast.success("Plan created", {
          description: setupWarning
            ? "The plan was saved, but some imagery or elevation setup needs review."
            : "The v1 draft is ready for its takeoff and start recipe.",
        })
        setOpen(false)
        router.push(`/plans/${plan.id}`)
      } catch (error) {
        toast.error("Unable to create plan", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" className="rounded-none">
          <Plus className="mr-1.5 h-4 w-4" />
          New plan
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        mobileFullscreen
        aria-label="New house plan"
        className="fast-sheet-animation flex flex-col gap-0 p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-xl"
        style={FAST_SHEET_STYLE}
      >
        <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
          <SheetTitle className="flex items-center gap-2">
            <Home className="h-4 w-4 text-primary" />
            New house plan
          </SheetTitle>
          <SheetDescription>
            Define the reusable product. A v1 draft is created automatically for takeoff, templates, and release.
          </SheetDescription>
        </SheetHeader>

        <form
          id="create-plan"
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            if (canCreate) create()
          }}
        >
          <div className="flex-1 space-y-7 overflow-y-auto px-6 py-5">
            <section className="space-y-4">
              <div>
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Identity</p>
                <p className="mt-1 text-xs text-muted-foreground">Code and name identify this plan across every community.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-[0.7fr_1.3fr]">
                <div className="grid gap-1.5">
                  <Label htmlFor="plan-code">
                    Plan code <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="plan-code"
                    autoFocus
                    value={code}
                    onChange={(event) => setCode(event.target.value.toUpperCase())}
                    placeholder="CL1900"
                    maxLength={32}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="plan-name">
                    Plan name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="plan-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="The Palmetto"
                    maxLength={160}
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="plan-series">Series or collection</Label>
                  <Input
                    id="plan-series"
                    value={series}
                    onChange={(event) => setSeries(event.target.value)}
                    placeholder="Cypress Landing"
                    maxLength={120}
                  />
                </div>
                {activeDivisions.length > 0 ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="plan-division">Owning division</Label>
                    <Select value={divisionId} onValueChange={setDivisionId}>
                      <SelectTrigger id="plan-division" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Org-wide</SelectItem>
                        {activeDivisions.map((division) => (
                          <SelectItem key={division.id} value={division.id}>
                            {division.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="space-y-4 border-t pt-5">
              <div>
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Product imagery
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The fallback image used when an elevation does not have its own rendering.
                </p>
              </div>
              <PlanImageAttachment
                file={coverFile}
                uploading={pending && Boolean(coverFile)}
                disabled={pending}
                onSelect={setCoverFile}
                onRemove={coverFile ? () => setCoverFile(null) : undefined}
              />
            </section>

            <section className="space-y-4 border-t pt-5">
              <div>
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Product specs</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Core selling specifications shared by all elevations and editions.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {(
                  [
                    ["heated-sqft", "Heated sqft", heatedSqft, setHeatedSqft, "1"],
                    ["total-sqft", "Total sqft", totalSqft, setTotalSqft, "1"],
                    ["stories", "Stories", stories, setStories, "0.5"],
                    ["beds", "Beds", beds, setBeds, "0.5"],
                    ["baths", "Baths", baths, setBaths, "0.5"],
                    ["garage-bays", "Garage bays", garageBays, setGarageBays, "0.5"],
                  ] as const
                ).map(([id, label, value, setter, step]) => (
                  <div key={id} className="grid gap-1.5">
                    <Label htmlFor={`new-plan-${id}`} className="text-xs">
                      {label}
                    </Label>
                    <Input
                      id={`new-plan-${id}`}
                      type="number"
                      min="0"
                      step={step}
                      value={value}
                      onChange={(event) => setter(event.target.value)}
                    />
                  </div>
                ))}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="plan-description">Marketing description</Label>
                <Textarea
                  id="plan-description"
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Short product description used on price sheets and buyer-facing materials."
                  maxLength={5000}
                />
              </div>
            </section>

            <section className="space-y-4 border-t pt-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    Initial elevations
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add the product faces you expect to price and permit. Renderings can be uploaded afterward.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 rounded-none"
                  onClick={addElevation}
                  disabled={elevations.length >= 8}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add
                </Button>
              </div>

              <div className="divide-y border">
                {elevations.map((elevation) => (
                  <div
                    key={elevation.id}
                    className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-end gap-3 p-3"
                  >
                    <div className="grid gap-1.5">
                      <Label htmlFor={`elevation-code-${elevation.id}`} className="text-xs">
                        Code
                      </Label>
                      <Input
                        id={`elevation-code-${elevation.id}`}
                        value={elevation.code}
                        onChange={(event) => updateElevation(elevation.id, { code: event.target.value.toUpperCase() })}
                        placeholder="A"
                        maxLength={2}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`elevation-name-${elevation.id}`} className="text-xs">
                        Name
                      </Label>
                      <Input
                        id={`elevation-name-${elevation.id}`}
                        value={elevation.name}
                        onChange={(event) => updateElevation(elevation.id, { name: event.target.value })}
                        placeholder="Coastal, Craftsman…"
                        maxLength={160}
                      />
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-9 w-9 text-muted-foreground"
                      onClick={() =>
                        setElevations((current) => current.filter((item) => item.id !== elevation.id))
                      }
                      aria-label={`Remove elevation ${elevation.code || elevation.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <label className="col-span-3 flex items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox
                        checked={elevation.swingApplicable}
                        onCheckedChange={(checked) =>
                          updateElevation(elevation.id, { swingApplicable: checked === true })
                        }
                      />
                      Allow left/right swing for this elevation
                    </label>
                  </div>
                ))}
                {elevations.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">
                    No initial elevations. You can add them from the plan detail later.
                  </p>
                ) : null}
              </div>
              {elevationError ? <p className="text-xs text-destructive">{elevationError}</p> : null}
            </section>

            <aside className="border border-primary/25 bg-primary/5 p-3">
              <p className="text-xs font-medium">Created as a controlled draft</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Next, complete the takeoff, start recipe, community pricing, and renderings on the plan detail before
                releasing v1.
              </p>
            </aside>
          </div>

          <SheetFooter className="flex-row gap-2 border-t bg-background/80 px-6 py-4">
            <Button type="button" variant="outline" className="flex-1 rounded-none" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1 rounded-none" disabled={!canCreate}>
              {pending ? "Creating…" : "Create draft plan"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
