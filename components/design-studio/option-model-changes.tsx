"use client"

import { Plus, X } from "lucide-react"

import { FINISH_PRESETS } from "@/lib/drawings/architectural-model"
import { FURNITURE_CATALOG, FURNITURE_CATEGORY_LABELS, type FurnitureCategory } from "@/lib/drawings/furniture-catalog"
import type { ModelChange } from "@/lib/drawings/model-options"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"

/** One editable row: prices and rooms stay as typed until the option is saved. */
export type ModelChangeDraft = {
  key: string
  kind: ModelChange["kind"]
  /** Finish preset key, or furniture model id. */
  target: string
  rooms: string
  price: string
}

const KIND_LABELS: Record<ModelChange["kind"], string> = {
  floor_finish: "Floor finish",
  wall_finish: "Wall finish",
  furniture: "Furniture",
}

const FINISH_KEYS = Object.keys(FINISH_PRESETS)
const FIRST_FURNITURE = FURNITURE_CATALOG[0]?.id ?? ""
const FURNITURE_GROUPS = (Object.keys(FURNITURE_CATEGORY_LABELS) as FurnitureCategory[])
  .map((category) => ({ category, pieces: FURNITURE_CATALOG.filter((piece) => piece.category === category) }))
  .filter((group) => group.pieces.length > 0)

let draftSequence = 0
const nextKey = () => `model-change-${++draftSequence}`

export function modelChangeDrafts(changes: ModelChange[]): ModelChangeDraft[] {
  return changes.map((change) => ({
    key: nextKey(),
    kind: change.kind,
    target: change.kind === "furniture" ? change.modelId : change.finish,
    rooms: change.rooms.join(", "),
    price: ((change.kind === "furniture" ? change.priceCents : change.unitPriceCents) / 100).toFixed(2),
  }))
}

/** Drafts to the stored contract; the server re-validates with `modelChangesSchema`. */
export function modelChangesFromDrafts(drafts: ModelChangeDraft[]): ModelChange[] {
  return drafts.map((draft) => {
    const rooms = draft.rooms.split(",").map((room) => room.trim()).filter(Boolean)
    const cents = Math.round((Number(draft.price) || 0) * 100)
    return draft.kind === "furniture"
      ? { kind: "furniture", modelId: draft.target, rooms, priceCents: cents }
      : { kind: draft.kind, finish: draft.target, rooms, unitPriceCents: cents }
  })
}

const MAX_CHANGES = 12

export function OptionModelChanges({
  value,
  onChange,
  disabled,
}: {
  value: ModelChangeDraft[]
  onChange: (next: ModelChangeDraft[]) => void
  disabled?: boolean
}) {
  const update = (key: string, patch: Partial<ModelChangeDraft>) =>
    onChange(value.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)))

  const setKind = (draft: ModelChangeDraft, kind: ModelChange["kind"]) => {
    if (kind === draft.kind) return
    const wasFurniture = draft.kind === "furniture"
    const isFurniture = kind === "furniture"
    update(draft.key, {
      kind,
      // Finish ↔ finish keeps the material; crossing to or from furniture resets the target.
      target: wasFurniture === isFurniture ? draft.target : isFurniture ? FIRST_FURNITURE : FINISH_KEYS[0] ?? "",
    })
  }

  return (
    <section className="space-y-3 border-t py-4" aria-label="In the 3D model">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">In the 3D model</h3>
          <p className="text-xs text-muted-foreground">
            What this option changes in the house. Finishes price per square foot of the matched rooms; furniture per piece.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || value.length >= MAX_CHANGES}
          onClick={() =>
            onChange([...value, { key: nextKey(), kind: "floor_finish", target: FINISH_KEYS[0] ?? "", rooms: "", price: "0.00" }])
          }
        >
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>

      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">No model changes — the option is priced and sold without showing in the model.</p>
      ) : (
        <div className="divide-y border">
          <div className="grid grid-cols-[7.5rem_1fr_1fr_5.5rem_2rem] gap-2 bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
            <span>Change</span>
            <span>Material / piece</span>
            <span>Rooms</span>
            <span className="text-right">Price</span>
            <span className="sr-only">Remove</span>
          </div>
          {value.map((draft, index) => {
            const isFurniture = draft.kind === "furniture"
            return (
              <div key={draft.key} className="grid grid-cols-[7.5rem_1fr_1fr_5.5rem_2rem] items-center gap-2 px-2 py-1.5">
                <Select value={draft.kind} disabled={disabled} onValueChange={(kind) => setKind(draft, kind as ModelChange["kind"])}>
                  <SelectTrigger size="sm" className="w-full rounded-none" aria-label={`Change ${index + 1} kind`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(KIND_LABELS) as ModelChange["kind"][]).map((kind) => (
                      <SelectItem key={kind} value={kind}>{KIND_LABELS[kind]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={draft.target} disabled={disabled} onValueChange={(target) => update(draft.key, { target })}>
                  <SelectTrigger size="sm" className="w-full rounded-none" aria-label={`Change ${index + 1} ${isFurniture ? "piece" : "finish"}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {isFurniture
                      ? FURNITURE_GROUPS.map((group) => (
                        <SelectGroup key={group.category}>
                          <SelectLabel>{FURNITURE_CATEGORY_LABELS[group.category]}</SelectLabel>
                          {group.pieces.map((piece) => (
                            <SelectItem key={piece.id} value={piece.id}>{piece.name}</SelectItem>
                          ))}
                        </SelectGroup>
                      ))
                      : FINISH_KEYS.map((key) => (
                        <SelectItem key={key} value={key}>
                          {/* A physical material color, the same swatch the model inspector shows. */}
                          <span className="size-3 shrink-0 border" style={{ backgroundColor: FINISH_PRESETS[key]?.color }} />
                          <span className="capitalize">{key}</span>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>

                <Input
                  value={draft.rooms}
                  disabled={disabled}
                  maxLength={400}
                  placeholder="Every room"
                  aria-label={`Change ${index + 1} rooms, comma separated`}
                  onChange={(event) => update(draft.key, { rooms: event.target.value })}
                  className="h-8 rounded-none text-sm"
                />

                <div className="relative">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={draft.price}
                    disabled={disabled}
                    aria-label={`Change ${index + 1} price ${isFurniture ? "each" : "per square foot"}`}
                    onChange={(event) => update(draft.key, { price: event.target.value })}
                    className="h-8 rounded-none pr-7 text-right text-sm tabular-nums"
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-muted-foreground">
                    {isFurniture ? "ea" : "/sf"}
                  </span>
                </div>

                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={disabled}
                  aria-label={`Remove change ${index + 1}`}
                  onClick={() => onChange(value.filter((row) => row.key !== draft.key))}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            )
          })}
        </div>
      )}
      {value.length > 0 && (
        <p className="text-xs text-muted-foreground">Rooms match by label, e.g. “Bedroom, Primary”. Leave empty for every room.</p>
      )}
    </section>
  )
}
