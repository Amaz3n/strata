"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"

import type { Selection, SelectionCategory, SelectionOption } from "@/lib/types"
import { confirmGroupAction, selectOptionAction, selectPackageAction } from "./actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type PortalSelection = Omit<Selection, "cost_cents_snapshot"> & {
  effective_due_date?: string | null
  locked?: boolean
  group?: {
    id: string
    name: string
    cutoff_date: string | null
    status: "open" | "locked"
  } | null
}

interface SelectionsData {
  selections: PortalSelection[]
  categories: SelectionCategory[]
  optionsByCategory: Record<string, Array<Omit<SelectionOption, "cost_cents" | "cost_code_id" | "vendor">>>
  packages: Array<{ id: string; name: string; description: string | null; image_url: string | null; price_cents: number; option_ids: string[] }>
}

interface Props {
  token: string
  data: SelectionsData
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

function formatPriceLabel(option: Pick<SelectionOption, "price_type" | "price_delta_cents" | "price_cents">): string | undefined {
  if (option.price_type === "included") return "Included"
  const cents = option.price_delta_cents ?? option.price_cents
  if (cents == null || cents === 0) return cents === 0 ? "Included" : undefined
  const amount = formatMoney(Math.abs(cents))
  if (option.price_type === "downgrade" || cents < 0) return `-${amount}`
  return `+${amount}`
}

function daysUntil(dateValue: string | null | undefined) {
  if (!dateValue) return null
  return Math.ceil((Date.parse(`${dateValue}T00:00:00`) - Date.now()) / 86_400_000)
}

export function SelectionsPortalClient({ token, data }: Props) {
  const [selections, setSelections] = useState(data.selections)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const categoriesById = useMemo(() => new Map(data.categories.map((category) => [category.id, category])), [data.categories])
  const grouped = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; cutoff: string | null; locked: boolean; items: PortalSelection[] }>()
    for (const selection of selections) {
      const key = selection.group_id ?? "ungrouped"
      const current = groups.get(key) ?? {
        id: key,
        name: selection.group?.name ?? "Selections",
        cutoff: selection.group?.cutoff_date ?? selection.due_date ?? null,
        locked: Boolean(selection.locked || selection.group?.status === "locked"),
        items: [],
      }
      current.items.push(selection)
      groups.set(key, current)
    }
    return Array.from(groups.values())
  }, [selections])

  function handleSelect(selectionId: string, optionId: string, groupId: string) {
    setPendingId(selectionId)
    setErrors((current) => ({ ...current, [groupId]: "" }))
    startTransition(async () => {
      const result = await selectOptionAction({ token, selectionId, optionId })
      if (!result.success) {
        setErrors((current) => ({ ...current, [groupId]: result.error }))
        setPendingId(null)
        return
      }
      setSelections((current) => current.map((selection) => selection.id === selectionId ? {
        ...selection,
        selected_option_id: optionId,
        selected_option: data.optionsByCategory[selection.category_id]?.find((option) => option.id === optionId) ?? null,
        status: "selected",
      } : selection))
      setPendingId(null)
    })
  }

  function handleConfirm(groupId: string) {
    setPendingId(groupId)
    setErrors((current) => ({ ...current, [groupId]: "" }))
    startTransition(async () => {
      const result = await confirmGroupAction({ token, groupId })
      if (!result.success) {
        setErrors((current) => ({ ...current, [groupId]: result.error }))
        setPendingId(null)
        return
      }
      setSelections((current) => current.map((selection) => selection.group_id === groupId ? { ...selection, status: "confirmed", confirmed_at: new Date().toISOString() } : selection))
      setPendingId(null)
    })
  }

  function handlePackage(packageId: string, groupId: string) {
    setPendingId(packageId)
    setErrors((current) => ({ ...current, [groupId]: "" }))
    startTransition(async () => {
      const result = await selectPackageAction({ token, packageId })
      if (!result.success) {
        setErrors((current) => ({ ...current, [groupId]: result.error }))
        setPendingId(null)
        return
      }
      const selectionPackage = data.packages.find((item) => item.id === packageId)
      const members = new Set(selectionPackage?.option_ids ?? [])
      setSelections((current) => current.map((selection) => {
        if (selection.group_id !== groupId) return selection
        const option = data.optionsByCategory[selection.category_id]?.find((candidate) => members.has(candidate.id))
        return option ? { ...selection, selected_option_id: option.id, selected_option: option, package_id: packageId, status: "selected" } : selection
      }))
      setPendingId(null)
    })
  }

  return (
    <main className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="border-b pb-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Project selections</p>
          <h1 className="mt-1 text-2xl font-semibold">Choose and confirm your finishes</h1>
          <p className="mt-1 text-sm text-muted-foreground">Complete each group before its deadline. Your builder will review the confirmed choices.</p>
        </header>

        {grouped.length === 0 && <div className="border p-8 text-center text-sm text-muted-foreground">No selections have been assigned yet.</div>}

        {grouped.map((group) => {
          const selectedCount = group.items.filter((item) => item.selected_option_id).length
          const allConfirmed = group.items.every((item) => item.status === "confirmed" || item.status === "ordered" || item.status === "received")
          const remaining = daysUntil(group.cutoff)
          return (
            <section key={group.id} className="border">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b bg-muted/30 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2"><h2 className="font-semibold">{group.name}</h2><Badge variant={group.locked ? "destructive" : allConfirmed ? "secondary" : "outline"} className="rounded-none">{group.locked ? "Locked" : allConfirmed ? "Confirmed" : "Open"}</Badge></div>
                  <p className={`mt-1 text-xs ${remaining != null && remaining < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                    {group.cutoff ? `Due ${format(new Date(`${group.cutoff}T00:00:00`), "MMM d")} — ${remaining != null && remaining >= 0 ? `${remaining} days left` : "deadline passed"}` : "Deadline pending schedule"}
                  </p>
                </div>
                <p className="text-sm tabular-nums text-muted-foreground">{selectedCount} of {group.items.length} selected</p>
              </div>

              {group.locked ? (
                <p className="px-4 py-5 text-sm text-muted-foreground">Locked — contact your builder to make changes.</p>
              ) : (
                <div className="divide-y">
                  {data.packages.filter((item) => {
                    const optionIds = new Set(item.option_ids)
                    return group.items.some((selection) => data.optionsByCategory[selection.category_id]?.some((option) => optionIds.has(option.id)))
                  }).map((item) => <div key={item.id} className="bg-muted/20 p-4"><button type="button" disabled={isPending || allConfirmed} onClick={() => handlePackage(item.id, group.id)} className="flex w-full items-center gap-3 border bg-background p-3 text-left hover:bg-muted/40">{item.image_url ? <img src={item.image_url} alt="" className="h-14 w-14 border object-cover" /> : <div className="h-14 w-14 border bg-muted" />}<span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{item.name}</span><span className="block text-xs text-muted-foreground">Includes {item.option_ids.length} selections{item.description ? ` — ${item.description}` : ""}</span></span><span className="text-sm font-medium tabular-nums">+{formatMoney(item.price_cents)}</span><Badge variant="outline" className="rounded-none">{pendingId === item.id && isPending ? <Spinner className="h-3.5 w-3.5" /> : "Choose package"}</Badge></button></div>)}
                  {group.items.map((selection) => {
                    const category = categoriesById.get(selection.category_id)
                    const options = data.optionsByCategory[selection.category_id] ?? []
                    return (
                      <div key={selection.id} className="p-4">
                        <div className="mb-3 flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{category?.name ?? "Selection"}</h3>{category?.description && <p className="mt-0.5 text-xs text-muted-foreground">{category.description}</p>}</div><Badge variant="outline" className="rounded-none text-[10px]">{selection.status}</Badge></div>
                        {options.length === 0 ? <p className="text-sm text-muted-foreground">No options are available.</p> : <div className="space-y-2">{options.map((option) => {
                          const selected = selection.selected_option_id === option.id
                          return <button key={option.id} type="button" disabled={isPending || allConfirmed} onClick={() => handleSelect(selection.id, option.id, group.id)} className={`flex w-full items-center gap-3 border p-2.5 text-left transition-colors ${selected ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
                            {option.image_url ? <img src={option.image_url} alt="" className="h-12 w-12 border object-cover" /> : <div className="h-12 w-12 border bg-muted" />}
                            <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{option.name}</span>{option.description && <span className="block truncate text-xs text-muted-foreground">{option.description}</span>}</span>
                            <span className="text-sm font-medium tabular-nums">{formatPriceLabel(option) ?? "—"}</span>
                            <Badge variant={selected ? "default" : "outline"} className="w-20 justify-center rounded-none">{pendingId === selection.id && isPending ? <Spinner className="h-3.5 w-3.5" /> : selected ? "Selected" : "Choose"}</Badge>
                          </button>
                        })}</div>}
                      </div>
                    )
                  })}
                </div>
              )}

              {!group.locked && group.id !== "ungrouped" && (
                <div className="border-t bg-muted/20 p-4">
                  <h3 className="mb-2 text-sm font-semibold">Review & confirm</h3>
                  <Table><TableHeader><TableRow><TableHead>Category</TableHead><TableHead>Choice</TableHead><TableHead className="text-right">Price</TableHead></TableRow></TableHeader><TableBody>{group.items.map((selection) => <TableRow key={selection.id}><TableCell>{categoriesById.get(selection.category_id)?.name ?? "Selection"}</TableCell><TableCell>{selection.selected_option?.name ?? "Not selected"}</TableCell><TableCell className="text-right tabular-nums">{selection.selected_option ? formatPriceLabel(selection.selected_option) ?? "—" : "—"}</TableCell></TableRow>)}</TableBody><TableFooter><TableRow><TableCell colSpan={2}>Group total</TableCell><TableCell className="text-right tabular-nums">{formatMoney(group.items.reduce((sum, item) => sum + Number(item.selected_option?.price_delta_cents ?? item.selected_option?.price_cents ?? 0), 0))}</TableCell></TableRow></TableFooter></Table>
                  {errors[group.id] && <p role="alert" className="mt-3 border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{errors[group.id]}</p>}
                  <div className="mt-3 flex justify-end"><Button className="rounded-none" disabled={isPending || selectedCount !== group.items.length || allConfirmed} onClick={() => handleConfirm(group.id)}>{pendingId === group.id && isPending && <Spinner className="mr-2 h-4 w-4" />}{allConfirmed ? "Confirmed" : "Confirm this group"}</Button></div>
                </div>
              )}
              {group.id === "ungrouped" && errors[group.id] && <p role="alert" className="m-4 border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{errors[group.id]}</p>}
            </section>
          )
        })}
      </div>
    </main>
  )
}
