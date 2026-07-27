"use client"

import { type CSSProperties, useEffect, useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import type { CostCode } from "@/lib/types"
import {
  createCostCodeAction,
  listCostCodesAction,
  seedCostCodesAction,
  setCostCodeActiveAction,
  updateCostCodeAction,
} from "@/app/(app)/settings/cost-codes/actions"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import {
  ChevronDown,
  ChevronRight,
  Edit,
  HardHat,
  MoreHorizontal,
  Plus,
  RotateCw,
  Search,
  Tag,
  Trash2,
  XCircle,
} from "@/components/icons"

import { unwrapAction } from "@/lib/action-result"
import { COST_TYPE_LABELS, COST_TYPES, isCostType, type CostType } from "@/lib/cost-types"

interface CostCodeManagerProps {
  costCodes: CostCode[]
  canManage?: boolean
  onCostCodesChange?: (codes: CostCode[]) => void
}

interface TreeNode extends CostCode {
  children: TreeNode[]
}

type CostCodeFormState = {
  code: string
  name: string
  parent_id: string
  division: string
  category: string
  unit: string
  is_reimbursable_default: boolean
  default_markup_percent: string
  cost_type: CostType | ""
}

type SheetState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; code: CostCode }

type ViewFilter = "active" | "standard" | "custom" | "archived"

const VIEW_FILTERS: { value: ViewFilter; label: string }[] = [
  { value: "active", label: "Active codes" },
  { value: "standard", label: "Default codes" },
  { value: "custom", label: "Custom codes" },
  { value: "archived", label: "Archived codes" },
]

const PAGE_SIZE = 25

const TH = "microlabel sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-left whitespace-nowrap"
const TD = "px-3 py-2 align-middle"

const EMPTY_FORM: CostCodeFormState = {
  code: "",
  name: "",
  parent_id: "",
  division: "",
  category: "",
  unit: "",
  is_reimbursable_default: true,
  default_markup_percent: "",
  cost_type: "",
}

function buildTree(codes: CostCode[]): TreeNode[] {
  const map = new Map<string, TreeNode>()
  const roots: TreeNode[] = []

  codes.forEach((code) => {
    map.set(code.id, { ...code, children: [] })
  })

  map.forEach((node) => {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node)
    } else {
      roots.push(node)
    }
  })

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.code || "").localeCompare(b.code || ""))
    nodes.forEach((n) => sortNodes(n.children))
  }

  sortNodes(roots)
  return roots
}

function flattenTree(nodes: TreeNode[], depth = 0): Array<TreeNode & { depth: number }> {
  return nodes.flatMap((node) => [{ ...node, depth }, ...flattenTree(node.children, depth + 1)])
}

function normalizeOptional(value: string) {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeMarkup(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 200) {
    throw new Error("Markup must be between 0 and 200%.")
  }
  return parsed
}

function formFromCode(code: CostCode): CostCodeFormState {
  return {
    code: code.code ?? "",
    name: code.name ?? "",
    parent_id: code.parent_id ?? "",
    division: code.division ?? "",
    category: code.category ?? "",
    unit: code.unit ?? "",
    is_reimbursable_default: code.is_reimbursable_default !== false,
    default_markup_percent: code.default_markup_percent == null ? "" : String(code.default_markup_percent),
    cost_type: code.cost_type ?? "",
  }
}

