"use client"

import { Layers, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import type { BudgetLineOption, CostCode } from "@/lib/types"
import { cn } from "@/lib/utils"
import { parseDollarsToCents, type SplitLine } from "./payable-form"

type ProjectBillingModel = "fixed_price" | "cost_plus_percent" | "cost_plus_fixed_fee" | "cost_plus_gmp" | "time_and_materials"
export type ProjectOption = { id: string; name: string; billingModel: ProjectBillingModel }

export function supportsBillableCosts(billingModel?: ProjectBillingModel) {
  return Boolean(billingModel && billingModel !== "fixed_price")
}

interface PayableLinesEditorProps {
  lines: SplitLine[]
  onLinesChange: (updater: (lines: SplitLine[]) => SplitLine[]) => void
  locked: boolean
  isVendorCredit: boolean
  isReassignable: boolean
  projects: ProjectOption[]
  costCodes: CostCode[]
  costCodesEnabled: boolean
  budgetLines: BudgetLineOption[]
  accountingEnabled: boolean
  qboExpenseAccounts: { id: string; name: string }[]
  qboApAccounts: { id: string; name: string }[]
  billTotalCents: number
  fallbackProjectId: string
  defaultDescription: string
  headerQboExpenseAccountId: string
  headerQboApAccountId: string
  defaultBillable: (projectId?: string | null) => boolean
}

/**
 * Cost allocation: which project, which code, how much. One bill can split
 * across projects; the balance bar keeps the splits honest against the total.
 * Locked (post-approval) it renders as a read-only allocation table.
 */
export function PayableLinesEditor({
  lines,
  onLinesChange,
  locked,
  isVendorCredit,
  isReassignable,
  projects,
  costCodes,
  costCodesEnabled,
  budgetLines,
  accountingEnabled,
  qboExpenseAccounts,
  qboApAccounts,
  billTotalCents,
  fallbackProjectId,
  defaultDescription,
  headerQboExpenseAccountId,
  headerQboApAccountId,
  defaultBillable,
}: PayableLinesEditorProps) {
  const distinctProjects = Array.from(new Set(lines.map((line) => line.projectId).filter(Boolean)))
  const splitTotalCents = lines.reduce((sum, line) => sum + (parseDollarsToCents(line.amountDollars) ?? 0), 0)
  const balanced = splitTotalCents === billTotalCents
  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? "Project"
  const costCodeLabel = (id: string) => {
    const code = costCodes.find((entry) => entry.id === id)
    if (!code) return null
    return code.code ? `${code.code} · ${code.name}` : code.name
  }

  const updateLine = (lineId: string, patch: Partial<SplitLine>) =>
    onLinesChange((prev) => prev.map((line) => (line.id === lineId ? { ...line, ...patch } : line)))

  if (locked) {
    return (
      <section className="space-y-2">
        <h3 className="microlabel">Allocation</h3>
        <div className="divide-y border">
          {lines.map((line) => (
            <div key={line.id} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate">{line.description || defaultDescription}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {projectName(line.projectId)}
                  {costCodesEnabled && line.costCodeId && costCodeLabel(line.costCodeId) ? ` · ${costCodeLabel(line.costCodeId)}` : ""}
                  {line.billableToCustomer ? " · Billable to customer" : ""}
                </p>
              </div>
              <span className="shrink-0 font-mono text-sm tabular-nums">
                {formatMoneyFromCents(parseDollarsToCents(line.amountDollars) ?? 0)}
              </span>
            </div>
          ))}
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="microlabel">Allocation</h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() =>
            onLinesChange((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                projectId: fallbackProjectId,
                costCodeId: "",
                budgetLineId: prev[0]?.budgetLineId ?? "",
                description: defaultDescription,
                amountDollars: "0.00",
                qboExpenseAccountId: headerQboExpenseAccountId,
                qboApAccountId: headerQboApAccountId,
                billableToCustomer: defaultBillable(fallbackProjectId),
              },
            ])
          }
        >
          <Plus className="mr-1 h-3 w-3" />
          Split line
        </Button>
      </div>

      {distinctProjects.length > 1 ? (
        <div className="flex items-center gap-2 border bg-muted/40 px-3 py-1.5 text-[11px] font-medium">
          <Layers className="h-3.5 w-3.5 text-primary" />
          Split across {distinctProjects.length} projects — one {isVendorCredit ? "credit" : "bill"}, one payment.
        </div>
      ) : null}

      <div className="divide-y border">
        {lines.map((line) => {
          const billable = supportsBillableCosts(projects.find((project) => project.id === line.projectId)?.billingModel)
          return (
            <div key={line.id} className="space-y-3 p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label className="microlabel mb-1 block">Project</Label>
                  <Select
                    value={line.projectId}
                    onValueChange={(value) =>
                      updateLine(line.id, {
                        projectId: value,
                        billableToCustomer: supportsBillableCosts(projects.find((project) => project.id === value)?.billingModel)
                          ? line.billableToCustomer
                          : false,
                      })
                    }
                  >
                    <SelectTrigger className="h-9 w-full text-xs">
                      <SelectValue placeholder="Select project" />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id} className="text-xs">
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isReassignable ? (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Change line projects to split this {isVendorCredit ? "credit" : "bill"}; use Reassign to move it whole.
                    </p>
                  ) : null}
                </div>
                <div>
                  <Label className="microlabel mb-1 block">Amount</Label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-xs text-muted-foreground">$</span>
                      <Input
                        value={line.amountDollars}
                        inputMode="decimal"
                        className="h-9 pl-7 text-xs font-semibold tabular-nums"
                        onChange={(event) => updateLine(line.id, { amountDollars: event.target.value })}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9 shrink-0 text-muted-foreground hover:text-destructive"
                      disabled={lines.length === 1}
                      onClick={() => onLinesChange((prev) => prev.filter((item) => item.id !== line.id))}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="sr-only">Remove line</span>
                    </Button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {costCodesEnabled ? (
                  <div>
                    <Label className="microlabel mb-1 block">Cost code</Label>
                    <Select value={line.costCodeId} onValueChange={(value) => updateLine(line.id, { costCodeId: value })}>
                      <SelectTrigger className="h-9 w-full text-xs">
                        <SelectValue placeholder="Select cost code" />
                      </SelectTrigger>
                      <SelectContent>
                        {costCodes.map((code) => (
                          <SelectItem key={code.id} value={code.id} className="text-xs">
                            {code.code ? `${code.code} - ${code.name}` : code.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : budgetLines.length > 0 ? (
                  <div>
                    <Label className="microlabel mb-1 block">Budget line</Label>
                    <Select
                      value={line.budgetLineId || "__none__"}
                      onValueChange={(value) => updateLine(line.id, { budgetLineId: value === "__none__" ? "" : value })}
                    >
                      <SelectTrigger className="h-9 w-full text-xs">
                        <SelectValue placeholder="Select budget line" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__" className="text-xs">
                          Unassigned
                        </SelectItem>
                        {budgetLines.map((budgetLine) => (
                          <SelectItem key={budgetLine.id} value={budgetLine.id} className="text-xs">
                            {budgetLine.description?.trim() || "Untitled line"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                <div className={cn(!costCodesEnabled && budgetLines.length === 0 && "sm:col-span-2")}>
                  <Label className="microlabel mb-1 block">Description</Label>
                  <Input
                    value={line.description}
                    placeholder="What this line covers…"
                    className="h-9 text-xs"
                    onChange={(event) => updateLine(line.id, { description: event.target.value })}
                  />
                </div>
              </div>

              {!isVendorCredit && billable ? (
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor={`billable-${line.id}`} className="text-xs text-muted-foreground">
                    Billable to customer
                  </Label>
                  <Switch
                    id={`billable-${line.id}`}
                    checked={line.billableToCustomer}
                    onCheckedChange={(checked) => updateLine(line.id, { billableToCustomer: checked })}
                  />
                </div>
              ) : null}

              {accountingEnabled ? (
                <div className="grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-2">
                  <div>
                    <Label className="microlabel mb-1 block">QuickBooks category</Label>
                    <Select value={line.qboExpenseAccountId} onValueChange={(value) => updateLine(line.id, { qboExpenseAccountId: value })}>
                      <SelectTrigger className="h-9 w-full text-xs">
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                      <SelectContent>
                        {qboExpenseAccounts.map((account) => (
                          <SelectItem key={account.id} value={account.id} className="text-xs">
                            {account.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="microlabel mb-1 block">QuickBooks AP account</Label>
                    <Select value={line.qboApAccountId} onValueChange={(value) => updateLine(line.id, { qboApAccountId: value })}>
                      <SelectTrigger className="h-9 w-full text-xs">
                        <SelectValue placeholder="Select AP account" />
                      </SelectTrigger>
                      <SelectContent>
                        {qboApAccounts.map((account) => (
                          <SelectItem key={account.id} value={account.id} className="text-xs">
                            {account.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div
        className={cn(
          "flex items-center justify-between border px-3 py-2 text-xs font-medium tabular-nums",
          balanced ? "border-success/20 bg-success/10 text-success" : "border-warning/20 bg-warning/10 text-warning",
        )}
      >
        <span>
          Allocated {formatMoneyFromCents(splitTotalCents)} of {formatMoneyFromCents(billTotalCents)}
        </span>
        <span>{balanced ? "Balanced" : `${formatMoneyFromCents(billTotalCents - splitTotalCents)} unallocated`}</span>
      </div>
    </section>
  )
}
