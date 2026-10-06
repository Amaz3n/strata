"use client"

import { useEffect, useState, useTransition, type ReactNode } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { BidPackage, BidPackageAward, BidScopeItem, BidSubmission } from "@/lib/services/bids"
import type { VendorBidStats } from "@/lib/services/bid-intelligence"
import { itemForScope } from "@/lib/bids/leveling"
import { SUBCONTRACT_STAGE_LABELS, TRADE_STATE_LABELS, subcontractStage, tradeHasPrices } from "@/lib/bids/package-move"
import {
  generateBidInviteLinkAction,
  pauseBidInviteAccessAction,
  resendBidInviteAction,
  resumeBidInviteAccessAction,
  revokeBidInviteAccessAction,
  setBidInviteRequireAccountAction,
  updateBidSubmissionItemLevelingAction,
  updateBidSubmissionLevelingAction,
} from "@/app/(app)/bids/actions"
import { listAttachmentsAction } from "@/app/(app)/documents/actions"
import { unwrapAction } from "@/lib/action-result"
import { cn, formatMoneyCents } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AlertTriangle, ArrowUpRight, CheckCircle2, Download, MoreHorizontal, Paperclip, X } from "@/components/icons"
import type { TradeColumn } from "@/components/bids/bid-board"
import { parseCurrencyToCents, signedMoney, type BidWorkbenchContext } from "@/components/bids/bid-workbench-helpers"

// ---------------------------------------------------------------- shell

