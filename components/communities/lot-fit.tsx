"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import {
  getLotFitAction,
  listLotElevationRulesAction,
  recordLotFitOverrideAction,
  revokeLotFitOverrideAction,
  setLotAllowedElevationsAction,
} from "@/app/(app)/communities/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import { describeMissingFitData, MIN_FIT_OVERRIDE_REASON_LENGTH, type Handing } from "@/lib/land/lot-fit"
import type { LotElevationChoice, LotFitVerdict } from "@/lib/services/lot-fit"
import { uploadDocumentFileDirect } from "@/lib/services/files-client"
import { cn } from "@/lib/utils"

const STATUS = {
  overridden: { label: "Fits under override", dot: "bg-warning", text: "text-warning" },
  violations: { label: "Does not fit", dot: "bg-destructive", text: "text-destructive" },
  unknown: { label: "Not measured", dot: "bg-muted-foreground", text: "text-muted-foreground" },
  fits: { label: "Fits", dot: "bg-success", text: "text-success" },
} as const

function statusOf(verdict: LotFitVerdict) {
  return verdict.override ? STATUS.overridden : STATUS[verdict.evaluation.status]
}

/** The one-word answer, colored by what it reports. */
export function LotFitBadge({ verdict, className }: { verdict: LotFitVerdict; className?: string }) {
  const status = statusOf(verdict)
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", status.text, className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.dot)} />
      {status.label}
    </span>
  )
}

