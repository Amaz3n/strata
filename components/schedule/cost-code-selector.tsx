"use client"

import { useState, useMemo } from "react"
import { cn } from "@/lib/utils"
import type { CostCode } from "@/lib/types"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { DollarSign } from "lucide-react"

interface CostCodeSelectorProps {
  costCodes: CostCode[]
  value?: string | null
  onValueChange: (value: string | undefined) => void
  placeholder?: string
  className?: string
}

interface TreeNode extends CostCode {
  children: TreeNode[]
  level: number
}

// Build hierarchical tree from flat cost code list
function buildCostCodeTree(codes: CostCode[]): TreeNode[] {
  const map = new Map<string, TreeNode>()
  const roots: TreeNode[] = []

  // First pass: create map
  codes.forEach((code) => {
    map.set(code.id, { ...code, children: [], level: 0 })
  })

  // Second pass: build tree and assign levels
  const assignLevel = (node: TreeNode, level: number) => {
    node.level = level
    node.children.forEach((child) => assignLevel(child, level + 1))
  }

  map.forEach((node) => {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node)
    } else {
      roots.push(node)
    }
  })

  // Sort alphabetically by code
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.code || "").localeCompare(b.code || ""))
    nodes.forEach((n) => sortNodes(n.children))
  }

  sortNodes(roots)
  roots.forEach((root) => assignLevel(root, 0))

  return roots
}

// Flatten tree for Select component
function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = []
  const traverse = (node: TreeNode) => {
    result.push(node)
    node.children.forEach(traverse)
  }
  nodes.forEach(traverse)
  return result
}

export function CostCodeSelector({
  costCodes,
  value,
  onValueChange,
  placeholder = "Select cost code",
  className,
}: CostCodeSelectorProps) {
  const tree = useMemo(() => buildCostCodeTree(costCodes), [costCodes])
  const flatCodes = useMemo(() => flattenTree(tree), [tree])

  // Group codes by division (top-level codes)
  const divisions = useMemo(() => {
    const divisionMap = new Map<string, TreeNode[]>()

    flatCodes.forEach((code) => {
      // Find the root parent (division)
      let division = code
      if (code.parent_id) {
        let current = code
        while (current.parent_id) {
          const parent = flatCodes.find((c) => c.id === current.parent_id)
          if (parent) {
            current = parent
          } else {
            break
          }
        }
        division = current
      }

      const divisionName = division.name || "Other"
      if (!divisionMap.has(divisionName)) {
        divisionMap.set(divisionName, [])
      }
      if (code.level > 0) {
        // Only show child codes in divisions, not the division itself
        divisionMap.get(divisionName)!.push(code)
      }
    })

    return Array.from(divisionMap.entries())
      .map(([name, codes]) => ({ name, codes }))
      .filter((d) => d.codes.length > 0)
  }, [flatCodes])

  const selectedCode = flatCodes.find((c) => c.id === value)

  return (
    <Select
      value={value || "__none__"}
      onValueChange={(val) => onValueChange(val === "__none__" ? undefined : val)}
    >
      <SelectTrigger className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder}>
          {selectedCode ? (
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                {selectedCode.code}
              </Badge>
              <span className="truncate">{selectedCode.name}</span>
            </div>
          ) : (
            placeholder
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-[400px]">
        <SelectItem value="__none__">
          <span className="text-muted-foreground">No cost code</span>
        </SelectItem>

        {costCodes.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground text-center">
            No cost codes available.
            <br />
            <span className="text-xs">Add cost codes in Settings → Cost Codes.</span>
          </div>
        ) : (
          divisions.map((division, idx) => (
            <SelectGroup key={division.name}>
              {idx > 0 && <Separator className="my-1" />}
              <SelectLabel className="flex items-center gap-2 text-xs">
                <DollarSign className="h-3 w-3" />
                {division.name}
              </SelectLabel>
              {division.codes.map((code) => (
                <SelectItem key={code.id} value={code.id}>
                  <div
                    className="flex items-center gap-2"
                    style={{
                      paddingLeft: `${Math.max(0, code.level - 1) * 12}px`,
                    }}
                  >
                    <Badge
                      variant="outline"
                      className="shrink-0 font-mono text-[10px]"
                    >
                      {code.code}
                    </Badge>
                    <span className="truncate text-xs">{code.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          ))
        )}
      </SelectContent>
    </Select>
  )
}
