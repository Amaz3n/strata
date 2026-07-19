"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  cloneOrgGroupsAction,
  upsertAppointmentAction,
  upsertCategoryAction,
  upsertOptionAction,
  upsertPackageAction,
  upsertSelectionGroupAction,
} from "@/app/(app)/design-studio/actions"
import type {
  CatalogDto,
  SelectionGroupDto,
} from "@/lib/services/option-catalog"
import { unwrapAction } from "@/lib/action-result"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus } from "@/components/icons"

type DeskRow = {
  id: string
  project_id: string
  group_id: string
  cutoff_date: string | null
  pending_count: number
  group: { name: string } | { name: string }[] | null
  project: { name: string } | { name: string }[] | null
}

type Desk = {
  upcomingAppointments: Array<{
    id: string
    community_id: string | null
    project_id: string
    contact_id: string | null
    coordinator_user_id: string | null
    scheduled_at: string
    duration_minutes: number
    location: string | null
    group_ids: string[]
    notes: string | null
    buyer_name?: string | null
    project_name?: string | null
    community_name?: string | null
    coordinator_name?: string | null
    status: string
  }>
  overdueSelections: DeskRow[]
  cutoffRisk: DeskRow[]
}

interface Props {
  communityId?: string
  communities: Array<{ id: string; name: string }>
  catalog: CatalogDto
  groups: SelectionGroupDto[]
  desk: Desk
  projects: Array<{ id: string; name: string }>
}

