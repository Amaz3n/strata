"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  cloneOrgGroupsAction,
  upsertPackageAction,
  upsertSelectionGroupAction,
} from "@/app/(app)/design-studio/actions"
import type { CatalogDto, SelectionGroupDto } from "@/lib/services/option-catalog"
import { unwrapAction } from "@/lib/action-result"
import { StudioShell } from "@/components/design-studio/studio-shell"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Edit, Plus } from "@/components/icons"

import "./studio.css"

interface Props {
  groups: SelectionGroupDto[]
  catalog: CatalogDto
  communityId?: string
  communities: Array<{ id: string; name: string }>
  canManage: boolean
}

function money(cents: number | null | undefined) {
  if (cents == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

export function CutoffRules({ groups, catalog, communityId, communities, canManage }: Props) {
  const router = useRouter()
  const [groupTarget, setGroupTarget] = useState<{ group: SelectionGroupDto | null } | null>(null)
  const [packageOpen, setPackageOpen] = useState(false)
  const [anchor, setAnchor] = useState<"start" | "end">("start")
  const [categoryIds, setCategoryIds] = useState<string[]>([])
  const [packageOptionIds, setPackageOptionIds] = useState<string[]>([])
  const [pending, startTransition] = useTransition()

  const categoryById = useMemo(
    () => new Map(catalog.categories.map((category) => [category.id, category])),
    [catalog.categories],
  )

  function openGroup(group: SelectionGroupDto | null) {
    setAnchor(group?.cutoff_anchor ?? "start")
    setCategoryIds(group?.category_ids ?? [])
    setGroupTarget({ group })
  }

  function saveGroup(formData: FormData) {
    const group = groupTarget?.group ?? null
    startTransition(async () => {
      try {
        unwrapAction(
          await upsertSelectionGroupAction({
            id: group?.id ?? null,
            communityId: communityId ?? null,
            name: String(formData.get("name") ?? ""),
            scheduleTaskKey: String(formData.get("scheduleTaskKey") ?? ""),
            cutoffOffsetDays: Number(formData.get("cutoffOffsetDays") ?? -14),
            cutoffAnchor: anchor,
            sortOrder: group?.sort_order ?? groups.length,
            categoryIds,
          }),
        )
        setGroupTarget(null)
        toast.success(group ? "Cutoff rule updated" : "Cutoff rule added")
        router.refresh()
      } catch (error) {
        toast.error("Could not save the cutoff rule", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  function savePackage(formData: FormData) {
    if (packageOptionIds.length === 0) {
      toast.error("Choose at least one option")
      return
    }
    startTransition(async () => {
      try {
        unwrapAction(
          await upsertPackageAction({
            communityId: communityId ?? null,
            name: String(formData.get("name") ?? ""),
            description: String(formData.get("description") ?? "") || null,
            priceCents: Math.round(Number(formData.get("price") ?? 0) * 100),
            costCents: catalog.can_read_margin ? Math.round(Number(formData.get("cost") ?? 0) * 100) : null,
            isAvailable: true,
            sortOrder: catalog.packages.length,
            optionIds: packageOptionIds,
          }),
        )
        setPackageOpen(false)
        setPackageOptionIds([])
        toast.success("Package created")
        router.refresh()
      } catch (error) {
        toast.error("Could not create the package", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  function cloneDefaults() {
    if (!communityId) return
    startTransition(async () => {
      try {
        unwrapAction(await cloneOrgGroupsAction(communityId))
        toast.success("Organization rules copied to this community")
        router.refresh()
      } catch (error) {
        toast.error("Could not copy the rules", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  function toggle(list: string[], setList: (next: string[]) => void, id: string) {
    setList(list.includes(id) ? list.filter((value) => value !== id) : [...list, id])
  }

  return (
    <StudioShell
      active="rules"
      communityId={communityId}
      communities={communities}
      action={
        canManage ? (
          <div className="flex items-center gap-1.5">
            {communityId && groups.length === 0 && (
              <Button size="sm" variant="outline" className="h-8 rounded-none" disabled={pending} onClick={cloneDefaults}>
                Copy org rules
              </Button>
            )}
            <Button size="sm" className="h-8 rounded-none" onClick={() => openGroup(null)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Cutoff rule
            </Button>
          </div>
        ) : null
      }
    >
      <div className="flex flex-col gap-8 p-5">
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-semibold tracking-tight">Cutoff rules</h2>
            <p className="max-w-[70ch] text-[13px] text-muted-foreground">
              Each rule groups categories into one buyer deadline, anchored to a schedule task so the date follows the
              build rather than a calendar. Every sold home in scope gets these groups automatically.
            </p>
          </div>
          {groups.length === 0 ? (
            <div
              className="flex flex-col items-center gap-2 border px-6 py-16 text-center border-border"
            >
              <p className="text-sm font-medium">No cutoff rules yet</p>
              <p className="max-w-md text-[13px] text-muted-foreground">
                Without a rule, a sold home gets no selection deadlines and nothing appears on the runway.
              </p>
              {canManage && (
                <Button size="sm" variant="outline" className="mt-2 h-8 rounded-none" onClick={() => openGroup(null)}>
                  Add the first rule
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto border border-border">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr>
                    {["Group", "Categories", "Anchor task", "Cutoff", "Source", ""].map((heading, index) => (
                      <th
                        key={heading || index}
                        className="microlabel border-b px-3 py-2.5 text-left border-[var(--line-strong)]"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <tr key={group.id}>
                      <td className="border-b px-3 py-2.5 font-medium border-border">
                        {group.name}
                      </td>
                      <td className="border-b px-3 py-2.5 border-border">
                        {group.category_ids.map((id) => categoryById.get(id)?.name).filter(Boolean).join(", ") || "—"}
                      </td>
                      <td className="font-mono tabular-nums border-b px-3 py-2.5 text-[11.5px] border-border">
                        {group.schedule_task_key}
                      </td>
                      <td className="border-b px-3 py-2.5 border-border">
                        {Math.abs(group.cutoff_offset_days)} days {group.cutoff_offset_days <= 0 ? "before" : "after"}{" "}
                        {group.cutoff_anchor}
                      </td>
                      <td className="border-b px-3 py-2.5 border-border">
                        <span className="studio-pill">{group.community_id ? "community" : "org"}</span>
                      </td>
                      <td className="border-b px-3 py-2.5 text-right border-border">
                        {canManage && (
                          <Button size="sm" variant="outline" className="h-6 rounded-none px-2 text-[11px]" onClick={() => openGroup(group)}>
                            <Edit className="mr-1 h-3 w-3" />
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-[15px] font-semibold tracking-tight">Packages</h2>
              <p className="max-w-[70ch] text-[13px] text-muted-foreground">
                A bundle a buyer takes in one click during an appointment. One option per category, priced as a whole.
              </p>
            </div>
            {canManage && (
              <Button size="sm" variant="outline" className="h-8 rounded-none" onClick={() => setPackageOpen(true)}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                Package
              </Button>
            )}
          </div>
          {catalog.packages.length === 0 ? (
            <div
              className="flex flex-col items-center gap-2 border px-6 py-12 text-center border-border"
            >
              <p className="text-[13px] text-muted-foreground">
                No packages configured.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto border border-border">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr>
                    {["Package", "Scope", "Options", "Price", ...(catalog.can_read_margin ? ["Cost"] : [])].map((heading) => (
                      <th
                        key={heading}
                        className="microlabel border-b px-3 py-2.5 text-left border-[var(--line-strong)]"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {catalog.packages.map((item) => (
                    <tr key={item.id}>
                      <td className="border-b px-3 py-2.5 border-border">
                        <span className="block font-medium">{item.name}</span>
                        {item.description && (
                          <span className="block text-[11.5px] text-muted-foreground">
                            {item.description}
                          </span>
                        )}
                      </td>
                      <td className="border-b px-3 py-2.5 border-border">
                        <span className="studio-pill">{item.community_id ? "community" : "org"}</span>
                      </td>
                      <td className="font-mono tabular-nums border-b px-3 py-2.5 border-border">
                        {item.option_ids.length}
                      </td>
                      <td className="font-mono tabular-nums border-b px-3 py-2.5 border-border">
                        {money(item.price_cents)}
                      </td>
                      {catalog.can_read_margin && (
                        <td className="font-mono tabular-nums border-b px-3 py-2.5 border-border">
                          {money(item.cost_cents)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <Dialog open={Boolean(groupTarget)} onOpenChange={(open) => { if (!open) setGroupTarget(null) }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto rounded-none">
          <form action={saveGroup}>
            <DialogHeader>
              <DialogTitle>{groupTarget?.group ? `Edit ${groupTarget.group.name}` : "Add a cutoff rule"}</DialogTitle>
              <DialogDescription>
                Anchor the deadline to a schedule task key so it moves when the build moves.
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3 py-4">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="group-name">Name</Label>
                <Input id="group-name" name="name" required defaultValue={groupTarget?.group?.name ?? ""} className="rounded-none" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="group-task">Schedule task key</Label>
                <Input
                  id="group-task"
                  name="scheduleTaskKey"
                  required
                  placeholder="drywall-start"
                  defaultValue={groupTarget?.group?.schedule_task_key ?? ""}
                  className="rounded-none"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="group-offset">Offset days</Label>
                <Input
                  id="group-offset"
                  name="cutoffOffsetDays"
                  type="number"
                  min="-365"
                  max="365"
                  defaultValue={groupTarget?.group?.cutoff_offset_days ?? -14}
                  className="rounded-none"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="group-anchor">Anchor</Label>
                <Select value={anchor} onValueChange={(value) => setAnchor(value === "end" ? "end" : "start")}>
                  <SelectTrigger id="group-anchor" className="rounded-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="start">Task start</SelectItem>
                    <SelectItem value="end">Task end</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <fieldset className="col-span-2 space-y-2 border-t pt-3">
                <legend className="microlabel mb-1">Categories in this group</legend>
                {catalog.categories.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Add categories to the catalog first.</p>
                ) : (
                  catalog.categories.map((category) => (
                    <label key={category.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={categoryIds.includes(category.id)}
                        onCheckedChange={() => toggle(categoryIds, setCategoryIds, category.id)}
                      />
                      {category.name}
                    </label>
                  ))
                )}
              </fieldset>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={pending} className="rounded-none">
                {groupTarget?.group ? "Save rule" : "Add rule"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={packageOpen} onOpenChange={setPackageOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto rounded-none">
          <form action={savePackage}>
            <DialogHeader>
              <DialogTitle>New package</DialogTitle>
              <DialogDescription>Choose no more than one option from each category.</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3 py-4">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="package-name">Name</Label>
                <Input id="package-name" name="name" required className="rounded-none" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="package-description">Description</Label>
                <Input id="package-description" name="description" className="rounded-none" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="package-price">Price</Label>
                <Input id="package-price" name="price" type="number" min="0" step="0.01" defaultValue="0" className="rounded-none" />
              </div>
              {catalog.can_read_margin && (
                <div className="space-y-1.5">
                  <Label htmlFor="package-cost">Cost</Label>
                  <Input id="package-cost" name="cost" type="number" min="0" step="0.01" defaultValue="0" className="rounded-none" />
                </div>
              )}
              <div className="col-span-2 space-y-3 border-t pt-3">
                {catalog.categories.map((category) => (
                  <fieldset key={category.id}>
                    <legend className="microlabel mb-1">{category.name}</legend>
                    {category.options.map((option) => (
                      <label key={option.id} className="flex items-center gap-2 py-1 text-sm">
                        <Checkbox
                          checked={packageOptionIds.includes(option.id)}
                          onCheckedChange={() => toggle(packageOptionIds, setPackageOptionIds, option.id)}
                        />
                        {option.name}
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={pending} className="rounded-none">
                Create package
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </StudioShell>
  )
}
