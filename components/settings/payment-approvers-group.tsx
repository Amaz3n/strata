"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  setPaymentRunApproversAction,
  updatePaymentRailPolicyAction,
} from "@/app/(app)/settings/payment-actions"
import { ArrowDown, ArrowUp, Plus, ShieldCheck, Trash2, Users } from "@/components/icons"
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  SettingsError,
  SettingsField,
  SettingsGroup,
} from "@/components/settings/settings-section"
import type { PaymentRunApprover } from "@/lib/services/payment-approvers"
import { cn } from "@/lib/utils"

type Chain = {
  userId: string
  name: string
  email: string | null
  limitDollars: string
}

type Candidate = { userId: string; name: string; email: string | null }

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

function move<T>(items: T[], from: number, to: number) {
  if (to < 0 || to >= items.length) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * The searchable roster picker, rendered as a `+` centred under the chain — the
 * one place a person is added, whether the chain is empty or ten deep.
 */
function AddApprover({
  available,
  hasCandidates,
  onAdd,
  label,
}: {
  available: Candidate[]
  hasCandidates: boolean
  onAdd: (candidate: Candidate) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={available.length === 0}
        >
          <Plus className="size-4" />
          {label ??
            (!hasCandidates
              ? "Nobody can approve yet"
              : available.length === 0
                ? "Everyone eligible is listed"
                : "Add approver")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="center">
        <Command>
          <CommandInput placeholder="Search teammates…" />
          <CommandList className="max-h-64">
            <CommandEmpty>No matching teammate.</CommandEmpty>
            <CommandGroup>
              {available.map((candidate) => (
                <CommandItem
                  key={candidate.userId}
                  value={`${candidate.name} ${candidate.email ?? ""}`}
                  onSelect={() => {
                    setOpen(false)
                    onAdd(candidate)
                  }}
                >
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
  )
}

/**
 * Who signs off on a payment run, and in what order.
 *
 * The permission decides who *can* approve; this chain decides who the org
 * actually routes to — so an AP clerk's run lands with their controller rather
 * than with anyone who happens to hold the permission. Order is who gets asked
 * first when a run needs more than one signature.
 */
export function PaymentApproversGroup({
  approvers,
  candidates,
  approvalMode,
  canManage,
}: {
  approvers: PaymentRunApprover[]
  candidates: Candidate[]
  approvalMode: "sole" | "dual"
  canManage: boolean
}) {
  const router = useRouter()
  const [mode, setMode] = useState<"sole" | "dual">(approvalMode)
  const [chain, setChain] = useState<Chain[]>(() =>
    approvers.map((approver) => ({
      userId: approver.userId,
      name: approver.name,
      email: approver.email,
      limitDollars: centsToDollars(approver.approvalLimitCents),
    })),
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const chainIds = new Set(chain.map((row) => row.userId))
  const available = candidates.filter(
    (candidate) => !chainIds.has(candidate.userId),
  )

  const requiredSignatures = mode === "dual" ? 2 : 1
  const tooFewForMode =
    chain.length > 0 && chain.length < requiredSignatures + 1

  const modeDirty = mode !== approvalMode
  const chainDirty =
    chain.length !== approvers.length ||
    chain.some((row, index) => {
      const original = approvers[index]
      return (
        !original ||
        original.userId !== row.userId ||
        centsToDollars(original.approvalLimitCents) !== row.limitDollars
      )
    })
  const dirty = modeDirty || chainDirty

  const badLimit = chain.some(
    (row) =>
      row.limitDollars.trim().length > 0 &&
      dollarsToCents(row.limitDollars) == null,
  )

  const addApprover = (candidate: Candidate) =>
    setChain((prev) => [...prev, { ...candidate, limitDollars: "" }])

  const save = () => {
    if (badLimit) {
      setError(
        "Enter an approval limit as a dollar amount above zero, or clear it for no limit.",
      )
      return
    }
    setError(null)
    startTransition(async () => {
      if (modeDirty) {
        const result = await updatePaymentRailPolicyAction({
          approval_mode: mode,
        })
        if (!result.success) {
          setError(result.error)
          return
        }
      }
      if (chainDirty) {
        const result = await setPaymentRunApproversAction({
          approvers: chain.map((row) => ({
            user_id: row.userId,
            approval_limit_cents: dollarsToCents(row.limitDollars),
          })),
        })
        if (!result.success) {
          setError(result.error)
          return
        }
      }
      toast.success("Approval routing saved")
      router.refresh()
    })
  }

  const rowClass =
    "grid grid-cols-[1.5rem_minmax(0,1fr)_9rem_6.5rem] items-center gap-3 py-2.5"

  return (
    <SettingsGroup
      title="Approval authority"
      description="A payment run is only released once it has been signed off by someone other than whoever prepared it. Set how many signatures a run needs, then who is asked for them."
    >
      <SettingsField
        label="Signatures required per run"
        hint="The person who prepares a run never counts toward this, whatever their role allows."
      >
        <ToggleGroup
          type="single"
          variant="outline"
          value={mode}
          onValueChange={(value) => {
            if (value) setMode(value === "sole" ? "sole" : "dual")
          }}
          disabled={!canManage}
          className="grid w-full grid-cols-2"
          aria-label="Signatures required per run"
        >
          <ToggleGroupItem value="sole" className="h-9 px-2 text-sm">
            One
          </ToggleGroupItem>
          <ToggleGroupItem value="dual" className="h-9 px-2 text-sm">
            Two
          </ToggleGroupItem>
        </ToggleGroup>
      </SettingsField>

      {chain.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          {canManage ? (
            <AddApprover
              available={available}
              hasCandidates={candidates.length > 0}
              onAdd={addApprover}
              label="Add the first approver"
            />
          ) : (
            <Users className="size-4 text-muted-foreground" />
          )}
          <p className="max-w-md text-xs leading-5 text-muted-foreground">
            {candidates.length === 0
              ? "No role grants payment approval yet, so no run can be released. Grant the permission to a role in Team settings first."
              : "Nobody is designated, so any teammate whose role grants payment approval can approve a run they did not prepare. Name people here to route runs to them instead."}
          </p>
        </div>
      ) : (
        <div className="py-4">
          <div className={cn(rowClass, "border-b border-border pb-2 pt-0")}>
            <span />
            <span className="microlabel">Approver</span>
            <span className="microlabel">Approval limit</span>
            <span className="microlabel text-right">Order</span>
          </div>

          {chain.map((row, index) => {
            const stale = approvers.find(
              (approver) => approver.userId === row.userId,
            )
            return (
              <div
                key={row.userId}
                className={cn(rowClass, "border-b border-border")}
              >
                <span
                  className={cn(
                    "flex size-6 items-center justify-center border text-xs tabular-nums",
                    index < requiredSignatures
                      ? "border-primary font-medium text-primary"
                      : "border-border text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.email ?? "No email"}
                    {stale && !stale.permitted
                      ? " · role no longer allows approving"
                      : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">$</span>
                  <Input
                    inputMode="decimal"
                    placeholder="No limit"
                    aria-label={`Approval limit for ${row.name}`}
                    value={row.limitDollars}
                    disabled={!canManage}
                    onChange={(event) =>
                      setChain((prev) =>
                        prev.map((item) =>
                          item.userId === row.userId
                            ? { ...item, limitDollars: event.target.value }
                            : item,
                        ),
                      )
                    }
                    className="h-8 tabular-nums"
                  />
                </div>
                <div className="flex items-center justify-end">
                  {canManage ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground"
                        disabled={index === 0}
                        onClick={() =>
                          setChain((prev) => move(prev, index, index - 1))
                        }
                      >
                        <ArrowUp className="size-4" />
                        <span className="sr-only">Ask {row.name} earlier</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground"
                        disabled={index === chain.length - 1}
                        onClick={() =>
                          setChain((prev) => move(prev, index, index + 1))
                        }
                      >
                        <ArrowDown className="size-4" />
                        <span className="sr-only">Ask {row.name} later</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          setChain((prev) =>
                            prev.filter((item) => item.userId !== row.userId),
                          )
                        }
                      >
                        <Trash2 className="size-4" />
                        <span className="sr-only">Remove {row.name}</span>
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            )
          })}

          {canManage ? (
            <div className="flex justify-center py-2">
              <AddApprover
                available={available}
                hasCandidates={candidates.length > 0}
                onAdd={addApprover}
              />
            </div>
          ) : null}

          <div className="flex items-start gap-2 pt-2 text-xs leading-5 text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            A run is offered to the{" "}
            {requiredSignatures === 1 ? "first person" : `first ${requiredSignatures} people`}{" "}
            in this order who did not prepare it and whose limit covers the
            debit. Anyone further down can still approve if they cannot.
          </div>
        </div>
      )}

      {tooFewForMode ? (
        <div className="flex items-start gap-2 py-3 text-xs leading-5 text-warning">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          {requiredSignatures === 2 ? "Two signatures" : "One signature"} per run
          and a preparer who can never sign their own leaves this chain too short
          to release a run someone on it prepared. Designate at least{" "}
          {requiredSignatures + 1} people.
        </div>
      ) : null}

      {error ? <SettingsError className="py-3">{error}</SettingsError> : null}

      {canManage ? (
        <div className="flex flex-wrap items-center justify-end gap-3 py-4">
          {dirty && !badLimit ? (
            <span className="text-xs text-muted-foreground">
              Unsaved changes
            </span>
          ) : null}
          <Button onClick={save} disabled={pending || !dirty || badLimit}>
            {pending ? "Saving…" : "Save approval authority"}
          </Button>
        </div>
      ) : null}
    </SettingsGroup>
  )
}