export function InspectorHeader({ title, subtitle, onClose }: { title: string; subtitle?: ReactNode; onClose?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b px-5 pb-3.5 pt-4">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold tracking-tight">{title}</h2>
        {subtitle ? <div className="mt-0.5 text-[12.5px] text-muted-foreground">{subtitle}</div> : null}
      </div>
      {onClose ? (
        <Button variant="ghost" size="icon" className="-mr-1 h-7 w-7 text-muted-foreground" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  )
}

export function InspectorSection({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5 border-b px-5 py-4 last:border-b-0">
      {label ? <p className="microlabel">{label}</p> : null}
      {children}
    </div>
  )
}

function Facts({ rows }: { rows: Array<[string, ReactNode] | null> }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[13px]">
      {rows.filter((row): row is [string, ReactNode] => row != null).map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Check({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2 text-[13px]">
      {ok === null ? (
        <span className="mt-0.5 inline-block h-4 w-4 text-center text-muted-foreground">–</span>
      ) : ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      )}
      <span>
        {label}
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </div>
  )
}

const day = (value?: string | null) => (value ? format(new Date(value), "MMM d, yyyy") : null)

// ---------------------------------------------------------------- trade

/** One trade: their bid in their own words, whether they're ready to hire, and what you can do with them. */
export function TradeInspector({
  context,
  bidPackage,
  column,
  versions,
  rank,
  budgetCents,
  stats,
  canAward,
  isLow,
  pricingPanel,
  onAward,
  onEnterPrice,
  onRemove,
  onChanged,
  onSubmissionChanged,
  onClose,
}: {
  context: BidWorkbenchContext
  bidPackage: BidPackage
  column: TradeColumn
  versions: BidSubmission[]
  rank: { place: number; of: number } | null
  budgetCents: number | null
  stats: VendorBidStats | undefined
  canAward: boolean
  isLow: boolean
  pricingPanel: ReactNode
  onAward: (submission: BidSubmission) => void
  onEnterPrice: () => void
  onRemove: () => void
  onChanged: () => Promise<void>
  onSubmissionChanged: (submission: BidSubmission) => void
  onClose: () => void
}) {
  const { invite, submission, totals } = column
  const withContext = { ...context, bidPackageId: bidPackage.id }
  const hasPrices = tradeHasPrices(column.state)
  const paused = (invite.paused_access_count ?? 0) > 0
  const sent = column.state !== "lined_up"
  const contact = invite.contact?.full_name ?? invite.invite_email ?? invite.company?.email ?? null

  async function run(task: () => Promise<unknown>, done: string) {
    try {
      await task()
      await onChanged()
      toast.success(done)
    } catch (error) {
      toast.error("That didn't work", { description: error instanceof Error ? error.message : "Please try again." })
    }
  }

  /** Clipboard writes must start inside the click, so the URL arrives as a promise. Never rotates the link they already have. */
  function copyLink() {
    const url = (async () => unwrapAction(await generateBidInviteLinkAction(withContext, invite.id, { revokeExisting: false })).url)()
    const write =
      typeof ClipboardItem !== "undefined" && navigator.clipboard?.write
        ? navigator.clipboard.write([new ClipboardItem({ "text/plain": url.then((value) => new Blob([value], { type: "text/plain" })) })])
        : url.then((value) => navigator.clipboard.writeText(value))
    write
      .then(() => toast.success("Their link is copied"))
      .catch(async (error) => {
        const fallback = await url.catch(() => null)
        toast.error("Couldn't copy the link", { description: fallback ?? (error instanceof Error ? error.message : "Please try again."), duration: 10000 })
      })
  }

  const prequal = invite.prequalification_warning
  const compliance = invite.compliance_warning
  const record = stats ? `Won ${stats.awarded_count} of ${stats.invited_count} with you` : null

  return (
    <>
      <InspectorHeader
        title={column.name}
        subtitle={[contact, record].filter(Boolean).join(" · ") || TRADE_STATE_LABELS[column.state]}
        onClose={onClose}
      />

      {hasPrices && totals && submission ? (
        <>
          <InspectorSection label={rank && rank.of > 1 ? `Leveled total · ${rank.place === 1 ? "lowest" : ordinal(rank.place)} of ${rank.of}` : "Leveled total"}>
            <p className={cn("font-mono text-[28px] font-medium leading-none tracking-tight tabular-nums", isLow && "text-success")}>
              {formatMoneyCents(totals.leveled)}
            </p>
            <Facts
              rows={[
                ["As bid", <span key="b" className="font-mono tabular-nums">{formatMoneyCents(totals.base)}</span>],
                totals.plugs ? ["Plugs for excluded scope", <span key="p" className="font-mono tabular-nums text-warning">{signedMoney(totals.plugs)}</span>] : null,
                column.unpluggedLines ? ["Excluded lines with no plug", <span key="u" className="text-warning">{column.unpluggedLines}</span>] : null,
                totals.lump ? ["Leveling adjustment", <span key="l" className="font-mono tabular-nums">{signedMoney(totals.lump)}</span>] : null,
                budgetCents ? ["vs budget", <span key="v" className={cn("font-mono tabular-nums", totals.leveled > budgetCents ? "text-destructive" : "text-success")}>{signedMoney(totals.leveled - budgetCents)}</span>] : null,
                submission.submitted_at ? ["Submitted", `${format(new Date(submission.submitted_at), "MMM d, h:mm a")}${submission.source === "manual" ? " · entered by you" : ""}`] : null,
                submission.valid_until ? ["Price holds until", day(submission.valid_until)] : null,
                submission.lead_time_days != null ? ["Lead time", `${submission.lead_time_days} days`] : null,
                submission.duration_days != null ? ["Duration", `${submission.duration_days} days`] : null,
                submission.start_available_on ? ["Can start", day(submission.start_available_on)] : null,
              ]}
            />
            {submission.benchmark?.has_benchmark ? (
              <p className="text-xs text-muted-foreground">
                Market {formatMoneyCents(submission.benchmark.p25_cents ?? null)}–{formatMoneyCents(submission.benchmark.p75_cents ?? null)} across {submission.benchmark.sample_size} bids. {submission.benchmark.message}
              </p>
            ) : null}
          </InspectorSection>

          {submission.exclusions || submission.clarifications || submission.notes ? (
            <InspectorSection label="In their words">
              {submission.exclusions ? <Words label="Excludes" text={submission.exclusions} warn /> : null}
              {submission.clarifications ? <Words label="Clarifies" text={submission.clarifications} /> : null}
              {submission.notes ? <Words label="Notes" text={submission.notes} /> : null}
            </InspectorSection>
          ) : null}

          <SubmissionFiles submissionId={submission.id} />

          {bidPackage.status !== "awarded" ? (
            <LumpAdjustment context={withContext} submission={submission} onSubmissionChanged={onSubmissionChanged} />
          ) : null}

          {versions.length > 1 ? (
            <InspectorSection label="Versions">
              <ul className="space-y-1 text-[13px]">
                {versions.map((version) => (
                  <li key={version.id} className="flex justify-between gap-2">
                    <span className={version.is_current ? "font-medium" : "text-muted-foreground"}>
                      v{version.version}
                      {version.is_current ? " · current" : ""}
                    </span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {formatMoneyCents(version.total_cents ?? null)}
                      {version.submitted_at ? ` · ${format(new Date(version.submitted_at), "MMM d")}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </InspectorSection>
          ) : null}
        </>
      ) : (
        <InspectorSection label="Status">
          <p className="text-sm">{TRADE_STATE_LABELS[column.state]}</p>
          <p className="text-[13px] text-muted-foreground">
            {column.state === "lined_up"
              ? "They get a private link when you send the package."
              : column.state === "declined"
                ? `Declined${invite.declined_at ? ` on ${day(invite.declined_at)}` : ""}. They stay in your directory for the next one.`
                : column.state === "stale"
                  ? "Their price was for an older scope or has expired. Ask them to refresh it from their link."
                  : "They can price from their link until bidding closes. Got a number by phone or email? Enter it for them."}
          </p>
          {column.state === "lined_up" ? (
            <Button variant="outline" size="sm" className="justify-self-start" onClick={onRemove}>Remove from package</Button>
          ) : column.state !== "declined" && column.state !== "withdrawn" ? (
            <Button variant="outline" size="sm" className="justify-self-start" onClick={onEnterPrice}>Enter their price</Button>
          ) : null}
        </InspectorSection>
      )}

      <InspectorSection label="Before you hire them">
        <Check ok={!prequal} label={prequal ? "Prequalification" : "Prequalified"} detail={prequal ?? undefined} />
        <Check ok={!compliance} label={compliance ? "Insurance and paperwork" : "Insurance and paperwork current"} detail={compliance ?? undefined} />
        <Check ok={bidPackage.bond_required ? false : null} label="Bond" detail={bidPackage.bond_required ? "Required. You'll confirm it at award." : "Not required on this package"} />
        {stats?.change_order_growth_pct ? (
          <Check ok={stats.change_order_growth_pct <= 5} label="Change orders after award" detail={`Their past awards grew ${stats.change_order_growth_pct > 0 ? "+" : ""}${stats.change_order_growth_pct}% through change orders`} />
        ) : null}
      </InspectorSection>

      {pricingPanel}

      <div className="flex flex-wrap items-center gap-2 px-5 py-4">
        {canAward && hasPrices && submission && bidPackage.status !== "awarded" ? (
          <Button className="flex-1" variant={isLow ? "default" : "outline"} onClick={() => onAward(submission)}>
            Award {column.name}
          </Button>
        ) : null}
        {sent ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-foreground">
                <MoreHorizontal className="mr-1 h-4 w-4" />
                Their access
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={copyLink}>Copy their link</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void run(async () => unwrapAction(await resendBidInviteAction(withContext, invite.id)), "Invitation resent")}>
                Resend invitation
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {paused ? (
                <DropdownMenuItem onClick={() => void run(async () => unwrapAction(await resumeBidInviteAccessAction(withContext, invite.id)), "Access resumed")}>Resume access</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => void run(async () => unwrapAction(await pauseBidInviteAccessAction(withContext, invite.id)), "Access paused")}>Pause access</DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() =>
                  void run(
                    async () => unwrapAction(await setBidInviteRequireAccountAction(withContext, invite.id, !invite.require_account_enforced)),
                    invite.require_account_enforced ? "Account no longer required" : "Account now required",
                  )
                }
              >
                {invite.require_account_enforced ? "Don't require an account" : "Require an account"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => void run(async () => unwrapAction(await revokeBidInviteAccessAction(withContext, invite.id)), "Access revoked")}>
                Revoke access
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </>
  )
}

function ordinal(place: number) {
  const suffix = place % 10 === 2 && place % 100 !== 12 ? "nd" : place % 10 === 3 && place % 100 !== 13 ? "rd" : "th"
  return `${place}${suffix}`
}

function Words({ label, text, warn }: { label: string; text: string; warn?: boolean }) {
  return (
    <div className="text-[13px]">
      <p className={cn("text-xs font-medium", warn ? "text-warning" : "text-muted-foreground")}>{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap">{text}</p>
    </div>
  )
}

function SubmissionFiles({ submissionId }: { submissionId: string }) {
  const [files, setFiles] = useState<Array<{ id: string; name: string; url?: string }> | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    setFiles(null)
    setError(false)
    listAttachmentsAction("bid_submission", submissionId)
      .then((links) => {
        if (!active) return
        setFiles(
          (links ?? []).map((link) => {
            const record = link as unknown as { id: string; file?: { file_name?: string; download_url?: string } }
            return { id: record.id, name: record.file?.file_name ?? "Attachment", url: record.file?.download_url }
          }),
        )
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [submissionId])

  if (files && files.length === 0) return null
  return (
    <InspectorSection label="Their files">
      {error ? (
        <p className="text-[13px] text-muted-foreground">Couldn't load their files.</p>
      ) : files === null ? (
        <Skeleton className="h-5 w-2/3" />
      ) : (
        <ul className="space-y-1">
          {files.map((file) => (
            <li key={file.id} className="flex items-center gap-2 text-[13px]">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              {file.url ? (
                <a href={file.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" aria-label={`Download ${file.name}`}>
                  <Download className="h-3.5 w-3.5" />
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </InspectorSection>
  )
}

function LumpAdjustment({
  context,
  submission,
  onSubmissionChanged,
}: {
  context: BidWorkbenchContext & { bidPackageId: string }
  submission: BidSubmission
  onSubmissionChanged: (submission: BidSubmission) => void
}) {
  const [value, setValue] = useState(submission.leveled_adjustment_cents ? String(submission.leveled_adjustment_cents / 100) : "")
  const [note, setNote] = useState(submission.leveling_notes ?? "")
  const [isSaving, startSaving] = useTransition()
  const cents = value.trim() ? parseCurrencyToCents(value) : 0
  const changed = cents !== (submission.leveled_adjustment_cents ?? 0) || note !== (submission.leveling_notes ?? "")

  function save() {
    if (Number.isNaN(cents)) {
      toast.error("Enter an amount like 1,500 or -800")
      return
    }
    startSaving(async () => {
      try {
        const saved = unwrapAction(
          await updateBidSubmissionLevelingAction(context, {
            bid_submission_id: submission.id,
            leveled_adjustment_cents: cents,
            leveling_notes: note.trim() || null,
          }),
        )
        onSubmissionChanged({ ...submission, leveled_adjustment_cents: saved.leveled_adjustment_cents, leveling_notes: saved.leveling_notes })
        toast.success("Leveling saved")
      } catch (error) {
        toast.error("Leveling not saved", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  return (
    <InspectorSection label="Level the whole bid">
      <p className="text-xs text-muted-foreground">For anything a line plug can't capture: a qualification, a schedule premium, a missing permit.</p>
      <div className="flex gap-2">
        <Input aria-label="Adjustment" inputMode="decimal" placeholder="$0" value={value} onChange={(event) => setValue(event.target.value)} className="h-8 w-28 text-right font-mono tabular-nums" />
        <Input aria-label="Why" placeholder="Why" value={note} onChange={(event) => setNote(event.target.value)} className="h-8 flex-1" />
      </div>
      {changed ? (
        <Button size="sm" variant="outline" className="justify-self-start" onClick={save} disabled={isSaving}>
          {isSaving ? "Saving…" : "Save adjustment"}
        </Button>
      ) : null}
    </InspectorSection>
  )
}

// ---------------------------------------------------------------- price cell

/** One price on the board. Excluded scope gets a plug so every column compares the same work. */
export function CellInspector({
  context,
  bidPackage,
  scope,
  column,
  others,
  locked,
  onSubmissionChanged,
  onClose,
}: {
  context: BidWorkbenchContext
  bidPackage: BidPackage
  scope: BidScopeItem
  column: TradeColumn
  others: number[]
  locked: boolean
  onSubmissionChanged: (submission: BidSubmission) => void
  onClose: () => void
}) {
  const submission = column.submission
  const item = submission ? itemForScope(submission, scope.id) : undefined
  const [custom, setCustom] = useState(item?.gc_plug_cents != null ? String(item.gc_plug_cents / 100) : "")
  const [note, setNote] = useState(item?.gc_note ?? "")
  const [isSaving, startSaving] = useTransition()
  const sorted = [...others].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null

  function savePlug(cents: number | null) {
    if (!item || !submission) return
    if (cents != null && (Number.isNaN(cents) || cents < 0)) {
      toast.error("A plug is a positive amount")
      return
    }
    startSaving(async () => {
      try {
        const saved = unwrapAction(
          await updateBidSubmissionItemLevelingAction(
            { ...context, bidPackageId: bidPackage.id },
            { bid_submission_item_id: item.id, gc_plug_cents: cents, gc_note: note.trim() || null },
          ),
        )
        onSubmissionChanged({ ...submission, items: (submission.items ?? []).map((entry) => (entry.id === saved.id ? saved : entry)) })
        setCustom(cents != null ? String(cents / 100) : "")
        toast.success(cents == null ? "Plug cleared" : `Plugged at ${formatMoneyCents(cents)}`)
      } catch (error) {
        toast.error("Plug not saved", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  const title = scope.description
  if (!item) {
    return (
      <>
        <InspectorHeader title={title} subtitle={column.name} onClose={onClose} />
        <InspectorSection>
          <p className="text-[13px] text-muted-foreground">This bid has no answer for this line. It was priced before the line was added.</p>
        </InspectorSection>
      </>
    )
  }

  if (item.response === "priced") {
    return (
      <>
        <InspectorHeader title={title} subtitle={column.name} onClose={onClose} />
        <InspectorSection>
          <p className="font-mono text-[28px] font-medium leading-none tracking-tight tabular-nums">{formatMoneyCents(item.amount_cents ?? null)}</p>
          <Facts
            rows={[
              item.quantity != null && item.unit_rate_cents != null ? ["Unit rate", `${formatMoneyCents(item.unit_rate_cents)} × ${item.quantity}`] : null,
              scope.budget_cents != null ? ["Your budget", <span key="b" className="font-mono tabular-nums">{formatMoneyCents(scope.budget_cents)}</span>] : null,
              sorted.length ? ["Other bidders", <span key="o" className="font-mono tabular-nums">{sorted.map((value) => formatMoneyCents(value)).join(" · ")}</span>] : null,
            ]}
          />
          {item.notes ? <Words label="Their note" text={item.notes} /> : null}
          <p className="text-xs text-muted-foreground">Priced as specified. Nothing to level.</p>
        </InspectorSection>
      </>
    )
  }

  if (scope.item_type === "alternate") {
    return (
      <>
        <InspectorHeader title={title} subtitle={column.name} onClose={onClose} />
        <InspectorSection>
          <p className="text-[13px] text-muted-foreground">No price on this alternate, so it can't be accepted if you award {column.name}.</p>
        </InspectorSection>
      </>
    )
  }

  const options: Array<{ label: string; cents: number }> = [
    ...(median != null ? [{ label: "The other bidders' median", cents: median }] : []),
    ...(scope.budget_cents != null ? [{ label: "Your budget for this line", cents: scope.budget_cents }] : []),
    { label: "Covered elsewhere", cents: 0 },
  ]

  return (
    <>
      <InspectorHeader title={title} subtitle={`${column.name} ${item.response === "excluded" ? "excluded this" : "didn't price this"}`} onClose={onClose} />
      <InspectorSection>
        {item.notes ? <p className="bg-muted px-3 py-2 text-[13px]">“{item.notes}”</p> : null}
        <p className="microlabel pt-1">Level it with</p>
        <div className="grid gap-1.5">
          {options.map((option) => {
            const on = item.gc_plug_cents === option.cents
            return (
              <button
                key={option.label}
                type="button"
                disabled={locked || isSaving}
                onClick={() => savePlug(option.cents)}
                className={cn(
                  "flex items-center justify-between gap-3 border px-3 py-2 text-left text-[13px] transition-colors hover:border-muted-foreground disabled:pointer-events-none disabled:opacity-60",
                  on && "border-primary bg-primary/[0.05]",
                )}
              >
                <span>{option.label}</span>
                <span className="font-mono tabular-nums">{formatMoneyCents(option.cents)}</span>
              </button>
            )
          })}
        </div>
        <div className="flex gap-2">
          <Input aria-label="Custom plug" inputMode="decimal" placeholder="Other amount" value={custom} disabled={locked} onChange={(event) => setCustom(event.target.value)} className="h-8 flex-1 text-right font-mono tabular-nums" />
          <Button size="sm" variant="outline" disabled={locked || isSaving || !custom.trim()} onClick={() => savePlug(parseCurrencyToCents(custom))}>Use</Button>
        </div>
        <Textarea aria-label="Plug note" rows={2} value={note} disabled={locked} onChange={(event) => setNote(event.target.value)} placeholder="Where the number came from (saved with the plug)" />
        {item.gc_plug_cents != null && !locked ? (
          <Button variant="ghost" size="sm" className="justify-self-start px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={() => savePlug(null)} disabled={isSaving}>
            Clear the plug
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground">A plug only changes the comparison. If you award {column.name}, you'll say who actually covers this line.</p>
      </InspectorSection>
    </>
  )
}

// ---------------------------------------------------------------- awarded

/** After award: everything it touched, and the way back if it was a mistake. */
export function AwardedInspector({
  bidPackage,
  award,
  notified,
  onOpenSubcontract,
  onRescind,
}: {
  bidPackage: BidPackage
  award: BidPackageAward
  notified: number
  onOpenSubcontract: () => void
  onRescind: () => void
}) {
  const commitment = award.commitment
  const stage = commitment ? subcontractStage({ status: commitment.status, executed_at: commitment.executed_at }, award.envelope) : null
  const priceBook = bidPackage.award_target === "price_agreement"
  return (
    <>
      <InspectorHeader
        title="Where this went"
        subtitle={`Awarded ${format(new Date(award.awarded_at), "MMM d")}${award.awarded_by_name ? ` by ${award.awarded_by_name}` : ""}`}
      />
      <InspectorSection>
        <ul className="divide-y text-[13px]">
          {commitment ? (
            <li>
              <button type="button" onClick={onOpenSubcontract} className="group flex w-full items-center justify-between gap-3 py-2.5 text-left">
                <span className="min-w-0">
                  <span className="block truncate font-medium group-hover:text-primary">
                    {commitment.contract_number ? `Subcontract ${commitment.contract_number}` : "Subcontract"}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{commitment.company_name}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-mono tabular-nums">{formatMoneyCents(commitment.total_cents)}</span>
                  {stage ? <span className="block text-xs text-muted-foreground">{SUBCONTRACT_STAGE_LABELS[stage]}</span> : null}
                </span>
              </button>
            </li>
          ) : null}
          {commitment && bidPackage.cost_code_code ? (
            <li className="flex items-center justify-between gap-3 py-2.5">
              <span>
                Budget · {bidPackage.cost_code_code}
                {bidPackage.cost_code_name ? ` ${bidPackage.cost_code_name}` : ""}
              </span>
              <span className="text-xs text-muted-foreground">
                {stage === "draft" ? "Committed once approved" : "Committed"}
              </span>
            </li>
          ) : null}
          {priceBook ? (
            <li className="py-2.5">Prices added to the price book</li>
          ) : null}
          <li className="flex items-center justify-between gap-3 py-2.5">
            <span>Award notices</span>
            <span className="text-xs text-muted-foreground">{notified ? `Sent to ${notified} ${notified === 1 ? "bidder" : "bidders"}` : "No bidders to notify"}</span>
          </li>
          {award.accepted_alternate_ids.length ? (
            <li className="flex items-center justify-between gap-3 py-2.5">
              <span>Alternates accepted</span>
              <span className="text-xs text-muted-foreground">{award.accepted_alternate_ids.length}</span>
            </li>
          ) : null}
        </ul>
        {commitment ? (
          <Button variant="outline" size="sm" className="justify-self-start" onClick={onOpenSubcontract}>
            Open subcontract
            <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        ) : null}
      </InspectorSection>
      {award.notes ? (
        <InspectorSection label="Award notes">
          <p className="whitespace-pre-wrap text-[13px]">{award.notes}</p>
        </InspectorSection>
      ) : null}
      {stage !== "executed" ? (
        <InspectorSection>
          <Button variant="ghost" size="sm" className="justify-self-start px-0 text-destructive hover:bg-transparent hover:text-destructive" onClick={onRescind}>
            Rescind award…
          </Button>
        </InspectorSection>
      ) : null}
    </>
  )
}
