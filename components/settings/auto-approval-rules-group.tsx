"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import {
  deleteAutoApprovalRuleAction,
  listAutoApprovalRulesAction,
  upsertAutoApprovalRuleAction,
} from "@/app/(app)/settings/payment-actions"
import { Plus, Trash2 } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingsError, SettingsGroup } from "@/components/settings/settings-section"
import { unwrapAction } from "@/lib/action-result"
import type { AutoApprovalRule } from "@/lib/services/invoice-auto-approval"

function dollarsToCents(value: string) {
  const normalized = value.trim().replaceAll(",", "").replace("$", "")
  if (!normalized) return null
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.round(parsed * 100)
}

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)

/**
 * Which invoices skip human approval.
 *
 * The table and the evaluator shipped without any of this, so the rules could
 * only be written straight to the database and, once written, were invisible.
 * An org could be auto-approving payables with nobody able to say which, or
 * turn it off.
 */
export function AutoApprovalRulesGroup({ canManage }: { canManage: boolean }) {
  const [rules, setRules] = useState<AutoApprovalRule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [maxAmount, setMaxAmount] = useState("")
  const [isPending, startTransition] = useTransition()

  const load = useCallback(async () => {
    try {
      setRules(unwrapAction(await listAutoApprovalRulesAction()))
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load auto-approval rules")
      setRules([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = () => {
    const cents = dollarsToCents(maxAmount)
    if (!name.trim()) {
      toast.error("Give the rule a name")
      return
    }
    if (!cents) {
      toast.error("Set the most this rule may approve")
      return
    }
    startTransition(async () => {
      try {
        unwrapAction(
          await upsertAutoApprovalRuleAction({
            name: name.trim(),
            max_amount_cents: cents,
            vendor_trust_tiers: [],
            require_no_duplicates: true,
            is_active: true,
          }),
        )
        setAdding(false)
        setName("")
        setMaxAmount("")
        toast.success("Rule saved")
        await load()
      } catch (saveError) {
        toast.error(saveError instanceof Error ? saveError.message : "Unable to save the rule")
      }
    })
  }

  const toggle = (rule: AutoApprovalRule, next: boolean) => {
    startTransition(async () => {
      try {
        unwrapAction(
          await upsertAutoApprovalRuleAction({
            id: rule.id,
            name: rule.name,
            project_id: rule.projectId,
            company_id: rule.companyId,
            max_amount_cents: rule.maxAmountCents,
            vendor_trust_tiers: rule.vendorTrustTiers,
            require_no_duplicates: rule.requireNoDuplicates,
            is_active: next,
          }),
        )
        await load()
      } catch (toggleError) {
        toast.error(toggleError instanceof Error ? toggleError.message : "Unable to update the rule")
      }
    })
  }

  const remove = (ruleId: string) => {
    startTransition(async () => {
      try {
        unwrapAction(await deleteAutoApprovalRuleAction(ruleId))
        toast.success("Rule deleted")
        await load()
      } catch (deleteError) {
        toast.error(deleteError instanceof Error ? deleteError.message : "Unable to delete the rule")
      }
    })
  }

  return (
    <SettingsGroup
      title="Automatic approval"
      description="Invoices matching a rule are approved without a person. Coding, cost codes and lien-waiver rules still apply — only the human step is skipped."
    >
      {error ? <SettingsError className="py-3">{error}</SettingsError> : null}

      {rules === null ? (
        <div className="space-y-2 py-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rules.length === 0 ? (
        <div className="border border-border px-4 py-6 text-center">
          <p className="text-sm font-medium">Every payable is approved by a person</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add a rule to let small, routine invoices through automatically.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border border border-border">
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{rule.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {rule.maxAmountCents ? `Up to ${money(rule.maxAmountCents)}` : "Any amount"}
                  {rule.companyName ? ` · ${rule.companyName}` : ""}
                  {rule.projectName ? ` · ${rule.projectName}` : " · All projects"}
                  {rule.requireNoDuplicates ? " · Skips suspected duplicates" : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Switch
                  checked={rule.isActive}
                  disabled={!canManage || isPending}
                  onCheckedChange={(next) => toggle(rule, next)}
                  aria-label={`${rule.isActive ? "Disable" : "Enable"} ${rule.name}`}
                />
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={isPending}
                    onClick={() => remove(rule.id)}
                    aria-label={`Delete ${rule.name}`}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {canManage ? (
        adding ? (
          <div className="mt-3 space-y-3 border border-border p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="auto-rule-name">Rule name</Label>
                <Input
                  id="auto-rule-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Small routine invoices"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="auto-rule-max">Approve up to</Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    id="auto-rule-max"
                    inputMode="decimal"
                    className="tabular-nums"
                    value={maxAmount}
                    onChange={(event) => setMaxAmount(event.target.value)}
                    placeholder="500.00"
                  />
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Suspected duplicates are always sent to a person, whatever the amount.
            </p>
            <div className="flex gap-2">
              <Button disabled={isPending} onClick={save}>
                {isPending ? "Saving…" : "Add rule"}
              </Button>
              <Button
                variant="ghost"
                disabled={isPending}
                onClick={() => {
                  setAdding(false)
                  setName("")
                  setMaxAmount("")
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end py-3">
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Add rule
            </Button>
          </div>
        )
      ) : null}
    </SettingsGroup>
  )
}
