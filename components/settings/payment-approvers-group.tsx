"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { setPaymentRunApproversAction } from "@/app/(app)/settings/payment-actions"
import { Check, ShieldCheck, Trash2, Users } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  SettingsError,
  SettingsGroup,
} from "@/components/settings/settings-section"
import type { PaymentRunApprover } from "@/lib/services/payment-approvers"
import { cn } from "@/lib/utils"

type Draft = {
  userId: string
  name: string
  email: string | null
  limitDollars: string
}

function centsToDollars(value: number | null) {
  return value == null ? "" : (value / 100).toFixed(2)
}

function dollarsToCents(value: string) {
  const normalized = value.trim().replaceAll(",", "").replace("$", "")
  if (!normalized) return null
  const dollars = Number(normalized)
  return Number.isFinite(dollars) && dollars > 0
    ? Math.round(dollars * 100)
    : null
}

/**
 * Who may approve payment runs. The permission decides who *can*; this roster
 * decides who the org actually routes to — so an AP clerk's run lands with their
 * controller rather than with anyone who happens to hold the permission.
 */
export function PaymentApproversGroup({
  approvers,
  candidates,
  approvalMode,
  canManage,
}: {
  approvers: PaymentRunApprover[]
  candidates: Array<{ userId: string; name: string; email: string | null }>
  approvalMode: "sole" | "dual"
  canManage: boolean
}) {
  const [draft, setDraft] = useState<Draft[]>(() =>
    approvers.map((approver) => ({
      userId: approver.userId,
      name: approver.name,
      email: approver.email,
      limitDollars: centsToDollars(approver.approvalLimitCents),
    })),
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const selectedIds = new Set(draft.map((row) => row.userId))
  const available = candidates.filter(
    (candidate) => !selectedIds.has(candidate.userId),
  )
  const requiredApprovers = approvalMode === "dual" ? 2 : 1
  const tooFewForMode = draft.length > 0 && draft.length < requiredApprovers + 1

  const dirty =
    draft.length !== approvers.length ||
    draft.some((row, index) => {
      const original = approvers[index]
      return (
        !original ||
        original.userId !== row.userId ||
        centsToDollars(original.approvalLimitCents) !== row.limitDollars
      )
    })

  const badLimit = draft.some(
    (row) =>
      row.limitDollars.trim().length > 0 &&
      dollarsToCents(row.limitDollars) == null,
  )

  const save = () => {
    if (badLimit) {
      setError(
        "Enter an approval limit as a dollar amount above zero, or clear it for no limit.",
      )
      return
    }
    setError(null)
    startTransition(async () => {
      const result = await setPaymentRunApproversAction({
        approvers: draft.map((row) => ({
          user_id: row.userId,
          approval_limit_cents: dollarsToCents(row.limitDollars),
        })),
      })
      if (!result.success) {
        setError(result.error)
        return
      }
      toast.success(
        draft.length === 0
          ? "Approvers cleared"
          : `${draft.length} designated ${draft.length === 1 ? "approver" : "approvers"} saved`,
      )
    })
  }

  return (
    <SettingsGroup
      title="Who approves payments"
      description="Name the people a submitted payment run goes to. Leave this empty and any teammate whose role allows payment approval can approve."
    >
      {draft.length === 0 ? (
        <div className="flex items-start gap-2 py-4 text-xs leading-5 text-muted-foreground">
          <Users className="mt-0.5 size-3.5 shrink-0" />
          No designated approvers. Every run can be approved by anyone whose
          role grants payment approval — except the person who prepared it.
        </div>
      ) : (
        <div className="divide-y">
          {draft.map((row) => {
            const stale = approvers.find(
              (approver) => approver.userId === row.userId,
            )
            return (
              <div
                key={row.userId}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.email ?? "No email"}
                    {stale && !stale.permitted
                      ? " · role no longer allows approving"
                      : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      up to $
                    </span>
                    <Input
                      inputMode="decimal"
                      placeholder="any amount"
                      aria-label={`Approval limit for ${row.name}`}
                      value={row.limitDollars}
                      disabled={!canManage}
                      onChange={(event) =>
                        setDraft((prev) =>
                          prev.map((item) =>
                            item.userId === row.userId
                              ? { ...item, limitDollars: event.target.value }
                              : item,
                          ),
                        )
                      }
                      className="h-8 w-32 tabular-nums"
                    />
                  </div>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        setDraft((prev) =>
                          prev.filter((item) => item.userId !== row.userId),
                        )
                      }
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">Remove {row.name}</span>
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {tooFewForMode ? (
        <div className="flex items-start gap-2 pb-2 text-xs leading-5 text-warning">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          With {approvalMode === "dual" ? "two approvers" : "one approver"}{" "}
          required per run and a preparer who can never approve their own, a
          roster this small can leave runs stuck. Designate at least{" "}
          {requiredApprovers + 1} people.
        </div>
      ) : null}

      {error ? <SettingsError className="py-3">{error}</SettingsError> : null}

      {canManage ? (
        <div className="flex flex-wrap items-center gap-3 py-4">
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" disabled={available.length === 0}>
                {available.length === 0 && candidates.length === 0
                  ? "No eligible teammates"
                  : "Add approver"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="start">
              <Command>
                <CommandInput placeholder="Search teammates…" />
                <CommandList className="max-h-64">
                  <CommandEmpty>
                    Everyone eligible is already listed.
                  </CommandEmpty>
                  <CommandGroup>
                    {available.map((candidate) => (
                      <CommandItem
                        key={candidate.userId}
                        value={`${candidate.name} ${candidate.email ?? ""}`}
                        onSelect={() => {
                          setPickerOpen(false)
                          setDraft((prev) => [
                            ...prev,
                            { ...candidate, limitDollars: "" },
                          ])
                        }}
                      >
                        <Check className={cn("mr-2 size-4 opacity-0")} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">
                            {candidate.name}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {candidate.email ?? "No email"}
                          </span>
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Button onClick={save} disabled={pending || !dirty || badLimit}>
            {pending ? "Saving…" : "Save approvers"}
          </Button>
          {dirty && !badLimit ? (
            <span className="text-xs text-muted-foreground">
              Unsaved changes
            </span>
          ) : null}
          {candidates.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              No one holds payment-approval permission yet — grant it from a
              role in Team settings first.
            </span>
          ) : null}
        </div>
      ) : null}
    </SettingsGroup>
  )
}
