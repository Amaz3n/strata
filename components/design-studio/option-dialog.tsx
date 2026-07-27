"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import { upsertOptionAction } from "@/app/(app)/design-studio/actions"
import type { CatalogOptionDto } from "@/lib/services/option-catalog"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { OptionImageField, type OptionImage } from "@/components/design-studio/option-image-field"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  categoryId: string
  categoryName: string
  communityId?: string
  /** Present when editing; absent when adding. */
  option: CatalogOptionDto | null
  sortOrder: number
  canReadMargin: boolean
  onSaved: () => void
}

export function OptionDialog({
  open,
  onOpenChange,
  categoryId,
  categoryName,
  communityId,
  option,
  sortOrder,
  canReadMargin,
  onSaved,
}: Props) {
  const [isStandard, setIsStandard] = useState(false)
  const [isAvailable, setIsAvailable] = useState(true)
  const [scope, setScope] = useState<"design_studio" | "structural">("design_studio")
  const [image, setImage] = useState<OptionImage>({ fileId: null, url: null, fileName: null })
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    setIsStandard(option?.is_default ?? false)
    setIsAvailable(option?.is_available ?? true)
    setScope(option?.option_scope ?? "design_studio")
    setImage({
      fileId: option?.file_id ?? null,
      url: option?.image_url ?? null,
      fileName: option?.image_url ? option.name : null,
    })
  }, [open, option])

  function save(formData: FormData) {
    const priceValue = Number(formData.get("price") ?? 0)
    const costValue = Number(formData.get("cost") ?? 0)
    const leadValue = String(formData.get("leadTimeDays") ?? "")
    startTransition(async () => {
      try {
        unwrapAction(
          await upsertOptionAction({
            id: option?.id ?? null,
            categoryId,
            communityId: communityId ?? null,
            name: String(formData.get("name") ?? ""),
            description: String(formData.get("description") ?? "") || null,
            optionScope: scope,
            sku: String(formData.get("sku") ?? "") || null,
            vendor: String(formData.get("vendor") ?? "") || null,
            imageUrl: image.url,
            fileId: image.fileId,
            leadTimeDays: leadValue === "" ? null : Math.round(Number(leadValue)),
            priceCents: Math.round(priceValue * 100),
            costCents: canReadMargin ? Math.round(costValue * 100) : null,
            sortOrder: option?.sort_order ?? sortOrder,
            isAvailable,
            isStandard,
          }),
        )
        onOpenChange(false)
        toast.success(option ? "Option updated" : "Option added")
        onSaved()
      } catch (error) {
        toast.error(option ? "Could not update the option" : "Could not add the option", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-none sm:max-w-lg">
        <form action={save}>
          <DialogHeader>
            <DialogTitle>{option ? `Edit ${option.name}` : `Add an option to ${categoryName}`}</DialogTitle>
            <DialogDescription>
              Pricing, sourcing, and whether this is the grade included in base price.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-4">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="option-name">Name</Label>
              <Input id="option-name" name="name" required defaultValue={option?.name ?? ""} className="rounded-none" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="option-description">Description</Label>
              <Input
                id="option-description"
                name="description"
                defaultValue={option?.description ?? ""}
                className="rounded-none"
              />
            </div>
            <div className="col-span-2">
              <OptionImageField value={image} onChange={setImage} disabled={pending} />
            </div>

            <div className="col-span-2 flex items-center justify-between border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="option-standard">Standard grade</Label>
                <p className="text-xs text-muted-foreground">
                  Included in base price. A category has one; promoting this demotes the previous one.
                </p>
              </div>
              <Switch id="option-standard" checked={isStandard} onCheckedChange={setIsStandard} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="option-price">Buyer price</Label>
              <Input
                id="option-price"
                name="price"
                type="number"
                min="0"
                step="0.01"
                disabled={isStandard}
                defaultValue={((option?.price_cents ?? 0) / 100).toFixed(2)}
                className="rounded-none"
              />
            </div>
            {canReadMargin && (
              <div className="space-y-1.5">
                <Label htmlFor="option-cost">Cost</Label>
                <Input
                  id="option-cost"
                  name="cost"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={((option?.cost_cents ?? 0) / 100).toFixed(2)}
                  className="rounded-none"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="option-sku">SKU</Label>
              <Input id="option-sku" name="sku" defaultValue={option?.sku ?? ""} className="rounded-none" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="option-vendor">Vendor</Label>
              <Input id="option-vendor" name="vendor" defaultValue={option?.vendor ?? ""} className="rounded-none" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="option-lead">Lead time (days)</Label>
              <Input
                id="option-lead"
                name="leadTimeDays"
                type="number"
                min="0"
                max="3650"
                defaultValue={option?.lead_time_days ?? ""}
                className="rounded-none"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="option-scope">Scope</Label>
              <Select value={scope} onValueChange={(value) => setScope(value === "structural" ? "structural" : "design_studio")}>
                <SelectTrigger id="option-scope" className="rounded-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="design_studio">Design studio</SelectItem>
                  <SelectItem value="structural">Structural</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="col-span-2 flex items-center justify-between border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="option-available">Available to sell</Label>
                <p className="text-xs text-muted-foreground">
                  Turn off to retire an option without losing homes that already chose it.
                </p>
              </div>
              <Switch id="option-available" checked={isAvailable} onCheckedChange={setIsAvailable} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending} className="rounded-none">
              {option ? "Save option" : "Add option"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
