"use client"

import { useState } from "react"
import { ChevronDown, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import type { BudgetLineOption, CostCode } from "@/lib/types"
import { cn } from "@/lib/utils"
import { inlineCell, inlineInput, inlineTrigger } from "./record-section"
import { parseDollarsToCents, type SplitLine } from "./payable-form"

type ProjectBillingModel =
  | "fixed_price"
  | "cost_plus_percent"
  | "cost_plus_fixed_fee"
  | "cost_plus_gmp"
  | "time_and_materials"
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
  accountingProviderName?: string | null
  accountingDimensions?: Array<{
    key: string
    label: string
    values: { id: string; name: string }[]
  }>
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
 * Cost allocation: which project, which code, how much.
 *
 * One table in both states. Locked it is a read-only ledger; unlocked the same
 * cells accept typing in place. The old editor rebuilt every line as a stack of
 * labelled form controls, which meant a two-line split bill rendered as a wall
 * of a dozen boxes for what is, in the end, a five-column table.
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
  accountingProviderName,
  accountingDimensions = [],
  qboExpenseAccounts,
  qboApAccounts,
  billTotalCents,
  fallbackProjectId,
  defaultDescription,
  headerQboExpenseAccountId,
  headerQboApAccountId,
  defaultBillable,
}: PayableLinesEditorProps) {
  const [showAccounting, setShowAccounting] = useState(false)

  const distinctProjects = Array.from(new Set(lines.map((line) => line.projectId).filter(Boolean)))
  const splitTotalCents = lines.reduce(
    (sum, line) => sum + (parseDollarsToCents(line.amountDollars) ?? 0),
    0,
  )
  const balanced = splitTotalCents === billTotalCents
  const projectName = (id: string) => id ? (projects.find((project) => project.id === id)?.name ?? "Project") : "Overhead"
  const costCodeLabel = (id: string) => {
    const code = costCodes.find((entry) => entry.id === id)
    if (!code) return null
    return code.code ? `${code.code} · ${code.name}` : code.name
  }
  const budgetLineLabel = (id: string) =>
    budgetLines.find((entry) => entry.id === id)?.description?.trim() || null

  const updateLine = (lineId: string, patch: Partial<SplitLine>) =>
    onLinesChange((prev) => prev.map((line) => (line.id === lineId ? { ...line, ...patch } : line)))

  const codingColumn = costCodesEnabled ? "cost_code" : budgetLines.length > 0 ? "budget_line" : null
  // Billable only means something on projects that can rebill their costs.
  const billableColumn =
    !isVendorCredit &&
    lines.some((line) =>
      supportsBillableCosts(projects.find((project) => project.id === line.projectId)?.billingModel),
    )
  const columnCount = 3 + (codingColumn ? 1 : 0) + (billableColumn ? 1 : 0) + (locked ? 0 : 1)

  if (!locked) {
    return (
      <div className="space-y-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold">Line items</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Coding fields adapt to the selected project and {accountingProviderName ?? "accounting setup"}.
            </p>
          </div>
          <p className="shrink-0 text-sm font-medium tabular-nums">{formatMoneyFromCents(splitTotalCents)}</p>
        </div>

        <div className="space-y-2">
          {lines.map((line, index) => {
            const billable = supportsBillableCosts(
              projects.find((project) => project.id === line.projectId)?.billingModel,
            )
            return (
              <div key={line.id} className="border bg-card px-3 py-3">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_2rem]">
                  <div className="min-w-0">
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor={`line-description-${line.id}`}>
                      Description
                    </label>
                    <Input
                      id={`line-description-${line.id}`}
                      value={line.description}
                      placeholder={defaultDescription}
                      className="h-9"
                      onChange={(event) => updateLine(line.id, { description: event.target.value })}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor={`line-amount-${line.id}`}>
                      Amount
                    </label>
                    <Input
                      id={`line-amount-${line.id}`}
                      value={line.amountDollars}
                      inputMode="decimal"
                      className="h-9 text-right tabular-nums"
                      onChange={(event) => updateLine(line.id, { amountDollars: event.target.value })}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9 text-muted-foreground hover:text-destructive"
                      disabled={lines.length === 1}
                      onClick={() => onLinesChange((prev) => prev.filter((item) => item.id !== line.id))}
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">Remove line {index + 1}</span>
                    </Button>
                  </div>
                </div>

                <div className="mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">Project</p>
                    <Select
                      value={line.projectId}
                      onValueChange={(value) =>
                        updateLine(line.id, {
                          projectId: value,
                          billableToCustomer: supportsBillableCosts(
                            projects.find((project) => project.id === value)?.billingModel,
                          ) ? line.billableToCustomer : false,
                        })
                      }
                    >
                      <SelectTrigger className="h-9 w-full min-w-0 overflow-hidden [&>span]:min-w-0 [&>span]:truncate"><SelectValue placeholder="Choose project" /></SelectTrigger>
                      <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-trigger-width)]">
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id}><span className="block truncate">{project.name}</span></SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {codingColumn === "cost_code" ? (
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Cost code</p>
                      <Select value={line.costCodeId} onValueChange={(value) => updateLine(line.id, { costCodeId: value })}>
                        <SelectTrigger className="h-9"><SelectValue placeholder="Choose cost code" /></SelectTrigger>
                        <SelectContent>
                          {costCodes.map((code) => (
                            <SelectItem key={code.id} value={code.id}>
                              {code.code ? `${code.code} · ${code.name}` : code.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}

                  {codingColumn === "budget_line" ? (
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Budget line</p>
                      <Select
                        value={line.budgetLineId || "__none__"}
                        onValueChange={(value) => updateLine(line.id, { budgetLineId: value === "__none__" ? "" : value })}
                      >
                        <SelectTrigger className="h-9"><SelectValue placeholder="Choose budget line" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Unassigned</SelectItem>
                          {budgetLines.map((budgetLine) => (
                            <SelectItem key={budgetLine.id} value={budgetLine.id}>
                              {budgetLine.description?.trim() || "Untitled line"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}

                  {accountingEnabled ? (
                    <div className="min-w-0">
                      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Expense account</p>
                      <Select value={line.qboExpenseAccountId} onValueChange={(value) => updateLine(line.id, { qboExpenseAccountId: value })} disabled={qboExpenseAccounts.length === 0}>
                        <SelectTrigger className="h-9 w-full min-w-0 overflow-hidden [&>span]:min-w-0 [&>span]:truncate">
                          <SelectValue placeholder={qboExpenseAccounts.length === 0 ? `${accountingProviderName ?? "Accounting"} accounts unavailable` : "Choose account"} />
                        </SelectTrigger>
                        <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-trigger-width)]">
                          {qboExpenseAccounts.map((account) => (
                            <SelectItem key={account.id} value={account.id}><span className="block truncate">{account.name}</span></SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}

                  {accountingDimensions.map((dimension) => {
                    const selected = line.accountingDimensions[dimension.key]
                    return (
                      <div key={dimension.key}>
                        <p className="mb-1.5 text-xs font-medium text-muted-foreground">{dimension.label}</p>
                        <Select
                          value={selected?.id ?? "__none__"}
                          onValueChange={(value) => {
                            const nextDimensions = { ...line.accountingDimensions }
                            if (value === "__none__") {
                              delete nextDimensions[dimension.key]
                            } else {
                              const option = dimension.values.find((entry) => entry.id === value)
                              if (option) nextDimensions[dimension.key] = option
                            }
                            updateLine(line.id, { accountingDimensions: nextDimensions })
                          }}
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder={`Choose ${dimension.label.toLowerCase()}`} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Not assigned</SelectItem>
                            {dimension.values.map((value) => (
                              <SelectItem key={value.id} value={value.id}>{value.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )
                  })}

                  {!isVendorCredit && billable ? (
                    <label className="flex h-9 items-center gap-2 self-end border px-3 text-sm">
                      <Checkbox
                        checked={line.billableToCustomer}
                        onCheckedChange={(checked) => updateLine(line.id, { billableToCustomer: checked === true })}
                      />
                      Billable
                    </label>
                  ) : null}
                </div>

                {accountingEnabled && qboApAccounts.length > 0 ? (
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="-ml-2 h-7 gap-1 px-2 text-xs text-muted-foreground"
                      onClick={() => setShowAccounting((open) => !open)}
                    >
                      <ChevronDown className={cn("size-3 transition-transform", showAccounting && "rotate-180")} />
                      {showAccounting ? "Hide advanced accounting" : "Advanced accounting"}
                    </Button>
                    {showAccounting ? (
                      <div className="mt-2 max-w-sm">
                        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Accounts payable account</p>
                        <Select value={line.qboApAccountId} onValueChange={(value) => updateLine(line.id, { qboApAccountId: value })}>
                          <SelectTrigger className="h-9"><SelectValue placeholder="Use accounting default" /></SelectTrigger>
                          <SelectContent>
                            {qboApAccounts.map((account) => (
                              <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 gap-1 px-2 text-xs text-muted-foreground"
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
                  accountingDimensions: { ...(prev[0]?.accountingDimensions ?? {}) },
                  billableToCustomer: defaultBillable(fallbackProjectId),
                },
              ])
            }
          >
            <Plus className="size-3.5" /> Add line item
          </Button>
          {!balanced ? (
            <p className="text-xs text-warning">
              Lines differ from the invoice total by {formatMoneyFromCents(billTotalCents - splitTotalCents)}
            </p>
          ) : (
            <p className="text-xs text-success">Line items match the invoice total.</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col />
          <col className="w-[22%]" />
          {codingColumn ? <col className="w-[20%]" /> : null}
          {billableColumn ? <col className="w-[68px]" /> : null}
          <col className="w-[120px]" />
          {!locked ? <col className="w-[32px]" /> : null}
        </colgroup>
        <thead>
          <tr className="border-b">
            <th className="microlabel py-2 text-left font-semibold">Description</th>
            <th className="microlabel py-2 text-left font-semibold">Project</th>
            {codingColumn ? (
              <th className="microlabel py-2 text-left font-semibold">
                {codingColumn === "cost_code" ? "Cost code" : "Budget line"}
              </th>
            ) : null}
            {billableColumn ? (
              <th className="microlabel py-2 text-left font-semibold">Billable</th>
            ) : null}
            <th className="microlabel py-1.5 text-right font-semibold">Amount</th>
            {!locked ? <th className="w-8" /> : null}
          </tr>
        </thead>
        <tbody className="divide-y">
          {lines.map((line) => {
            const billable = supportsBillableCosts(
              projects.find((project) => project.id === line.projectId)?.billingModel,
            )
            return (
              <tr key={line.id} className={locked ? "h-9" : undefined}>
                <td className="max-w-0 truncate py-1.5 pr-2">
                  {locked ? (
                    line.description || defaultDescription
                  ) : (
                    <Input
                      value={line.description}
                      placeholder={defaultDescription}
                      className={cn(inlineInput, "-ml-2")}
                      onChange={(event) => updateLine(line.id, { description: event.target.value })}
                    />
                  )}
                </td>

                <td className="max-w-0 truncate py-1.5 pr-2 text-muted-foreground">
                  {locked ? (
                    <span className="block truncate">{projectName(line.projectId)}</span>
                  ) : (
                    <Select
                      value={line.projectId}
                      onValueChange={(value) =>
                        updateLine(line.id, {
                          projectId: value,
                          billableToCustomer: supportsBillableCosts(
                            projects.find((project) => project.id === value)?.billingModel,
                          )
                            ? line.billableToCustomer
                            : false,
                        })
                      }
                    >
                      <SelectTrigger className={cn(inlineTrigger, "-ml-2 w-full min-w-0 overflow-hidden [&>span]:min-w-0 [&>span]:truncate")}>
                        <SelectValue placeholder="Select project" />
                      </SelectTrigger>
                      <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-trigger-width)]">
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id} className="text-sm">
                            <span className="block truncate">{project.name}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </td>

                {codingColumn === "cost_code" ? (
                  <td className="max-w-0 truncate py-1.5 pr-2 text-muted-foreground">
                    {locked ? (
                      (line.costCodeId && costCodeLabel(line.costCodeId)) || "Uncoded"
                    ) : (
                      <Select
                        value={line.costCodeId}
                        onValueChange={(value) => updateLine(line.id, { costCodeId: value })}
                      >
                        <SelectTrigger className={cn(inlineTrigger, "-ml-2")}>
                          <SelectValue placeholder="Uncoded" />
                        </SelectTrigger>
                        <SelectContent>
                          {costCodes.map((code) => (
                            <SelectItem key={code.id} value={code.id} className="text-sm">
                              {code.code ? `${code.code} · ${code.name}` : code.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </td>
                ) : null}

                {codingColumn === "budget_line" ? (
                  <td className="max-w-0 truncate py-1.5 pr-2 text-muted-foreground">
                    {locked ? (
                      (line.budgetLineId && budgetLineLabel(line.budgetLineId)) || "Unassigned"
                    ) : (
                      <Select
                        value={line.budgetLineId || "__none__"}
                        onValueChange={(value) =>
                          updateLine(line.id, { budgetLineId: value === "__none__" ? "" : value })
                        }
                      >
                        <SelectTrigger className={cn(inlineTrigger, "-ml-2")}>
                          <SelectValue placeholder="Unassigned" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__" className="text-sm">
                            Unassigned
                          </SelectItem>
                          {budgetLines.map((budgetLine) => (
                            <SelectItem
                              key={budgetLine.id}
                              value={budgetLine.id}
                              className="text-sm"
                            >
                              {budgetLine.description?.trim() || "Untitled line"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </td>
                ) : null}

                {billableColumn ? (
                  <td className="py-1.5 pr-2 text-muted-foreground">
                    {locked || !billable ? (
                      billable ? (
                        line.billableToCustomer ? (
                          "Yes"
                        ) : (
                          "No"
                        )
                      ) : (
                        "—"
                      )
                    ) : (
                      <button
                        type="button"
                        className={cn(inlineCell, line.billableToCustomer && "text-foreground")}
                        aria-pressed={line.billableToCustomer}
                        onClick={() =>
                          updateLine(line.id, { billableToCustomer: !line.billableToCustomer })
                        }
                      >
                        {line.billableToCustomer ? "Yes" : "No"}
                      </button>
                    )}
                  </td>
                ) : null}

                <td className="py-1.5 text-right font-mono tabular-nums">
                  {locked ? (
                    formatMoneyFromCents(parseDollarsToCents(line.amountDollars) ?? 0)
                  ) : (
                    <Input
                      value={line.amountDollars}
                      inputMode="decimal"
                      className={cn(inlineInput, "-mr-2 text-right font-mono tabular-nums")}
                      onChange={(event) => updateLine(line.id, { amountDollars: event.target.value })}
                    />
                  )}
                </td>

                {!locked ? (
                  <td className="py-1.5 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      disabled={lines.length === 1}
                      onClick={() => onLinesChange((prev) => prev.filter((item) => item.id !== line.id))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="sr-only">Remove line</span>
                    </Button>
                  </td>
                ) : null}
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t">
            <td className="py-1.5 text-xs text-muted-foreground" colSpan={columnCount - (locked ? 1 : 2)}>
              {lines.length} {lines.length === 1 ? "line" : "lines"}
              {distinctProjects.length > 1 ? ` across ${distinctProjects.length} projects` : ""}
            </td>
            <td className="py-1.5 text-right font-mono font-medium tabular-nums">
              {formatMoneyFromCents(splitTotalCents)}
            </td>
            {!locked ? <td /> : null}
          </tr>
          {!balanced ? (
            <tr>
              <td className="pb-1 text-xs text-warning" colSpan={columnCount - (locked ? 1 : 2)}>
                Does not match the bill total of {formatMoneyFromCents(billTotalCents)}
              </td>
              <td className="pb-1 text-right font-mono text-xs tabular-nums text-warning">
                {formatMoneyFromCents(billTotalCents - splitTotalCents)}
              </td>
              {!locked ? <td /> : null}
            </tr>
          ) : null}
        </tfoot>
      </table>

      {!locked ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-7 gap-1 px-2 text-xs text-muted-foreground"
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
                  accountingDimensions: { ...(prev[0]?.accountingDimensions ?? {}) },
                  billableToCustomer: defaultBillable(fallbackProjectId),
                },
              ])
            }
          >
            <Plus className="h-3 w-3" />
            Split across another line
          </Button>
          {isReassignable ? (
            <span className="text-xs text-muted-foreground">
              Change a line&apos;s project to split this {isVendorCredit ? "credit" : "bill"}; use
              Reassign to move it whole.
            </span>
          ) : null}
        </div>
      ) : null}

      {/*
        Per-line ledger accounts. Real, occasionally necessary, and wrong to put
        in the main table — two more columns of account names would crowd out the
        coding everyone actually reads.
      */}
      {accountingEnabled && !locked ? (
        <div className="border-t pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => setShowAccounting((open) => !open)}
          >
            <ChevronDown className={cn("h-3 w-3 transition-transform", showAccounting && "rotate-180")} />
            Ledger accounts per line
          </Button>
          {showAccounting ? (
            <div className="mt-2 space-y-3">
              {lines.map((line) => (
                <div key={line.id} className="grid gap-2 sm:grid-cols-2">
                  <Select
                    value={line.qboExpenseAccountId}
                    onValueChange={(value) => updateLine(line.id, { qboExpenseAccountId: value })}
                  >
                    <SelectTrigger className="h-8 w-full text-xs">
                      <SelectValue placeholder="Expense category" />
                    </SelectTrigger>
                    <SelectContent>
                      {qboExpenseAccounts.map((account) => (
                        <SelectItem key={account.id} value={account.id} className="text-xs">
                          {account.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={line.qboApAccountId}
                    onValueChange={(value) => updateLine(line.id, { qboApAccountId: value })}
                  >
                    <SelectTrigger className="h-8 w-full text-xs">
                      <SelectValue placeholder="AP account" />
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
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
