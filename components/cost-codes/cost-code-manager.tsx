"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import type { CostCode } from "@/lib/types"
import {
  createCostCodeAction,
  importCostCodesAction,
  listCostCodesAction,
  seedCostCodesAction,
  setCostCodeActiveAction,
  updateCostCodeAction,
} from "@/app/(app)/settings/cost-codes/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { ChevronRight, ChevronDown, Upload, HardHat, Search, Plus, Edit, RotateCw, Trash2 } from "@/components/icons"

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
}

const EMPTY_FORM: CostCodeFormState = {
  code: "",
  name: "",
  parent_id: "",
  division: "",
  category: "",
  unit: "",
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

function normalizeOptional(value: string) {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function CostCodeManager({ costCodes, canManage = true, onCostCodesChange }: CostCodeManagerProps) {
  const [csv, setCsv] = useState("")
  const [query, setQuery] = useState("")
  const [showInactive, setShowInactive] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [isPending, startTransition] = useTransition()
  const [localCodes, setLocalCodes] = useState(costCodes)
  const [createForm, setCreateForm] = useState<CostCodeFormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<CostCodeFormState>(EMPTY_FORM)

  const applyCodes = (codes: CostCode[]) => {
    setLocalCodes(codes)
    onCostCodesChange?.(codes)
  }

  useEffect(() => {
    setLocalCodes(costCodes)
  }, [costCodes])

  const refreshCodes = () => {
    startTransition(async () => {
      try {
        const refreshed = await listCostCodesAction(true)
        applyCodes(refreshed)
      } catch (error: any) {
        toast.error("Failed to refresh cost codes", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const activeCodes = useMemo(() => localCodes.filter((code) => code.is_active !== false), [localCodes])

  const filteredCodes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return localCodes.filter((code) => {
      if (!showInactive && code.is_active === false) return false
      if (!normalizedQuery) return true
      const haystack = [code.code, code.name, code.division, code.category, code.unit].filter(Boolean).join(" ").toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [localCodes, showInactive, query])

  const tree = useMemo(() => buildTree(filteredCodes), [filteredCodes])

  const handleSeed = () => {
    if (!canManage) return
    startTransition(async () => {
      try {
        await seedCostCodesAction()
        const refreshed = await listCostCodesAction(true)
        applyCodes(refreshed)
        toast.success("NAHB cost codes added")
      } catch (error: any) {
        toast.error("Failed to seed cost codes", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const handleImport = () => {
    if (!canManage) return
    startTransition(async () => {
      try {
        await importCostCodesAction(csv)
        const refreshed = await listCostCodesAction(true)
        applyCodes(refreshed)
        setCsv("")
        toast.success("Cost codes imported")
      } catch (error: any) {
        toast.error("Import failed", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const handleCreate = () => {
    if (!canManage) return
    if (!createForm.code.trim() || !createForm.name.trim()) {
      toast.error("Code and name are required")
      return
    }
    startTransition(async () => {
      try {
        await createCostCodeAction({
          code: createForm.code,
          name: createForm.name,
          parent_id: normalizeOptional(createForm.parent_id),
          division: normalizeOptional(createForm.division),
          category: normalizeOptional(createForm.category),
          unit: normalizeOptional(createForm.unit),
        })
        const refreshed = await listCostCodesAction(true)
        applyCodes(refreshed)
        setCreateForm(EMPTY_FORM)
        toast.success("Cost code created")
      } catch (error: any) {
        toast.error("Could not create cost code", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const startEdit = (code: CostCode) => {
    setEditingId(code.id)
    setEditForm({
      code: code.code ?? "",
      name: code.name ?? "",
      parent_id: code.parent_id ?? "",
      division: code.division ?? "",
      category: code.category ?? "",
      unit: code.unit ?? "",
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditForm(EMPTY_FORM)
  }

  const handleSaveEdit = (id: string, isActive: boolean) => {
    if (!canManage) return
    if (!editForm.code.trim() || !editForm.name.trim()) {
      toast.error("Code and name are required")
      return
    }
    startTransition(async () => {
      try {
        await updateCostCodeAction({
          id,
          code: editForm.code,
          name: editForm.name,
          parent_id: normalizeOptional(editForm.parent_id),
          division: normalizeOptional(editForm.division),
          category: normalizeOptional(editForm.category),
          unit: normalizeOptional(editForm.unit),
          is_active: isActive,
        })
        const refreshed = await listCostCodesAction(true)
        applyCodes(refreshed)
        cancelEdit()
        toast.success("Cost code updated")
      } catch (error: any) {
        toast.error("Could not update cost code", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const handleToggleActive = (code: CostCode) => {
    if (!canManage) return
    startTransition(async () => {
      try {
        await setCostCodeActiveAction(code.id, code.is_active === false)
        const refreshed = await listCostCodesAction(true)
        applyCodes(refreshed)
        toast.success(code.is_active === false ? "Cost code restored" : "Cost code archived")
      } catch (error: any) {
        toast.error("Could not update cost code", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const renderNode = (node: TreeNode, depth = 0) => {
    const isExpanded = expanded[node.id] ?? depth < 1
    const hasChildren = node.children.length > 0
    const toggle = () => setExpanded((prev) => ({ ...prev, [node.id]: !isExpanded }))
    const isEditing = editingId === node.id

    return (
      <div key={node.id} className="pl-2">
        <div className="flex items-center gap-2 py-1">
          {hasChildren ? (
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={toggle}>
              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          ) : (
            <span className="h-6 w-6" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">
              {node.code} - {node.name}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {node.division ? `Div ${node.division}` : "General"}
              {node.category ? ` · ${node.category}` : ""}
              {node.unit ? ` · Unit ${node.unit}` : ""}
            </div>
          </div>
          {node.standard && (
            <Badge variant="outline" className="text-[10px] capitalize">
              {node.standard}
            </Badge>
          )}
          {node.is_active === false && (
            <Badge variant="secondary" className="text-[10px]">
              Archived
            </Badge>
          )}
          {canManage && (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(node)} disabled={isPending}>
                <Edit className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleToggleActive(node)} disabled={isPending}>
                {node.is_active === false ? <RotateCw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </div>
          )}
        </div>

        {isEditing && (
          <div className="ml-8 mb-3 mt-1 rounded-md border border-border/70 bg-muted/20 p-3 space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Code</Label>
                <Input value={editForm.code} onChange={(event) => setEditForm((prev) => ({ ...prev, code: event.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input value={editForm.name} onChange={(event) => setEditForm((prev) => ({ ...prev, name: event.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Parent</Label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={editForm.parent_id}
                  onChange={(event) => setEditForm((prev) => ({ ...prev, parent_id: event.target.value }))}
                >
                  <option value="">No parent</option>
                  {activeCodes
                    .filter((code) => code.id !== node.id)
                    .map((code) => (
                      <option key={code.id} value={code.id}>
                        {code.code} - {code.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Division</Label>
                <Input value={editForm.division} onChange={(event) => setEditForm((prev) => ({ ...prev, division: event.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Category</Label>
                <Input value={editForm.category} onChange={(event) => setEditForm((prev) => ({ ...prev, category: event.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Unit</Label>
                <Input value={editForm.unit} onChange={(event) => setEditForm((prev) => ({ ...prev, unit: event.target.value }))} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => handleSaveEdit(node.id, node.is_active !== false)} disabled={isPending}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={isPending}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {hasChildren && isExpanded && (
          <div className="pl-6 border-l border-muted ml-3">{node.children.map((child) => renderNode(child, depth + 1))}</div>
        )}
      </div>
    )
  }

  const archivedCount = localCodes.filter((code) => code.is_active === false).length

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Cost code library</CardTitle>
            <CardDescription>Manage your org-level cost code structure for budgets, invoices, and commitments.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{activeCodes.length} active</Badge>
            {archivedCount > 0 && <Badge variant="secondary">{archivedCount} archived</Badge>}
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative w-full sm:max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search cost codes..." value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <Button type="button" variant={showInactive ? "secondary" : "outline"} size="sm" onClick={() => setShowInactive((prev) => !prev)}>
              {showInactive ? "Hide archived" : "Show archived"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={refreshCodes} disabled={isPending}>
              Refresh
            </Button>
          </div>
          <ScrollArea className="h-[560px] pr-4">
            {tree.length === 0 ? (
              <div className="text-sm text-muted-foreground">No cost codes match your filters.</div>
            ) : (
              <div className="space-y-2">{tree.map((node) => renderNode(node))}</div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Manage</CardTitle>
          <CardDescription>Create, seed, and import cost codes.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canManage && (
            <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              You can view cost codes, but only org admins can edit them.
            </div>
          )}

          <div className="space-y-2">
            <Label>Add cost code</Label>
            <div className="space-y-2">
              <Input
                placeholder="Code (e.g. 03-200)"
                value={createForm.code}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, code: event.target.value }))}
                disabled={!canManage}
              />
              <Input
                placeholder="Name"
                value={createForm.name}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, name: event.target.value }))}
                disabled={!canManage}
              />
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={createForm.parent_id}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, parent_id: event.target.value }))}
                disabled={!canManage}
              >
                <option value="">No parent</option>
                {activeCodes.map((code) => (
                  <option key={code.id} value={code.id}>
                    {code.code} - {code.name}
                  </option>
                ))}
              </select>
              <Input
                placeholder="Division (optional)"
                value={createForm.division}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, division: event.target.value }))}
                disabled={!canManage}
              />
              <Input
                placeholder="Category (optional)"
                value={createForm.category}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, category: event.target.value }))}
                disabled={!canManage}
              />
              <Input
                placeholder="Unit (optional)"
                value={createForm.unit}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, unit: event.target.value }))}
                disabled={!canManage}
              />
              <Button className="w-full" onClick={handleCreate} disabled={!canManage || isPending}>
                <Plus className="h-4 w-4 mr-2" />
                Create code
              </Button>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Button className="w-full" onClick={handleSeed} disabled={!canManage || isPending}>
              <HardHat className="h-4 w-4 mr-2" />
              Seed NAHB codes
            </Button>
            <p className="text-xs text-muted-foreground">Idempotent upsert on org + code.</p>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label htmlFor="csv">CSV rows</Label>
            <Textarea
              id="csv"
              placeholder="03-200,Foundation Walls,03,concrete"
              rows={6}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              disabled={!canManage}
            />
            <Button className="w-full" variant="secondary" onClick={handleImport} disabled={!canManage || isPending || csv.trim().length === 0}>
              <Upload className="h-4 w-4 mr-2" />
              Import CSV
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
