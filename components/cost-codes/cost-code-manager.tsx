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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  ChevronDown,
  Edit,
  FileText,
  HardHat,
  MoreHorizontal,
  Plus,
  RotateCw,
  Search,
  Trash2,
} from "@/components/icons"

import { unwrapAction } from "@/lib/action-result"

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
}

type SheetState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; code: CostCode }

type ViewFilter = "active" | "standard" | "custom" | "archived"

const PAGE_SIZE = 25

const EMPTY_FORM: CostCodeFormState = {
  code: "",
  name: "",
  parent_id: "",
  division: "",
  category: "",
  unit: "",
  is_reimbursable_default: true,
  default_markup_percent: "",
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

  const handleSeed = () => {
    if (!canManage) return
    startTransition(async () => {
      try {
        unwrapAction(await seedCostCodesAction())
        const refreshed = await listCostCodesAction(true)
        applyCodes(refreshed)
        toast.success("Default cost codes added")
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

  return (
    <>
      <Sheet open={sheet.mode !== "closed"} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
          style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
        >
          <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
            <SheetTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              {isEditSheet ? "Edit cost code" : "New cost code"}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              Manage coding, defaults, and cost-plus billing behavior for this code.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="flex flex-col gap-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cost-code-code">Code</Label>
                    <Input
                      id="cost-code-code"
                      placeholder="03-200"
                      value={form.code}
                      onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value }))}
                      disabled={!canManage}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cost-code-name">Name</Label>
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
                  <Label>Parent</Label>
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

                <div className="grid gap-4 md:grid-cols-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cost-code-division">Division</Label>
                    <Input
                      id="cost-code-division"
                      placeholder="03"
                      value={form.division}
                      onChange={(event) => setForm((prev) => ({ ...prev, division: event.target.value }))}
                      disabled={!canManage}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cost-code-category">Category</Label>
                    <Input
                      id="cost-code-category"
                      placeholder="concrete"
                      value={form.category}
                      onChange={(event) => setForm((prev) => ({ ...prev, category: event.target.value }))}
                      disabled={!canManage}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cost-code-unit">Unit</Label>
                    <Input
                      id="cost-code-unit"
                      placeholder="ea, sf, hr"
                      value={form.unit}
                      onChange={(event) => setForm((prev) => ({ ...prev, unit: event.target.value }))}
                      disabled={!canManage}
                    />
                  </div>
                </div>

                <div className="rounded-lg border bg-muted/20 p-4">
                  <div className="flex flex-col gap-4">
                    <div>
                      <h3 className="text-sm font-medium">Cost-plus defaults</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        These defaults decide whether captured costs flow to the billable ledger and which markup wins when no contract rule overrides it.
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-4 rounded-md border bg-background px-3 py-3">
                      <div className="min-w-0">
                        <Label htmlFor="cost-code-reimbursable">Reimbursable by default</Label>
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
                      <Label htmlFor="cost-code-markup">Default markup %</Label>
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

          <SheetFooter className="border-t bg-background/80 px-6 py-4 flex flex-row gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={closeSheet}>
              Cancel
            </Button>
            <Button
              type="button"
              className="flex-1"
              disabled={!canManage || isPending}
              onClick={handleSave}
            >
              {isPending ? "Saving..." : isEditSheet ? "Save changes" : "Create"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <div className="flex h-full min-h-[calc(100svh-7rem)] flex-col overflow-hidden border-t border-border/70 bg-background">
        <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative w-full md:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search cost codes..."
                className="pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="flex items-center">
              <Select value={viewFilter} onValueChange={(value) => setViewFilter(value as ViewFilter)}>
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active codes</SelectItem>
                  <SelectItem value="standard">Default codes</SelectItem>
                  <SelectItem value="custom">Custom codes</SelectItem>
                  <SelectItem value="archived">Archived codes</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex shrink-0">
            <ButtonGroup className="w-full sm:w-fit">
              <Button type="button" size="sm" onClick={openCreate} disabled={!canManage} className="flex-1 sm:flex-none">
                <Plus className="mr-2 h-4 w-4" />
                New code
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="sm" disabled={!canManage || isPending} className="px-2">
                    <ChevronDown className="h-4 w-4" />
                    <span className="sr-only">More cost code actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleSeed}>
                    <HardHat className="mr-2 h-4 w-4" />
                    Seed default codes
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ButtonGroup>
          </div>
        </div>

        {!canManage ? (
          <div className="border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
            You can view cost codes, but only org admins can edit them.
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-[136px] pl-4">Code</TableHead>
                <TableHead className="min-w-[280px]">Name</TableHead>
                <TableHead className="hidden md:table-cell w-[150px] text-center">Category</TableHead>
                <TableHead className="hidden lg:table-cell w-[132px] text-center">Billing</TableHead>
                <TableHead className="hidden lg:table-cell w-[112px] text-center">Markup</TableHead>
                <TableHead className="hidden xl:table-cell w-[108px] text-center">Source</TableHead>
                <TableHead className="w-[92px] pr-2" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((code) => (
                <TableRow key={code.id} className="group h-[64px] cursor-pointer hover:bg-muted/30" onClick={() => openEdit(code)}>
                  <TableCell className="pl-4">
                    <span className={cn("font-mono text-sm font-semibold tabular-nums", code.is_active === false && "text-muted-foreground line-through")}>
                      {code.code}
                    </span>
                  </TableCell>
                  <TableCell className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${code.depth * 18}px` }}>
                      {code.depth > 0 ? <ChevronDown className="h-3.5 w-3.5 shrink-0 -rotate-90 text-muted-foreground" /> : null}
                      <div className="min-w-0">
                        <span className="block truncate text-sm font-medium">{code.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {code.division ? `Div ${code.division}` : "General"}
                          {code.unit ? ` · ${code.unit}` : ""}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-center">
                    <span className="text-xs text-muted-foreground">{code.category || "—"}</span>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-center">
                    <Badge variant={code.is_reimbursable_default === false ? "secondary" : "outline"} className="text-[10px] px-1 py-0 h-5 font-normal">
                      {code.is_reimbursable_default === false ? "Non-reimb." : "Reimb."}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-center">
                    <span className="text-xs text-muted-foreground">
                      {code.default_markup_percent == null ? "Contract" : `${code.default_markup_percent}%`}
                    </span>
                  </TableCell>
                  <TableCell className="hidden xl:table-cell text-center">
                    <Badge variant={code.standard === "custom" ? "default" : "outline"} className="text-[10px] px-1 py-0 h-5 font-normal capitalize">
                      {code.standard ?? "custom"}
                    </Badge>
                  </TableCell>
                  <TableCell className="pr-2" onClick={(event) => event.stopPropagation()}>
                    <div className="flex items-center justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100">
                            <MoreHorizontal className="h-3.5 w-3.5" />
                            <span className="sr-only">Cost code actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(code)}>
                            <Edit className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleToggleActive(code)} disabled={!canManage}>
                            {code.is_active === false ? <RotateCw className="mr-2 h-4 w-4" /> : <Trash2 className="mr-2 h-4 w-4" />}
                            {code.is_active === false ? "Restore" : "Archive"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-48 text-center text-muted-foreground hover:bg-transparent">
                    <div className="flex flex-col items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                        <FileText className="h-6 w-6" />
                      </div>
                      <div className="max-w-[400px] text-center">
                        <p className="font-medium">No cost codes found</p>
                        <p className="mt-0.5 text-sm text-muted-foreground">Adjust the filters or create a new code.</p>
                      </div>
                      <div className="mt-2">
                        <Button variant="default" size="sm" onClick={openCreate} disabled={!canManage}>
                          <Plus className="mr-2 h-4 w-4" />
                          Create cost code
                        </Button>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <div className="sticky bottom-0 z-20 flex shrink-0 flex-col gap-3 border-t bg-background px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {pageStart}-{pageEnd} of {rows.length} cost codes
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>
              Previous
            </Button>
            <span className="min-w-20 text-center text-sm text-muted-foreground">
              Page {page} of {pageCount}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount}>
              Next
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