export function CostCodeManager({ costCodes, canManage = true, onCostCodesChange }: CostCodeManagerProps) {
  const [query, setQuery] = useState("")
  const [viewFilter, setViewFilter] = useState<ViewFilter>("active")
  const [page, setPage] = useState(1)
  const [isPending, startTransition] = useTransition()
  const [localCodes, setLocalCodes] = useState(costCodes)
  const [sheet, setSheet] = useState<SheetState>({ mode: "closed" })
  const [form, setForm] = useState<CostCodeFormState>(EMPTY_FORM)

  const applyCodes = (codes: CostCode[]) => {
    setLocalCodes(codes)
    onCostCodesChange?.(codes)
  }

  useEffect(() => {
    setLocalCodes(costCodes)
  }, [costCodes])

  const activeCodes = useMemo(() => localCodes.filter((code) => code.is_active !== false), [localCodes])

  const filteredCodes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return localCodes.filter((code) => {
      if (viewFilter === "archived") {
        if (code.is_active !== false) return false
      } else {
        if (code.is_active === false) return false
        if (viewFilter === "custom" && code.standard !== "custom") return false
        if (viewFilter === "standard" && code.standard === "custom") return false
      }
      if (!normalizedQuery) return true
      const haystack = [
        code.code,
        code.name,
        code.division,
        code.category,
        code.unit,
        code.standard,
        code.cost_type,
        code.is_reimbursable_default === false ? "non reimbursable non-billable" : "reimbursable billable",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [localCodes, query, viewFilter])

  const rows = useMemo(() => flattenTree(buildTree(filteredCodes)), [filteredCodes])
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const visibleRows = useMemo(() => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [page, rows])
  const pageStart = rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const pageEnd = Math.min(page * PAGE_SIZE, rows.length)

  useEffect(() => {
    setPage(1)
  }, [query, viewFilter])

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount))
  }, [pageCount])

  const openCreate = () => {
    setForm(EMPTY_FORM)
    setSheet({ mode: "create" })
  }

  const openEdit = (code: CostCode) => {
    setForm(formFromCode(code))
    setSheet({ mode: "edit", code })
  }

  const closeSheet = () => {
    setSheet({ mode: "closed" })
    setForm(EMPTY_FORM)
  }

  const handleSeed = (standard: "nahb" | "csi") => {
    if (!canManage) return
    startTransition(async () => {
      try {
        unwrapAction(await seedCostCodesAction(standard))
        const refreshed = await listCostCodesAction(true)
        applyCodes(refreshed)
        toast.success(standard === "csi" ? "CSI cost codes added" : "NAHB cost codes added")
      } catch (error: any) {
        toast.error("Failed to seed default codes", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const handleSave = () => {
    if (!canManage || sheet.mode === "closed") return
    if (!form.code.trim() || !form.name.trim()) {
      toast.error("Code and name are required")
      return
    }

    startTransition(async () => {
      try {
        const defaultMarkupPercent = normalizeMarkup(form.default_markup_percent)
        if (sheet.mode === "create") {
          unwrapAction(await createCostCodeAction({
            code: form.code,
            name: form.name,
            parent_id: normalizeOptional(form.parent_id),
            division: normalizeOptional(form.division),
            category: normalizeOptional(form.category),
            unit: normalizeOptional(form.unit),
            is_reimbursable_default: form.is_reimbursable_default,
            default_markup_percent: defaultMarkupPercent,
            cost_type: form.cost_type || null,
          }))
          toast.success("Cost code created")
        } else {
          unwrapAction(await updateCostCodeAction({
            id: sheet.code.id,
            code: form.code,
            name: form.name,
            parent_id: normalizeOptional(form.parent_id),
            division: normalizeOptional(form.division),
            category: normalizeOptional(form.category),
            unit: normalizeOptional(form.unit),
            is_reimbursable_default: form.is_reimbursable_default,
            default_markup_percent: defaultMarkupPercent,
            is_active: sheet.code.is_active !== false,
            cost_type: form.cost_type || null,
          }))
          toast.success("Cost code updated")
        }
        const refreshed = await listCostCodesAction(true)
        applyCodes(refreshed)
        closeSheet()
      } catch (error: any) {
        toast.error("Could not save cost code", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const handleToggleActive = (code: CostCode) => {
    if (!canManage) return
    startTransition(async () => {
      try {
        unwrapAction(await setCostCodeActiveAction(code.id, code.is_active === false))
        const refreshed = await listCostCodesAction(true)
        applyCodes(refreshed)
        toast.success(code.is_active === false ? "Cost code restored" : "Cost code archived")
      } catch (error: any) {
        toast.error("Could not update cost code", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const isEditSheet = sheet.mode === "edit"
  const parentOptions = activeCodes.filter((code) => sheet.mode !== "edit" || code.id !== sheet.code.id)
  const hasCodes = localCodes.length > 0

  return (
    <>
      <Sheet open={sheet.mode !== "closed"} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="flex flex-col gap-0 p-0 sm:max-w-xl fast-sheet-animation"
          style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
        >
          <SheetHeader className="border-b border-border px-6 py-4">
            <SheetTitle className="text-sm font-medium">{isEditSheet ? "Edit cost code" : "New cost code"}</SheetTitle>
            <SheetDescription className="text-xs">
              Coding, defaults, and cost-plus billing behavior for this code.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="flex flex-col gap-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cost-code-code" className="microlabel">Code</Label>
                  <Input
                    id="cost-code-code"
                    placeholder="03-200"
                    value={form.code}
                    onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value }))}
                    disabled={!canManage}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cost-code-name" className="microlabel">Name</Label>
                  <Input
                    id="cost-code-name"
                    placeholder="Foundation Walls"
                    value={form.name}
                    onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                    disabled={!canManage}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="microlabel">Parent</Label>
                <Select
                  value={form.parent_id || "__none__"}
                  onValueChange={(value) => setForm((prev) => ({ ...prev, parent_id: value === "__none__" ? "" : value }))}
                  disabled={!canManage}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="No parent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No parent</SelectItem>
                    {parentOptions.map((code) => (
                      <SelectItem key={code.id} value={code.id}>
                        {code.code} - {code.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-4 md:grid-cols-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cost-code-division" className="microlabel">Division</Label>
                  <Input
                    id="cost-code-division"
                    placeholder="03"
                    value={form.division}
                    onChange={(event) => setForm((prev) => ({ ...prev, division: event.target.value }))}
                    disabled={!canManage}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="microlabel">Cost type</Label>
                  <Select
                    value={form.cost_type || "__none__"}
                    onValueChange={(value) => {
                      if (value === "__none__" || isCostType(value)) {
                        setForm((prev) => ({
                          ...prev,
                          cost_type: value === "__none__" ? "" : value,
                        }))
                      }
                    }}
                    disabled={!canManage}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Not set" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Not set</SelectItem>
                      {COST_TYPES.map((costType) => (
                        <SelectItem key={costType} value={costType}>
                          {COST_TYPE_LABELS[costType]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cost-code-category" className="microlabel">Category</Label>
                  <Input
                    id="cost-code-category"
                    placeholder="concrete"
                    value={form.category}
                    onChange={(event) => setForm((prev) => ({ ...prev, category: event.target.value }))}
                    disabled={!canManage}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cost-code-unit" className="microlabel">Unit</Label>
                  <Input
                    id="cost-code-unit"
                    placeholder="ea, sf, hr"
                    value={form.unit}
                    onChange={(event) => setForm((prev) => ({ ...prev, unit: event.target.value }))}
                    disabled={!canManage}
                  />
                </div>
              </div>

              <div className="border border-border bg-muted/20 p-4">
                <div className="flex flex-col gap-4">
                  <div>
                    <h3 className="text-sm font-medium">Cost-plus defaults</h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Decide whether captured costs flow to the billable ledger and which markup wins when no contract rule overrides it.
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-4 border border-border bg-background px-3 py-3">
                    <div className="min-w-0">
                      <Label htmlFor="cost-code-reimbursable" className="text-sm font-medium">Reimbursable by default</Label>
                      <p className="mt-1 text-xs text-muted-foreground">Turn off for overhead, rework, or internal costs.</p>
                    </div>
                    <Switch
                      id="cost-code-reimbursable"
                      checked={form.is_reimbursable_default}
                      onCheckedChange={(checked) => setForm((prev) => ({ ...prev, is_reimbursable_default: checked }))}
                      disabled={!canManage}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cost-code-markup" className="microlabel">Default markup %</Label>
                    <Input
                      id="cost-code-markup"
                      type="number"
                      min={0}
                      max={200}
                      step="0.01"
                      placeholder="Use contract default"
                      value={form.default_markup_percent}
                      onChange={(event) => setForm((prev) => ({ ...prev, default_markup_percent: event.target.value }))}
                      disabled={!canManage}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <SheetFooter className="flex flex-row gap-2 border-t border-border px-6 py-4">
            <Button type="button" variant="outline" size="sm" className="flex-1" onClick={closeSheet}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="flex-1"
              disabled={!canManage || isPending}
              onClick={handleSave}
            >
              {isPending ? "Saving…" : isEditSheet ? "Save changes" : "Create"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        {/* Toolbar */}
        <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <InputGroup className="h-8 w-full sm:w-72">
            <InputGroupAddon align="inline-start">
              <Search className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search code, name, division"
              aria-label="Search cost codes"
            />
            {query ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={() => setQuery("")} aria-label="Clear search">
                  <XCircle className="size-3.5" />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>

          <Select value={viewFilter} onValueChange={(value) => setViewFilter(value as ViewFilter)}>
            <SelectTrigger className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VIEW_FILTERS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex-1" />

          <ButtonGroup className="w-full sm:w-fit">
            <Button type="button" size="sm" className="h-8 flex-1 gap-1.5 sm:flex-none" onClick={openCreate} disabled={!canManage}>
              <Plus className="size-3.5" />
              New code
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" className="h-8 px-2" disabled={!canManage || isPending}>
                  <ChevronDown className="size-4" />
                  <span className="sr-only">More cost code actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => handleSeed("nahb")}>
                  <HardHat className="mr-2 size-4" />
                  Import NAHB cost codes
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleSeed("csi")}>
                  <HardHat className="mr-2 size-4" />
                  Import CSI cost codes
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        </div>

        {!canManage ? (
          <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
            You can view cost codes, but only organization admins can edit them.
          </div>
        ) : null}

        {/* Table */}
        <div className="relative min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? (
            <CostCodesEmpty hasCodes={hasCodes} filtered={query.trim() !== "" || viewFilter !== "active"} canManage={canManage} onCreate={openCreate} onClearFilters={() => { setQuery(""); setViewFilter("active") }} />
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={cn(TH, "w-[128px] pl-4")}>Code</th>
                  <th className={cn(TH, "min-w-[240px]")}>Name</th>
                  <th className={cn(TH, "hidden w-[140px] md:table-cell")}>Category</th>
                  <th className={cn(TH, "hidden w-[128px] lg:table-cell")}>Cost type</th>
                  <th className={cn(TH, "hidden w-[112px] lg:table-cell")}>Billing</th>
                  <th className={cn(TH, "hidden w-[100px] text-right lg:table-cell")}>Markup</th>
                  <th className={cn(TH, "hidden w-[96px] xl:table-cell")}>Source</th>
                  <th className={cn(TH, "w-11 pr-4")}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((code) => {
                  const archived = code.is_active === false
                  return (
                    <tr
                      key={code.id}
                      onClick={() => canManage && openEdit(code)}
                      className={cn(
                        "group border-b border-border transition-colors duration-150",
                        canManage && "cursor-pointer hover:bg-muted/40",
                        archived && "text-muted-foreground",
                      )}
                    >
                      <td className={cn(TD, "pl-4")}>
                        <span className={cn("font-mono text-sm font-medium tabular-nums", archived && "line-through")}>
                          {code.code}
                        </span>
                      </td>
                      <td className={cn(TD, "min-w-0")}>
                        <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${code.depth * 18}px` }}>
                          {code.depth > 0 ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" /> : null}
                          <div className="min-w-0">
                            <span className="block truncate font-medium text-foreground">{code.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {code.division ? `Div ${code.division}` : "General"}
                              {code.unit ? ` · ${code.unit}` : ""}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className={cn(TD, "hidden md:table-cell")}>
                        <span className="text-xs text-muted-foreground">{code.category || "—"}</span>
                      </td>
                      <td className={cn(TD, "hidden lg:table-cell")}>
                        <span className="text-xs text-muted-foreground">
                          {code.cost_type ? COST_TYPE_LABELS[code.cost_type] : "—"}
                        </span>
                      </td>
                      <td className={cn(TD, "hidden lg:table-cell")}>
                        <Badge variant={code.is_reimbursable_default === false ? "secondary" : "outline"} className="h-5 px-1.5 text-[10px] font-normal">
                          {code.is_reimbursable_default === false ? "Non-reimb." : "Reimb."}
                        </Badge>
                      </td>
                      <td className={cn(TD, "hidden text-right tabular-nums lg:table-cell")}>
                        <span className="text-xs text-muted-foreground">
                          {code.default_markup_percent == null ? "Contract" : `${code.default_markup_percent}%`}
                        </span>
                      </td>
                      <td className={cn(TD, "hidden xl:table-cell")}>
                        <Badge variant={code.standard === "custom" ? "default" : "outline"} className="h-5 px-1.5 text-[10px] font-normal capitalize">
                          {code.standard ?? "custom"}
                        </Badge>
                      </td>
                      <td className={cn(TD, "pr-4 text-right")} onClick={(event) => event.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                            >
                              <MoreHorizontal className="size-4" />
                              <span className="sr-only">Cost code actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(code)}>
                              <Edit className="mr-2 size-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleToggleActive(code)} disabled={!canManage}>
                              {archived ? <RotateCw className="mr-2 size-4" /> : <Trash2 className="mr-2 size-4" />}
                              {archived ? "Restore" : "Archive"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        {rows.length > 0 ? (
          <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/20 px-4">
            <span className="microlabel truncate">
              {pageStart}–{pageEnd} of {rows.length} cost codes
            </span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>
                Previous
              </Button>
              <span className="min-w-16 text-center text-xs tabular-nums text-muted-foreground">
                Page {page} of {pageCount}
              </span>
              <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount}>
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}

function CostCodesEmpty({
  hasCodes,
  filtered,
  canManage,
  onCreate,
  onClearFilters,
}: {
  hasCodes: boolean
  filtered: boolean
  canManage: boolean
  onCreate: () => void
  onClearFilters: () => void
}) {
  if (hasCodes && filtered) {
    return (
      <Empty className="min-h-0 border-0 py-20">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Search />
          </EmptyMedia>
          <EmptyTitle>No cost codes match</EmptyTitle>
          <EmptyDescription>Try a different search, or clear the filters to see every code.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            Clear filters
          </Button>
        </EmptyContent>
      </Empty>
    )
  }
  return (
    <Empty className="min-h-0 border-0 py-20">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Tag />
        </EmptyMedia>
        <EmptyTitle>No cost codes yet</EmptyTitle>
        <EmptyDescription>
          Build a library from scratch, or import a standard set (NAHB or CSI) to start. Costs, budgets, and invoices file under these codes.
        </EmptyDescription>
      </EmptyHeader>
      {canManage ? (
        <EmptyContent>
          <Button size="sm" onClick={onCreate}>
            <Plus className="mr-1.5 size-3.5" />
            New code
          </Button>
        </EmptyContent>
      ) : (
        <EmptyContent>
          <p className="text-xs text-muted-foreground">Ask an organization admin to add cost codes.</p>
        </EmptyContent>
      )}
    </Empty>
  )
}