function money(cents: number | null | undefined) {
  if (cents == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value
}

export function DesignStudioClient({ communityId, communities, catalog, groups, desk, projects }: Props) {
  const router = useRouter()
  const [selectedCategoryId, setSelectedCategoryId] = useState(catalog.categories[0]?.id ?? "")
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [optionOpen, setOptionOpen] = useState(false)
  const [packageOpen, setPackageOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const [appointmentOpen, setAppointmentOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const selectedCategory = catalog.categories.find((category) => category.id === selectedCategoryId) ?? catalog.categories[0]
  const categoryById = useMemo(() => new Map(catalog.categories.map((category) => [category.id, category])), [catalog.categories])

  function chooseCommunity(value: string) {
    router.replace(value === "org" ? "/design-studio" : `/design-studio?community=${value}`)
  }

  function createCategory(formData: FormData) {
    startTransition(async () => {
      try {
        unwrapAction(await upsertCategoryAction({
          communityId: communityId ?? null,
          name: String(formData.get("name") ?? ""),
          description: String(formData.get("description") ?? "") || null,
          sortOrder: catalog.categories.length,
        }))
        setCategoryOpen(false)
        toast.success("Category created")
        router.refresh()
      } catch (error) {
        toast.error("Could not create category", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function createOption(formData: FormData) {
    if (!selectedCategory) return
    startTransition(async () => {
      try {
        unwrapAction(await upsertOptionAction({
          categoryId: selectedCategory.id,
          communityId: communityId ?? null,
          name: String(formData.get("name") ?? ""),
          description: String(formData.get("description") ?? "") || null,
          optionScope: formData.get("scope") === "structural" ? "structural" : "design_studio",
          sku: String(formData.get("sku") ?? "") || null,
          vendor: String(formData.get("vendor") ?? "") || null,
          priceCents: Math.round(Number(formData.get("price") ?? 0) * 100),
          costCents: Math.round(Number(formData.get("cost") ?? 0) * 100),
          sortOrder: selectedCategory.options.length,
          isAvailable: true,
        }))
        setOptionOpen(false)
        toast.success("Option created")
        router.refresh()
      } catch (error) {
        toast.error("Could not create option", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function cloneGroups() {
    if (!communityId) return
    startTransition(async () => {
      try {
        unwrapAction(await cloneOrgGroupsAction(communityId))
        toast.success("Organization groups cloned")
        router.refresh()
      } catch (error) {
        toast.error("Could not clone groups", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function createPackage(formData: FormData) {
    startTransition(async () => {
      try {
        unwrapAction(await upsertPackageAction({
          communityId: communityId ?? null,
          name: String(formData.get("name") ?? ""),
          description: String(formData.get("description") ?? "") || null,
          priceCents: Math.round(Number(formData.get("price") ?? 0) * 100),
          costCents: catalog.can_read_margin ? Math.round(Number(formData.get("cost") ?? 0) * 100) : null,
          isAvailable: true,
          sortOrder: catalog.packages.length,
          optionIds: formData.getAll("optionIds").map(String),
        }))
        setPackageOpen(false)
        toast.success("Package created")
        router.refresh()
      } catch (error) {
        toast.error("Could not create package", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function createGroup(formData: FormData) {
    startTransition(async () => {
      try {
        unwrapAction(await upsertSelectionGroupAction({
          communityId: communityId ?? null,
          name: String(formData.get("name") ?? ""),
          scheduleTaskKey: String(formData.get("scheduleTaskKey") ?? ""),
          cutoffOffsetDays: Number(formData.get("cutoffOffsetDays") ?? -14),
          cutoffAnchor: formData.get("cutoffAnchor") === "end" ? "end" : "start",
          sortOrder: groups.length,
          categoryIds: formData.getAll("categoryIds").map(String),
        }))
        setGroupOpen(false)
        toast.success("Selection group created")
        router.refresh()
      } catch (error) {
        toast.error("Could not create group", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function createAppointment(formData: FormData) {
    startTransition(async () => {
      try {
        const localDate = new Date(String(formData.get("scheduledAt") ?? ""))
        unwrapAction(await upsertAppointmentAction({
          communityId: communityId ?? null,
          projectId: String(formData.get("projectId") ?? ""),
          scheduledAt: localDate.toISOString(),
          durationMinutes: Number(formData.get("durationMinutes") ?? 120),
          location: String(formData.get("location") ?? "") || null,
          status: "scheduled",
          groupIds: [],
        }))
        setAppointmentOpen(false)
        toast.success("Appointment scheduled")
        router.refresh()
      } catch (error) {
        toast.error("Could not schedule appointment", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function updateAppointmentStatus(item: Desk["upcomingAppointments"][number], status: "completed" | "no_show" | "canceled") {
    startTransition(async () => {
      try {
        unwrapAction(await upsertAppointmentAction({
          id: item.id,
          communityId: item.community_id,
          projectId: item.project_id,
          contactId: item.contact_id,
          coordinatorUserId: item.coordinator_user_id,
          scheduledAt: item.scheduled_at,
          durationMinutes: item.duration_minutes,
          location: item.location,
          status,
          groupIds: item.group_ids,
          notes: item.notes,
        }))
        toast.success(`Appointment marked ${status.replace("_", " ")}`)
        router.refresh()
      } catch (error) {
        toast.error("Could not update appointment", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-sm font-medium">Option catalog and buyer deadlines</p>
          <p className="text-xs text-muted-foreground">Configure choices once, then coordinate every production lot.</p>
        </div>
        <Select value={communityId ?? "org"} onValueChange={chooseCommunity}>
          <SelectTrigger className="h-8 w-[240px] rounded-none"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="org">Org catalog</SelectItem>
            {communities.map((community) => <SelectItem key={community.id} value={community.id}>{community.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="catalog" className="min-h-0 flex-1">
        <TabsList className="h-10 w-full justify-start rounded-none border-b bg-transparent px-4">
          <TabsTrigger value="catalog" className="rounded-none">Catalog</TabsTrigger>
          <TabsTrigger value="packages" className="rounded-none">Packages</TabsTrigger>
          <TabsTrigger value="groups" className="rounded-none">Groups & cutoffs</TabsTrigger>
          <TabsTrigger value="appointments" className="rounded-none">Appointments</TabsTrigger>
        </TabsList>

        <TabsContent value="catalog" className="m-0 grid min-h-[560px] grid-cols-[260px_minmax(0,1fr)]">
          <aside className="border-r">
            <div className="flex h-11 items-center justify-between border-b px-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Categories</span>
              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-none" onClick={() => setCategoryOpen(true)}><Plus className="h-4 w-4" /></Button>
            </div>
            {catalog.categories.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No categories yet.</p> : catalog.categories.map((category) => (
              <button key={category.id} type="button" onClick={() => setSelectedCategoryId(category.id)} className={`flex w-full items-center justify-between border-b px-3 py-2 text-left text-sm ${selectedCategory?.id === category.id ? "bg-muted font-medium" : "hover:bg-muted/50"}`}>
                <span>{category.name}</span><span className="tabular-nums text-xs text-muted-foreground">{category.options.length}</span>
              </button>
            ))}
          </aside>
          <section className="min-w-0">
            <div className="flex h-11 items-center justify-between border-b px-3">
              <div><span className="text-sm font-medium">{selectedCategory?.name ?? "Options"}</span>{selectedCategory?.source !== "org" && <Badge variant="outline" className="ml-2 rounded-none text-[10px]">{selectedCategory?.source.replaceAll("_", " ")}</Badge>}</div>
              <Button size="sm" className="h-7 rounded-none" disabled={!selectedCategory} onClick={() => setOptionOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" />Option</Button>
            </div>
            <Table>
              <TableHeader><TableRow><TableHead>Option</TableHead><TableHead>Scope</TableHead><TableHead>SKU</TableHead><TableHead>Vendor</TableHead><TableHead className="text-right">Lead</TableHead>{catalog.can_read_margin && <TableHead className="text-right">Cost</TableHead>}<TableHead className="text-right">Price</TableHead>{catalog.can_read_margin && <TableHead className="text-right">Margin</TableHead>}<TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {(selectedCategory?.options ?? []).map((option) => {
                  const margin = option.price_cents && option.cost_cents != null ? Math.round(((option.price_cents - option.cost_cents) / option.price_cents) * 100) : null
                  return <TableRow key={option.id}><TableCell><div className="font-medium">{option.name}</div><div className="text-xs text-muted-foreground">{option.description}</div></TableCell><TableCell><Badge variant="outline" className="rounded-none text-[10px]">{option.option_scope === "structural" ? "Structural" : "Design"}</Badge></TableCell><TableCell className="text-xs">{option.sku ?? "—"}</TableCell><TableCell className="text-xs">{option.vendor ?? "—"}</TableCell><TableCell className="text-right tabular-nums">{option.lead_time_days == null ? "—" : `${option.lead_time_days}d`}</TableCell>{catalog.can_read_margin && <TableCell className="text-right tabular-nums">{money(option.cost_cents)}</TableCell>}<TableCell className="text-right tabular-nums">{money(option.price_cents)}</TableCell>{catalog.can_read_margin && <TableCell className="text-right tabular-nums">{margin == null ? "—" : `${margin}%`}</TableCell>}<TableCell><Badge variant={option.is_available ? "secondary" : "outline"} className="rounded-none">{option.is_available ? "Available" : "Unavailable"}</Badge></TableCell></TableRow>
                })}
                {!selectedCategory?.options.length && <TableRow><TableCell colSpan={9} className="h-32 text-center text-muted-foreground">No options in this category.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </section>
        </TabsContent>

        <TabsContent value="packages" className="m-0">
          <div className="flex h-11 items-center justify-between border-b px-4"><p className="text-sm text-muted-foreground">Bundles apply one option per covered category.</p><Button size="sm" className="h-7 rounded-none" onClick={() => setPackageOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" />Package</Button></div>
          <Table><TableHeader><TableRow><TableHead>Package</TableHead><TableHead>Community</TableHead><TableHead className="text-right">Members</TableHead>{catalog.can_read_margin && <TableHead className="text-right">Cost</TableHead>}<TableHead className="text-right">Price</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{catalog.packages.map((item) => <TableRow key={item.id}><TableCell><div className="font-medium">{item.name}</div><div className="text-xs text-muted-foreground">{item.description}</div></TableCell><TableCell>{item.community_id ? communities.find((community) => community.id === item.community_id)?.name ?? "Community" : "Org"}</TableCell><TableCell className="text-right tabular-nums">{item.option_ids.length}</TableCell>{catalog.can_read_margin && <TableCell className="text-right tabular-nums">{money(item.cost_cents)}</TableCell>}<TableCell className="text-right tabular-nums">{money(item.price_cents)}</TableCell><TableCell><Badge variant="secondary" className="rounded-none">{item.is_available ? "Available" : "Unavailable"}</Badge></TableCell></TableRow>)}{catalog.packages.length === 0 && <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">No packages configured.</TableCell></TableRow>}</TableBody></Table>
        </TabsContent>

        <TabsContent value="groups" className="m-0">
          <div className="flex h-11 items-center justify-between border-b px-4"><p className="text-sm text-muted-foreground">Schedule-anchored buyer decision windows</p><div className="flex gap-2">{communityId && groups.length === 0 && <Button size="sm" variant="outline" className="h-7 rounded-none" disabled={pending} onClick={cloneGroups}>Clone org defaults</Button>}<Button size="sm" className="h-7 rounded-none" onClick={() => setGroupOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" />Group</Button></div></div>
          <Table><TableHeader><TableRow><TableHead>Group</TableHead><TableHead>Categories</TableHead><TableHead>Schedule anchor</TableHead><TableHead>Cutoff rule</TableHead><TableHead>Source</TableHead></TableRow></TableHeader><TableBody>{groups.map((group) => <TableRow key={group.id}><TableCell className="font-medium">{group.name}</TableCell><TableCell>{group.category_ids.map((id) => categoryById.get(id)?.name).filter(Boolean).join(", ") || "—"}</TableCell><TableCell className="font-mono text-xs">{group.schedule_task_key}</TableCell><TableCell>{Math.abs(group.cutoff_offset_days)} days {group.cutoff_offset_days <= 0 ? "before" : "after"} {group.cutoff_anchor}</TableCell><TableCell>{group.community_id ? "Community" : "Org"}</TableCell></TableRow>)}{groups.length === 0 && <TableRow><TableCell colSpan={5} className="h-32 text-center text-muted-foreground">No selection groups configured.</TableCell></TableRow>}</TableBody></Table>
        </TabsContent>

        <TabsContent value="appointments" className="m-0 space-y-6 p-4">
          <div className="flex justify-end"><Button size="sm" className="h-7 rounded-none" onClick={() => setAppointmentOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" />Appointment</Button></div>
          <section className="border"><div className="border-b px-3 py-2"><h2 className="text-sm font-semibold">Upcoming appointments</h2><p className="text-xs text-muted-foreground">Showing up to 50 rows</p></div><Table><TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Buyer</TableHead><TableHead>Lot</TableHead><TableHead>Community</TableHead><TableHead>Coordinator</TableHead><TableHead>Status</TableHead><TableHead className="w-[210px]" /></TableRow></TableHeader><TableBody>{desk.upcomingAppointments.map((item) => <TableRow key={item.id}><TableCell>{new Date(item.scheduled_at).toLocaleString()}</TableCell><TableCell>{item.buyer_name ?? "—"}</TableCell><TableCell>{item.project_name ?? "—"}</TableCell><TableCell>{item.community_name ?? "—"}</TableCell><TableCell>{item.coordinator_name ?? "Unassigned"}</TableCell><TableCell><Badge variant="secondary" className="rounded-none">{item.status}</Badge></TableCell><TableCell className="text-right"><div className="flex justify-end gap-1"><Button size="sm" variant="outline" className="h-7 rounded-none" disabled={pending} onClick={() => updateAppointmentStatus(item, "completed")}>Complete</Button><Button size="sm" variant="ghost" className="h-7 rounded-none" disabled={pending} onClick={() => updateAppointmentStatus(item, "no_show")}>No-show</Button></div></TableCell></TableRow>)}{desk.upcomingAppointments.length === 0 && <TableRow><TableCell colSpan={7} className="h-20 text-center text-muted-foreground">No upcoming appointments.</TableCell></TableRow>}</TableBody></Table></section>
          <DeskSection title="Overdue selections" columns={["Lot", "Group", "Cutoff", "Days overdue", "Pending"]} rows={desk.overdueSelections.map((item) => [one(item.project)?.name ?? "—", one(item.group)?.name ?? "—", item.cutoff_date ?? "Unresolved", item.cutoff_date ? String(Math.max(0, Math.floor((Date.now() - Date.parse(`${item.cutoff_date}T00:00:00Z`)) / 86_400_000))) : "—", String(item.pending_count)])} />
          <DeskSection title="Cutoff risk" columns={["Lot", "Group", "Cutoff", "Pending"]} rows={desk.cutoffRisk.map((item) => [one(item.project)?.name ?? "—", one(item.group)?.name ?? "—", item.cutoff_date ?? "Unresolved", String(item.pending_count)])} />
        </TabsContent>
      </Tabs>

      <Dialog open={categoryOpen} onOpenChange={setCategoryOpen}><DialogContent className="rounded-none"><form action={createCategory}><DialogHeader><DialogTitle>New category</DialogTitle><DialogDescription>Add a category to the effective catalog.</DialogDescription></DialogHeader><div className="space-y-3 py-4"><Label htmlFor="category-name">Name</Label><Input id="category-name" name="name" required className="rounded-none" /><Label htmlFor="category-description">Description</Label><Input id="category-description" name="description" className="rounded-none" /></div><DialogFooter><Button type="submit" disabled={pending} className="rounded-none">Create category</Button></DialogFooter></form></DialogContent></Dialog>
      <Dialog open={optionOpen} onOpenChange={setOptionOpen}><DialogContent className="rounded-none"><form action={createOption}><DialogHeader><DialogTitle>New option</DialogTitle><DialogDescription>Add pricing and sourcing details for {selectedCategory?.name}.</DialogDescription></DialogHeader><div className="grid grid-cols-2 gap-3 py-4"><div className="col-span-2"><Label htmlFor="option-name">Name</Label><Input id="option-name" name="name" required className="rounded-none" /></div><div className="col-span-2"><Label htmlFor="option-description">Description</Label><Input id="option-description" name="description" className="rounded-none" /></div><div><Label htmlFor="option-scope">Scope</Label><select id="option-scope" name="scope" className="h-9 w-full border bg-background px-2 text-sm"><option value="design_studio">Design Studio</option><option value="structural">Structural</option></select></div><div><Label htmlFor="option-sku">SKU</Label><Input id="option-sku" name="sku" className="rounded-none" /></div><div><Label htmlFor="option-vendor">Vendor</Label><Input id="option-vendor" name="vendor" className="rounded-none" /></div><div><Label htmlFor="option-price">Price</Label><Input id="option-price" name="price" type="number" min="0" step="0.01" defaultValue="0" className="rounded-none" /></div>{catalog.can_read_margin && <div><Label htmlFor="option-cost">Cost</Label><Input id="option-cost" name="cost" type="number" min="0" step="0.01" defaultValue="0" className="rounded-none" /></div>}</div><DialogFooter><Button type="submit" disabled={pending} className="rounded-none">Create option</Button></DialogFooter></form></DialogContent></Dialog>
      <Dialog open={packageOpen} onOpenChange={setPackageOpen}><DialogContent className="max-h-[80vh] overflow-y-auto rounded-none"><form action={createPackage}><DialogHeader><DialogTitle>New package</DialogTitle><DialogDescription>Select no more than one option from each category.</DialogDescription></DialogHeader><div className="grid grid-cols-2 gap-3 py-4"><div className="col-span-2"><Label htmlFor="package-name">Name</Label><Input id="package-name" name="name" required className="rounded-none" /></div><div className="col-span-2"><Label htmlFor="package-description">Description</Label><Input id="package-description" name="description" className="rounded-none" /></div><div><Label htmlFor="package-price">Price</Label><Input id="package-price" name="price" type="number" min="0" step="0.01" defaultValue="0" className="rounded-none" /></div>{catalog.can_read_margin && <div><Label htmlFor="package-cost">Cost</Label><Input id="package-cost" name="cost" type="number" min="0" step="0.01" defaultValue="0" className="rounded-none" /></div>}<div className="col-span-2 space-y-3 border-t pt-3">{catalog.categories.map((category) => <fieldset key={category.id}><legend className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{category.name}</legend>{category.options.map((option) => <label key={option.id} className="flex items-center gap-2 py-1 text-sm"><input type="checkbox" name="optionIds" value={option.id} />{option.name}</label>)}</fieldset>)}</div></div><DialogFooter><Button type="submit" disabled={pending} className="rounded-none">Create package</Button></DialogFooter></form></DialogContent></Dialog>
      <Dialog open={groupOpen} onOpenChange={setGroupOpen}><DialogContent className="rounded-none"><form action={createGroup}><DialogHeader><DialogTitle>New selection group</DialogTitle><DialogDescription>Anchor this buyer deadline to a stable schedule task key.</DialogDescription></DialogHeader><div className="grid grid-cols-2 gap-3 py-4"><div className="col-span-2"><Label htmlFor="group-name">Name</Label><Input id="group-name" name="name" required className="rounded-none" /></div><div className="col-span-2"><Label htmlFor="group-task">Schedule task key</Label><Input id="group-task" name="scheduleTaskKey" required placeholder="drywall-start" className="rounded-none" /></div><div><Label htmlFor="group-offset">Offset days</Label><Input id="group-offset" name="cutoffOffsetDays" type="number" min="-365" max="365" defaultValue="-14" className="rounded-none" /></div><div><Label htmlFor="group-anchor">Anchor</Label><select id="group-anchor" name="cutoffAnchor" className="h-9 w-full border bg-background px-2 text-sm"><option value="start">Task start</option><option value="end">Task end</option></select></div><div className="col-span-2 border-t pt-3"><p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Categories</p>{catalog.categories.map((category) => <label key={category.id} className="flex items-center gap-2 py-1 text-sm"><input type="checkbox" name="categoryIds" value={category.id} />{category.name}</label>)}</div></div><DialogFooter><Button type="submit" disabled={pending} className="rounded-none">Create group</Button></DialogFooter></form></DialogContent></Dialog>
      <Dialog open={appointmentOpen} onOpenChange={setAppointmentOpen}><DialogContent className="rounded-none"><form action={createAppointment}><DialogHeader><DialogTitle>Schedule appointment</DialogTitle><DialogDescription>Create a buyer Design Studio session.</DialogDescription></DialogHeader><div className="space-y-3 py-4"><Label htmlFor="appointment-project">Project</Label><select id="appointment-project" name="projectId" required className="h-9 w-full border bg-background px-2 text-sm"><option value="">Choose a project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><Label htmlFor="appointment-time">Date and time</Label><Input id="appointment-time" name="scheduledAt" type="datetime-local" required className="rounded-none" /><Label htmlFor="appointment-duration">Duration (minutes)</Label><Input id="appointment-duration" name="durationMinutes" type="number" min="15" max="1440" defaultValue="120" className="rounded-none" /><Label htmlFor="appointment-location">Location</Label><Input id="appointment-location" name="location" className="rounded-none" /></div><DialogFooter><Button type="submit" disabled={pending} className="rounded-none">Schedule</Button></DialogFooter></form></DialogContent></Dialog>
    </div>
  )
}

function DeskSection({ title, columns, rows }: { title: string; columns: string[]; rows: string[][] }) {
  return <section className="border"><div className="border-b px-3 py-2"><h2 className="text-sm font-semibold">{title}</h2><p className="text-xs text-muted-foreground">Showing up to 50 rows</p></div><Table><TableHeader><TableRow>{columns.map((column) => <TableHead key={column}>{column}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map((row, index) => <TableRow key={`${title}-${index}`}>{row.map((cell, cellIndex) => <TableCell key={`${title}-${index}-${cellIndex}`} className={cellIndex >= columns.length - 2 ? "tabular-nums" : undefined}>{cell}</TableCell>)}</TableRow>)}{rows.length === 0 && <TableRow><TableCell colSpan={columns.length} className="h-20 text-center text-muted-foreground">Nothing to review.</TableCell></TableRow>}</TableBody></Table></section>
}
