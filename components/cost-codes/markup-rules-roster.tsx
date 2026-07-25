"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Percent, Plus, Trash2 } from "@/components/icons"
import { cn } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"

import {
  createMarkupRuleFormAction,
  deleteMarkupRuleFormAction,
  listMarkupRuleOptionsAction,
  listMarkupRulesAction,
} from "@/app/(app)/settings/cost-coding/markup-rules-actions"

type MarkupRule = Awaited<ReturnType<typeof listMarkupRulesAction>>[number]
type MarkupRuleOptions = Awaited<ReturnType<typeof listMarkupRuleOptionsAction>>
type MarkupRuleContract = MarkupRuleOptions["contracts"][number]
type Scope = MarkupRule["scope"]

const TH = "microlabel sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-left whitespace-nowrap"
const TD = "px-3 py-2 align-middle"

const SCOPE_LABEL: Record<Scope, string> = {
  org: "Org",
  contract: "Contract",
  cost_code: "Cost code",
}

interface MarkupRulesRosterProps {
  rules: MarkupRule[]
  options: MarkupRuleOptions
  canManage: boolean
}

export function MarkupRulesRoster({ rules, options, canManage }: MarkupRulesRosterProps) {
  const router = useRouter()
  const [items, setItems] = useState<MarkupRule[]>(rules)
  const [createOpen, setCreateOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<MarkupRule | null>(null)
  const [saving, startSave] = useTransition()
  const [deleting, startDelete] = useTransition()

  // Reconcile local state whenever the server re-renders with fresh data.
  useEffect(() => setItems(rules), [rules])

  const handleCreate = (values: RuleFormValues) => {
    startSave(async () => {
      try {
        const formData = new FormData()
        formData.set("scope", values.scope)
        if (values.scope === "contract" && values.contractId) formData.set("contract_id", values.contractId)
        if (values.scope === "cost_code" && values.costCodeId) formData.set("cost_code_id", values.costCodeId)
        formData.set("markup_percent", values.markupPercent.trim())
        if (values.effectiveFrom) formData.set("effective_from", values.effectiveFrom)
        if (values.effectiveTo) formData.set("effective_to", values.effectiveTo)

        unwrapAction(await createMarkupRuleFormAction(formData))
        setItems(await listMarkupRulesAction())
        setCreateOpen(false)
        toast.success("Markup rule added")
        router.refresh()
      } catch (error) {
        toast.error("Couldn't add markup rule", { description: (error as Error).message })
      }
    })
  }

  const handleDelete = (rule: MarkupRule) => {
    startDelete(async () => {
      try {
        unwrapAction(await deleteMarkupRuleFormAction(rule.id))
        setItems((prev) => prev.filter((entry) => entry.id !== rule.id))
        setConfirmDelete(null)
        toast.success("Markup rule deleted")
        router.refresh()
      } catch (error) {
        toast.error("Couldn't delete markup rule", { description: (error as Error).message })
      }
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <p className="hidden max-w-xl text-xs leading-5 text-muted-foreground sm:block">
          The narrowest matching rule wins: cost code beats contract, contract beats the org default.
        </p>
        <div className="flex-1" />
        <Button size="sm" className="h-8 gap-1.5" onClick={() => setCreateOpen(true)} disabled={!canManage}>
          <Plus className="size-3.5" />
          New rule
        </Button>
      </div>

      {!canManage ? (
        <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
          You can view markup rules, but only organization admins can edit them.
        </div>
      ) : null}

      {/* Table */}
      <div className="relative min-h-0 flex-1 overflow-auto">
        {items.length === 0 ? (
          <MarkupRulesEmpty canManage={canManage} onCreate={() => setCreateOpen(true)} />
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={cn(TH, "w-[128px] pl-4")}>Scope</th>
                <th className={cn(TH, "min-w-[240px]")}>Target</th>
                <th className={cn(TH, "w-[120px] text-right")}>Markup</th>
                <th className={cn(TH, "hidden w-[200px] md:table-cell")}>Effective</th>
                <th className={cn(TH, "w-11 pr-4")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((rule) => (
                <tr key={rule.id} className="group border-b border-border transition-colors duration-150 hover:bg-muted/40">
                  <td className={cn(TD, "pl-4")}>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                      {SCOPE_LABEL[rule.scope]}
                    </Badge>
                  </td>
                  <td className={cn(TD, "min-w-0")}>
                    <span className="block truncate font-medium text-foreground">{targetLabel(rule)}</span>
                    <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground md:hidden">
                      {formatRange(rule.effective_from, rule.effective_to)}
                    </span>
                  </td>
                  <td className={cn(TD, "text-right font-medium tabular-nums")}>{rule.markup_percent}%</td>
                  <td className={cn(TD, "hidden text-xs tabular-nums text-muted-foreground md:table-cell")}>
                    {formatRange(rule.effective_from, rule.effective_to)}
                  </td>
                  <td className={cn(TD, "pr-4 text-right")}>
                    {canManage ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                        onClick={() => setConfirmDelete(rule)}
                        aria-label={`Delete ${SCOPE_LABEL[rule.scope]} markup rule`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      {items.length > 0 ? (
        <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/20 px-4">
          <span className="microlabel truncate">
            {items.length} {items.length === 1 ? "rule" : "rules"}
          </span>
        </div>
      ) : null}

      <MarkupRuleDialog
        open={createOpen}
        options={options}
        pending={saving}
        onOpenChange={setCreateOpen}
        onSubmit={handleCreate}
      />

      <DeleteConfirm
        rule={confirmDelete}
        pending={deleting}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && handleDelete(confirmDelete)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

type RuleFormValues = {
  scope: Scope
  contractId: string
  costCodeId: string
  markupPercent: string
  effectiveFrom: string
  effectiveTo: string
}

const EMPTY_VALUES: RuleFormValues = {
  scope: "org",
  contractId: "",
  costCodeId: "",
  markupPercent: "",
  effectiveFrom: "",
  effectiveTo: "",
}

function MarkupRuleDialog({
  open,
  options,
  pending,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  options: MarkupRuleOptions
  pending: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (values: RuleFormValues) => void
}) {
  const [values, setValues] = useState<RuleFormValues>(EMPTY_VALUES)

  useEffect(() => {
    if (open) setValues(EMPTY_VALUES)
  }, [open])

  const markup = Number(values.markupPercent)
  const markupValid =
    values.markupPercent.trim() !== "" && Number.isFinite(markup) && markup >= 0 && markup <= 200
  const targetValid =
    values.scope === "org" ||
    (values.scope === "contract" && values.contractId !== "") ||
    (values.scope === "cost_code" && values.costCodeId !== "")
  const canSave = markupValid && targetValid && !pending

  const submit = () => {
    if (canSave) onSubmit(values)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-sm font-medium">New markup rule</DialogTitle>
          <DialogDescription className="text-xs">
            Sets the cost-plus markup for a scope. The narrowest matching rule wins.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-5 py-5">
          <section className="space-y-2">
            <p className="microlabel">Scope</p>
            <Select value={values.scope} onValueChange={(value) => setValues((prev) => ({ ...prev, scope: value as Scope }))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="org">Org default</SelectItem>
                <SelectItem value="contract">Contract</SelectItem>
                <SelectItem value="cost_code">Cost code</SelectItem>
              </SelectContent>
            </Select>
          </section>

          {values.scope === "contract" ? (
            <section className="space-y-2">
              <p className="microlabel">Contract</p>
              <Select value={values.contractId} onValueChange={(value) => setValues((prev) => ({ ...prev, contractId: value }))}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a contract" />
                </SelectTrigger>
                <SelectContent>
                  {options.contracts.map((contract) => (
                    <SelectItem key={contract.id} value={contract.id}>
                      {contractLabel(contract)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>
          ) : null}

          {values.scope === "cost_code" ? (
            <section className="space-y-2">
              <p className="microlabel">Cost code</p>
              <Select value={values.costCodeId} onValueChange={(value) => setValues((prev) => ({ ...prev, costCodeId: value }))}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a cost code" />
                </SelectTrigger>
                <SelectContent>
                  {options.costCodes.map((code) => (
                    <SelectItem key={code.id} value={code.id}>
                      {code.code} {code.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>
          ) : null}

          <section className="space-y-2">
            <p className="microlabel">Markup %</p>
            <Input
              type="number"
              min="0"
              max="200"
              step="0.01"
              inputMode="decimal"
              value={values.markupPercent}
              onChange={(event) => setValues((prev) => ({ ...prev, markupPercent: event.target.value }))}
              placeholder="15"
              className="tabular-nums"
              autoFocus
            />
          </section>

          <div className="grid grid-cols-2 gap-4">
            <section className="space-y-2">
              <p className="microlabel">Effective from</p>
              <Input
                type="date"
                value={values.effectiveFrom}
                onChange={(event) => setValues((prev) => ({ ...prev, effectiveFrom: event.target.value }))}
              />
            </section>
            <section className="space-y-2">
              <p className="microlabel">Effective to</p>
              <Input
                type="date"
                value={values.effectiveTo}
                onChange={(event) => setValues((prev) => ({ ...prev, effectiveTo: event.target.value }))}
              />
            </section>
          </div>
        </div>

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSave}>
            {pending ? "Adding…" : "Add rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteConfirm({
  rule,
  pending,
  onCancel,
  onConfirm,
}: {
  rule: MarkupRule | null
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={rule !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        {rule ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this markup rule?</AlertDialogTitle>
              <AlertDialogDescription>
                {targetLabel(rule)} · {rule.markup_percent}% markup. Costs under this scope fall back to the next
                matching rule — or bill at cost if none applies. This can&apos;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault()
                  onConfirm()
                }}
                disabled={pending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  )
}

function MarkupRulesEmpty({ canManage, onCreate }: { canManage: boolean; onCreate: () => void }) {
  return (
    <Empty className="min-h-0 flex-1 border-0 py-20">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Percent />
        </EmptyMedia>
        <EmptyTitle>No markup rules yet</EmptyTitle>
        <EmptyDescription>Cost-plus work bills at cost until you add a rule.</EmptyDescription>
      </EmptyHeader>
      {canManage ? (
        <EmptyContent>
          <Button size="sm" onClick={onCreate}>
            <Plus className="mr-1.5 size-3.5" />
            New rule
          </Button>
        </EmptyContent>
      ) : (
        <EmptyContent>
          <p className="text-xs text-muted-foreground">Ask an organization admin to add markup rules.</p>
        </EmptyContent>
      )}
    </Empty>
  )
}

// ---------------------------------------------------------------------------

function targetLabel(rule: MarkupRule): string {
  if (rule.contract_name) return rule.contract_name
  const costCode = [rule.cost_code_code, rule.cost_code_name].filter(Boolean).join(" ")
  return costCode || "Org default"
}

/** Supabase embeds one-to-one joins as either an object or a single-element array. */
function projectName(contract: MarkupRuleContract): string | null {
  const project = Array.isArray(contract.project) ? contract.project[0] : contract.project
  return project?.name ?? null
}

function contractLabel(contract: MarkupRuleContract): string {
  const base = contract.title ?? contract.number ?? "Contract"
  const project = projectName(contract)
  return project ? `${base} — ${project}` : base
}

function formatRange(from?: string | null, to?: string | null) {
  if (!from && !to) return "Always"
  return `${from ?? "Start"} to ${to ?? "Open"}`
}
