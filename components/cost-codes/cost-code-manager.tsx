"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import type { CostCode } from "@/lib/types"
import { importCostCodesAction, listCostCodesAction, seedCostCodesAction } from "@/app/settings/cost-codes/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { ChevronRight, ChevronDown, Upload, HardHat } from "@/components/icons"

interface CostCodeManagerProps {
  costCodes: CostCode[]
}

interface TreeNode extends CostCode {
  children: TreeNode[]
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

export function CostCodeManager({ costCodes }: CostCodeManagerProps) {
  const [csv, setCsv] = useState("")
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [isPending, startTransition] = useTransition()
  const [localCodes, setLocalCodes] = useState(costCodes)

  const tree = useMemo(() => buildTree(localCodes), [localCodes])

  const handleSeed = () => {
    startTransition(async () => {
      try {
        await seedCostCodesAction()
        const refreshed = await listCostCodesAction()
        setLocalCodes(refreshed)
        toast.success("NAHB cost codes added")
      } catch (error: any) {
        console.error(error)
        toast.error("Failed to seed cost codes", { description: error?.message })
      }
    })
  }

  const handleImport = () => {
    startTransition(async () => {
      try {
        await importCostCodesAction(csv)
        const refreshed = await listCostCodesAction()
        setLocalCodes(refreshed)
        setCsv("")
        toast.success("Cost codes imported")
      } catch (error: any) {
        console.error(error)
        toast.error("Import failed", { description: error?.message })
      }
    })
  }

  const renderNode = (node: TreeNode, depth = 0) => {
    const isExpanded = expanded[node.id] ?? depth < 1
    const hasChildren = node.children.length > 0
    const toggle = () => setExpanded((prev) => ({ ...prev, [node.id]: !isExpanded }))

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
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              {node.code} — {node.name}
            </span>
            <span className="text-xs text-muted-foreground">
              {node.division ? `Div ${node.division}` : "General"}
              {node.category ? ` • ${node.category}` : ""}
            </span>
          </div>
          {node.standard && (
            <Badge variant="outline" className="ml-2 text-xs capitalize">
              {node.standard}
            </Badge>
          )}
        </div>
        {hasChildren && isExpanded && (
          <div className="pl-6 border-l border-muted ml-3">{node.children.map((child) => renderNode(child, depth + 1))}</div>
        )}
      </div>
    )
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Cost code library</CardTitle>
            <CardDescription>Browse divisions, parents, and children.</CardDescription>
          </div>
          <Badge variant="outline">{localCodes.length} codes</Badge>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[520px] pr-4">
            {tree.length === 0 ? (
              <div className="text-sm text-muted-foreground">No cost codes yet. Seed or import to get started.</div>
            ) : (
              <div className="space-y-2">{tree.map((node) => renderNode(node))}</div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Seed & Import</CardTitle>
          <CardDescription>NAHB template or CSV (code,name,division,category)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Button className="w-full" onClick={handleSeed} disabled={isPending}>
              <HardHat className="h-4 w-4 mr-2" />
              Seed NAHB codes
            </Button>
            <p className="text-xs text-muted-foreground">Idempotent upsert on org_id + code.</p>
          </div>
          <Separator />
          <div className="space-y-2">
            <Label htmlFor="csv">CSV rows</Label>
            <Textarea
              id="csv"
              placeholder="01-000,General Requirements,01,general"
              rows={6}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
            />
            <Button className="w-full" variant="secondary" onClick={handleImport} disabled={isPending || csv.trim().length === 0}>
              <Upload className="h-4 w-4 mr-2" />
              Import CSV
            </Button>
          </div>
          <Separator />
          <div className="space-y-2">
            <Label>Quick add</Label>
            <div className="grid grid-cols-2 gap-2">
              <Input value="code,name,division,category" readOnly className="text-xs" />
              <Input value="01-100,Permits & Fees,01,general" readOnly className="text-xs" />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
