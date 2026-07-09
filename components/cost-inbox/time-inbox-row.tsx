"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TableCell, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Check, X } from "@/components/icons"

import {
  categorizeAndApproveInboxTimeEntryAction,
  categorizeInboxTimeEntryAction,
  rejectInboxTimeEntryAction,
} from "@/app/(app)/projects/[id]/cost-inbox/actions"

import { unwrapAction } from "@/lib/action-result"

interface CostCodeOption {
  id: string
  code?: string | null
  name?: string | null
}

interface InboxTimeEntry {
  id: string
  work_date: string
  worker_name: string | null
  status: string
  hours: number | null
  base_rate_cents: number | null
  cost_cents: number | null
  is_billable: boolean | null
  is_overtime: boolean | null
  cost_code_id: string | null
  notes: string | null
}

interface Props {
  projectId: string
  entry: InboxTimeEntry
  costCodes: CostCodeOption[]
}

const NO_COST_CODE = "__none__"

function formatDate(value: string | null | undefined) {
  if (!value) return "—"
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function formatCurrency(cents: number | null | undefined) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

export function TimeInboxRow({ projectId, entry, costCodes }: Props) {
  const [costCodeId, setCostCodeId] = useState<string>(entry.cost_code_id ?? NO_COST_CODE)
  const [rate, setRate] = useState<string>(((entry.base_rate_cents ?? 0) / 100 || "").toString())
  const [isBillable, setIsBillable] = useState<boolean>(entry.is_billable ?? true)
  const [isOvertime, setIsOvertime] = useState<boolean>(entry.is_overtime ?? false)
  const [isPending, startTransition] = useTransition()

  const previewCost = useMemo(() => {
    const hours = Number(entry.hours ?? 0) || 0
    const rateNum = Number(rate) || 0
    return Math.round(hours * rateNum * 100)
  }, [entry.hours, rate])

  function payload() {
    return {
      costCodeId: costCodeId === NO_COST_CODE ? null : costCodeId,
      baseRateDollars: Math.max(0, Number(rate) || 0),
      isBillable,
      isOvertime,
    }
  }

  function save() {
    startTransition(async () => {
      try {
        unwrapAction(await categorizeInboxTimeEntryAction(projectId, entry.id, payload()))
        toast.success("Saved")
      } catch (error: any) {
        toast.error("Could not save", { description: error?.message })
      }
    })
  }

  function approve() {
    if (!rate || Number(rate) <= 0) {
      toast.error("Set a rate before approving")
      return
    }
    startTransition(async () => {
      try {
        unwrapAction(await categorizeAndApproveInboxTimeEntryAction(projectId, entry.id, payload()))
        toast.success("Approved")
      } catch (error: any) {
        toast.error("Could not approve", { description: error?.message })
      }
    })
  }

  function reject() {
    startTransition(async () => {
      try {
        unwrapAction(await rejectInboxTimeEntryAction(projectId, entry.id))
        toast.success("Rejected")
      } catch (error: any) {
        toast.error("Could not reject", { description: error?.message })
      }
    })
  }

  const needsCategorization = !entry.cost_code_id || (entry.base_rate_cents ?? 0) === 0

  return (
    <TableRow className="align-top">
      <TableCell className="whitespace-nowrap py-3">
        <div className="text-sm">{formatDate(entry.work_date)}</div>
        <div className="text-xs text-muted-foreground tabular-nums">{(entry.hours ?? 0).toFixed(2)} hrs</div>
      </TableCell>
      <TableCell className="py-3">
        <div className="text-sm font-medium">{entry.worker_name || "Unnamed"}</div>
        {needsCategorization ? (
          <Badge variant="outline" className="mt-1 text-[10px] px-1 py-0 h-4 font-normal border-warning/40 text-warning bg-warning/10">
            Needs categorization
          </Badge>
        ) : null}
        {entry.notes ? (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2 max-w-[240px]">{entry.notes}</p>
        ) : null}
      </TableCell>
      <TableCell className="py-3 min-w-[200px]">
        <Select value={costCodeId} onValueChange={setCostCodeId}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Cost code" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_COST_CODE}>No cost code</SelectItem>
            {costCodes.map((code) => (
              <SelectItem key={code.id} value={code.id}>
                <span className="font-medium">{code.code}</span> {code.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="py-3 w-[120px]">
        <Input
          inputMode="decimal"
          value={rate}
          onChange={(event) => setRate(event.target.value)}
          placeholder="$/hr"
          className="h-8 text-xs tabular-nums"
        />
      </TableCell>
      <TableCell className="py-3 w-[120px]">
        <div className="flex flex-col gap-1 text-xs">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={isBillable}
              onChange={(event) => setIsBillable(event.target.checked)}
              className="rounded"
            />
            Billable
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={isOvertime}
              onChange={(event) => setIsOvertime(event.target.checked)}
              className="rounded"
            />
            Overtime
          </label>
        </div>
      </TableCell>
      <TableCell className="py-3 w-[100px] tabular-nums text-sm text-right">
        {formatCurrency(previewCost)}
      </TableCell>
      <TableCell className="py-3 text-right">
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={save} disabled={isPending}>
            Save
          </Button>
          {entry.status === "submitted" ? (
            <Button size="sm" variant="outline" onClick={approve} disabled={isPending}>
              <Check className="h-4 w-4" />
              Approve
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={reject} disabled={isPending}>
            <X className="h-4 w-4" />
            Reject
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}