/** Why: each violation in words, what is missing, and the override standing in for them. */
export function LotFitDetails({ verdict }: { verdict: LotFitVerdict }) {
  const { evaluation, override } = verdict
  if (evaluation.violations.length === 0 && evaluation.missing.length === 0) return null
  return (
    <div className="space-y-1">
      {evaluation.violations.length > 0 ? (
        <ul className={cn("space-y-0.5 text-xs", override ? "text-muted-foreground" : "text-destructive")}>
          {evaluation.violations.map((violation) => (
            <li key={violation.code}>{violation.message}</li>
          ))}
        </ul>
      ) : null}
      {evaluation.missing.length > 0 ? (
        <p className="text-xs text-muted-foreground">Not checked: no {describeMissingFitData(evaluation.missing)} recorded.</p>
      ) : null}
      {override ? (
        <p className="text-xs text-muted-foreground">
          Override {override.approvedAt.slice(0, 10)}: {override.reason}{" "}
          <a href={`/api/files/${override.evidenceFileId}/raw`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            Evidence
          </a>
        </p>
      ) : null}
    </div>
  )
}

/**
 * The only way past a fit refusal: a holder of lot.fit_override, a reason, and
 * the evidence (plot plan, variance, architectural approval) uploaded here. It
 * covers this plan, elevation and handing on this lot, against the violations
 * found now — nothing else.
 */
export function LotFitOverrideDialog({
  open,
  onOpenChange,
  communityId,
  lotId,
  projectId,
  title,
  configuration,
  onRecorded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  communityId: string
  lotId: string
  projectId: string | null
  title: string
  configuration: { planId: string; elevationId: string | null; swing: Handing | null }
  onRecorded: () => void
}) {
  const [reason, setReason] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (open) {
      setReason("")
      setFile(null)
      setError(null)
    }
  }, [open])

  const trimmed = reason.trim()

  function submit() {
    if (!file) return
    startTransition(async () => {
      try {
        const evidence = await uploadDocumentFileDirect(file, {
          projectId: projectId ?? undefined,
          category: "other",
          folderPath: "/Lots/Fit evidence",
          visibility: "private",
        })
        unwrapAction(
          await recordLotFitOverrideAction(communityId, {
            lotId,
            housePlanId: configuration.planId,
            elevationId: configuration.elevationId,
            swing: configuration.swing,
            reason: trimmed,
            evidenceFileId: evidence.id,
          }),
        )
        toast.success("Fit override recorded")
        onOpenChange(false)
        onRecorded()
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Unable to record the override")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Lets this plan, elevation and garage handing stand on this lot although it does not fit. It covers only the
            violations found now; a different configuration or a later change needs its own.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="fit-override-reason">Reason</Label>
            <Textarea
              id="fit-override-reason"
              className="min-h-20 rounded-none text-sm"
              value={reason}
              disabled={isPending}
              onChange={(event) => {
                setReason(event.target.value)
                setError(null)
              }}
            />
            <p className="text-xs text-muted-foreground tabular-nums">
              {trimmed.length}/{MIN_FIT_OVERRIDE_REASON_LENGTH} characters minimum
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fit-override-evidence">Evidence</Label>
            <Input
              id="fit-override-evidence"
              type="file"
              accept=".pdf,image/*"
              className="rounded-none text-xs"
              disabled={isPending}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null)
                setError(null)
              }}
            />
            <p className="text-xs text-muted-foreground">The plot plan, variance or architectural approval that shows it works.</p>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" className="rounded-none" disabled={isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="rounded-none"
            disabled={isPending || !file || trimmed.length < MIN_FIT_OVERRIDE_REASON_LENGTH}
            onClick={submit}
          >
            {isPending ? "Recording…" : "Record override"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: T }

function failureText(failure: unknown, fallback: string) {
  return failure instanceof Error ? failure.message : fallback
}

/** Architectural control for one lot: the elevations it takes, or any. */
function AllowedElevationsDialog({
  open,
  onOpenChange,
  lotId,
  communityId,
  rules,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  lotId: string
  communityId: string
  rules: { allowedIds: string[]; choices: LotElevationChoice[]; truncated: boolean }
  onSaved: () => void
}) {
  const [selected, setSelected] = useState<string[]>(rules.allowedIds)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (open) {
      setSelected(rules.allowedIds)
      setError(null)
    }
  }, [open, rules.allowedIds])

  function save() {
    startTransition(async () => {
      try {
        const result = unwrapAction(await setLotAllowedElevationsAction(lotId, communityId, { elevationIds: selected }))
        if (result.fitRefusal) toast.warning("Saved — the pinned home no longer fits", { description: result.fitRefusal })
        else toast.success("Allowed elevations saved")
        onOpenChange(false)
        onSaved()
      } catch (failure) {
        setError(failureText(failure, "Unable to save allowed elevations"))
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Allowed elevations</DialogTitle>
          <DialogDescription>
            Leave every box clear and the lot takes any elevation. Check some and it takes only those.
          </DialogDescription>
        </DialogHeader>
        {rules.choices.length === 0 ? (
          <p className="border px-3 py-4 text-sm text-muted-foreground">
            The community offers no plans yet, so there are no elevations to restrict this lot to.
          </p>
        ) : (
          <div className="max-h-72 overflow-y-auto border">
            {rules.choices.map((choice) => {
              const checked = selected.includes(choice.id)
              return (
                <label
                  key={choice.id}
                  className="flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0 hover:bg-muted/50"
                >
                  <Checkbox
                    checked={checked}
                    disabled={isPending}
                    onCheckedChange={(value) =>
                      setSelected((current) =>
                        value === true ? [...current, choice.id] : current.filter((entry) => entry !== choice.id),
                      )
                    }
                  />
                  <span className="font-medium">{choice.planCode}</span>
                  <span className="text-muted-foreground">
                    {choice.code}
                    {choice.name ? ` · ${choice.name}` : ""}
                  </span>
                </label>
              )
            })}
          </div>
        )}
        {rules.truncated ? (
          <p className="text-xs text-muted-foreground">Showing the first {rules.choices.length} elevations.</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" className="rounded-none" disabled={isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="rounded-none" disabled={isPending} onClick={save}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The inspector's fit block: the lot's architectural control, and whether the
 * home pinned to it fits — with the override that lets it stand, or the way to
 * record one. Read on open; a land edit refreshes the lot and re-reads it.
 */
export function LotFitSection({
  lot,
  communityId,
  canWrite,
  canOverrideFit,
}: {
  /** `refreshKey` changes whenever the lot's land facts or pin do, so the fit is read again. */
  lot: { id: string; label: string; projectId: string | null; refreshKey: string }
  communityId: string
  canWrite: boolean
  canOverrideFit: boolean
}) {
  const [fit, setFit] = useState<Load<LotFitVerdict | null>>({ state: "loading" })
  const [rules, setRules] = useState<Load<{ allowedIds: string[]; choices: LotElevationChoice[]; truncated: boolean }>>({ state: "loading" })
  const [reload, setReload] = useState(0)
  const [editingRules, setEditingRules] = useState(false)
  const [overriding, setOverriding] = useState(false)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let active = true
    setFit({ state: "loading" })
    setRules({ state: "loading" })
    getLotFitAction(lot.id).then((response) => {
      if (!active) return
      try {
        setFit({ state: "ready", value: unwrapAction(response) })
      } catch (failure) {
        setFit({ state: "error", message: failureText(failure, "Unable to check the fit") })
      }
    })
    listLotElevationRulesAction(lot.id).then((response) => {
      if (!active) return
      try {
        setRules({ state: "ready", value: unwrapAction(response) })
      } catch (failure) {
        setRules({ state: "error", message: failureText(failure, "Unable to load allowed elevations") })
      }
    })
    return () => {
      active = false
    }
  }, [lot.id, lot.refreshKey, reload])

  const verdict = fit.state === "ready" ? fit.value : null
  const override = verdict?.override ?? null

  function revoke(overrideId: string) {
    startTransition(async () => {
      try {
        unwrapAction(await revokeLotFitOverrideAction(communityId, overrideId))
        toast.success("Fit override revoked")
        setReload((value) => value + 1)
      } catch (failure) {
        toast.error("Unable to revoke the override", { description: failureText(failure, "") })
      }
    })
  }

  return (
    <div className="space-y-2">
      <dl>
        <div className="flex items-baseline justify-between gap-3 border-b py-1.5">
          <dt className="shrink-0 text-xs text-muted-foreground">Allowed elevations</dt>
          <dd className="flex min-w-0 items-center justify-end gap-2 text-right text-xs">
            {rules.state === "loading" ? (
              <Skeleton className="h-4 w-20" />
            ) : rules.state === "error" ? (
              <span className="text-destructive">{rules.message}</span>
            ) : (
              <>
                <span className={cn(rules.value.allowedIds.length === 0 && "text-muted-foreground")}>
                  {rules.value.allowedIds.length === 0 ? "Any" : `${rules.value.allowedIds.length} allowed`}
                </span>
                {canWrite ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 rounded-none px-2 text-xs"
                    disabled={isPending}
                    onClick={() => setEditingRules(true)}
                  >
                    Edit
                  </Button>
                ) : null}
              </>
            )}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <dt className="shrink-0 text-xs text-muted-foreground">Pinned home</dt>
          <dd className="min-w-0 text-right text-xs">
            {fit.state === "loading" ? (
              <Skeleton className="ml-auto h-4 w-24" />
            ) : fit.state === "error" ? (
              <span className="text-destructive">{fit.message}</span>
            ) : verdict ? (
              <LotFitBadge verdict={verdict} />
            ) : (
              <span className="text-muted-foreground">No plan pinned</span>
            )}
          </dd>
        </div>
      </dl>
      {verdict ? <LotFitDetails verdict={verdict} /> : null}
      {verdict && override && canOverrideFit ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 rounded-none text-xs"
          disabled={isPending}
          onClick={() => revoke(override.id)}
        >
          Revoke override
        </Button>
      ) : null}
      {verdict?.refusal ? (
        canOverrideFit ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-none text-xs"
            disabled={isPending}
            onClick={() => setOverriding(true)}
          >
            Record fit override
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Recording a fit override needs the lot.fit_override permission.</p>
        )
      ) : null}

      {rules.state === "ready" ? (
        <AllowedElevationsDialog
          open={editingRules}
          onOpenChange={setEditingRules}
          lotId={lot.id}
          communityId={communityId}
          rules={rules.value}
          onSaved={() => setReload((value) => value + 1)}
        />
      ) : null}
      {verdict ? (
        <LotFitOverrideDialog
          open={overriding}
          onOpenChange={setOverriding}
          communityId={communityId}
          lotId={lot.id}
          projectId={lot.projectId}
          title={`Fit override · Lot ${lot.label}`}
          configuration={{ planId: verdict.housePlanId, elevationId: verdict.elevationId, swing: verdict.evaluation.swing }}
          onRecorded={() => setReload((value) => value + 1)}
        />
      ) : null}
    </div>
  )
}
