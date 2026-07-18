"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { BidInvite, BidPackage, BidScopeItem, BidSubmission } from "@/lib/services/bids"
import type { Company } from "@/lib/types"
import type { BidSubmissionItemResponse } from "@/lib/validation/bids"
import {
  bulkCreateBidInvitesAction,
  createManualBidSubmissionAction,
  generateBidInviteLinkAction,
  pauseBidInviteAccessAction,
  resendBidInviteAction,
  resumeBidInviteAccessAction,
  revokeBidInviteAccessAction,
  setBidInviteRequireAccountAction,
} from "@/app/(app)/bids/actions"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal, Plus, UserPlus } from "@/components/icons"
import { money, parseCurrencyToCents, type BidWorkbenchContext } from "@/components/bids/bid-workbench-helpers"

const INVITE_STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  sent: "bg-primary/10 text-primary border-primary/20",
  viewed: "bg-primary/10 text-primary border-primary/20",
  submitted: "bg-success/10 text-success border-success/20",
  declined: "bg-destructive/10 text-destructive border-destructive/20",
  withdrawn: "bg-muted text-muted-foreground border-border",
}

const ALL_TRADES = "__all__"

interface BidVendorsSectionProps {
  context: BidWorkbenchContext
  bidPackage: BidPackage
  invites: BidInvite[]
  submissions: BidSubmission[]
  scopeItems: BidScopeItem[]
  companies: Company[]
  tradeOptions: string[]
  locked: boolean
  reloadInvites: () => Promise<void>
  reloadSubmissions: () => Promise<void>
}

export function BidVendorsSection({
  context,
  bidPackage,
  invites,
  submissions,
  scopeItems,
  companies,
  tradeOptions,
  locked,
  reloadInvites,
  reloadSubmissions,
}: BidVendorsSectionProps) {
  const [inviteOpen, setInviteOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)

  const submissionByInvite = useMemo(() => {
    const map = new Map<string, BidSubmission>()
    for (const submission of submissions) {
      if (submission.is_current) map.set(submission.bid_invite_id, submission)
    }
    return map
  }, [submissions])

  const withContext = { ...context, bidPackageId: bidPackage.id }

  async function withReload(fn: () => Promise<unknown>, message: string) {
    try {
      await fn()
      await reloadInvites()
      toast.success(message)
    } catch (error) {
      toast.error("Action failed", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    }
  }

  /** Clipboard writes must begin inside the click gesture — awaiting the
   * server first makes Safari reject writeText ("not allowed by the user
   * agent"). ClipboardItem accepts a promise, so the write starts
   * synchronously and the URL arrives when the action resolves. Issues an
   * additional link (revokeExisting: false) so copying never invalidates the
   * link the sub already received by email. */
  function copyBidLink(inviteId: string) {
    const urlPromise = (async () => {
      const link = unwrapAction(
        await generateBidInviteLinkAction(withContext, inviteId, { revokeExisting: false }),
      )
      return link.url
    })()

    const finish = (promise: Promise<unknown>) =>
      promise
        .then(() => toast.success("Bid link copied"))
        .catch(async (error) => {
          // Last resort: surface the URL so it can be copied by hand.
          const url = await urlPromise.catch(() => null)
          toast.error("Failed to copy link", {
            description:
              url ?? (error instanceof Error ? error.message : "Please try again."),
            duration: 10000,
          })
        })

    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const item = new ClipboardItem({
        "text/plain": urlPromise.then((url) => new Blob([url], { type: "text/plain" })),
      })
      finish(navigator.clipboard.write([item]))
    } else {
      finish(urlPromise.then((url) => navigator.clipboard.writeText(url)))
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          Vendors <span className="font-normal text-muted-foreground">{invites.length}</span>
        </h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setManualOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Enter bid
          </Button>
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus className="mr-1.5 h-3.5 w-3.5" />
            Invite vendors
          </Button>
        </div>
      </div>

      {invites.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No vendors invited yet. Invite vendors to start collecting bids.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-3 py-2">Vendor</TableHead>
                <TableHead className="px-3 py-2">Contact</TableHead>
                <TableHead className="px-3 py-2">Status</TableHead>
                <TableHead className="px-3 py-2">Last activity</TableHead>
                <TableHead className="px-3 py-2">Access</TableHead>
                <TableHead className="w-10 px-3 py-2" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.map((invite) => {
                const submission = submissionByInvite.get(invite.id)
                const lastActivity =
                  invite.submitted_at ?? invite.last_viewed_at ?? invite.sent_at ?? invite.created_at
                const paused = (invite.paused_access_count ?? 0) > 0
                const revoked = (invite.revoked_access_count ?? 0) > 0
                return (
                  <TableRow key={invite.id}>
                    <TableCell className="px-3 py-2 font-medium">
                      {invite.company?.name ?? invite.invite_email ?? "Vendor"}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-muted-foreground">
                      {invite.contact?.full_name ?? invite.invite_email ?? "—"}
                    </TableCell>
                    <TableCell className="px-3 py-2">
                      <Badge
                        variant="outline"
                        className={INVITE_STATUS_TONE[invite.status] ?? INVITE_STATUS_TONE.draft}
                      >
                        {submission ? "Submitted" : invite.status[0].toUpperCase() + invite.status.slice(1)}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-3 py-2 text-muted-foreground">
                      {lastActivity ? format(new Date(lastActivity), "MMM d, h:mm a") : "—"}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-xs text-muted-foreground">
                      {revoked ? "Revoked" : paused ? "Paused" : invite.require_account_enforced ? "Account required" : "Active"}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => copyBidLink(invite.id)}>
                            Copy bid link
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              withReload(
                                async () => unwrapAction(await resendBidInviteAction(withContext, invite.id)),
                                "Invitation resent",
                              )
                            }
                          >
                            Resend invitation
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {paused ? (
                            <DropdownMenuItem
                              onClick={() =>
                                withReload(
                                  async () => unwrapAction(await resumeBidInviteAccessAction(withContext, invite.id)),
                                  "Access resumed",
                                )
                              }
                            >
                              Resume access
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={() =>
                                withReload(
                                  async () => unwrapAction(await pauseBidInviteAccessAction(withContext, invite.id)),
                                  "Access paused",
                                )
                              }
                            >
                              Pause access
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() =>
                              withReload(
                                async () =>
                                  unwrapAction(
                                    await setBidInviteRequireAccountAction(
                                      withContext,
                                      invite.id,
                                      !invite.require_account_enforced,
                                    ),
                                  ),
                                invite.require_account_enforced ? "Account no longer required" : "Account now required",
                              )
                            }
                          >
                            {invite.require_account_enforced ? "Don't require account" : "Require account"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() =>
                              withReload(
                                async () => unwrapAction(await revokeBidInviteAccessAction(withContext, invite.id)),
                                "Access revoked",
                              )
                            }
                          >
                            Revoke access
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        context={withContext}
        bidPackage={bidPackage}
        companies={companies}
        tradeOptions={tradeOptions}
        invitedCompanyIds={new Set(invites.map((invite) => invite.company_id))}
        onInvited={reloadInvites}
      />

      <ManualBidDialog
        open={manualOpen}
        onOpenChange={setManualOpen}
        context={withContext}
        bidPackage={bidPackage}
        invites={invites}
        companies={companies}
        scopeItems={scopeItems}
        locked={locked}
        onEntered={async () => {
          await reloadSubmissions()
          await reloadInvites()
        }}
      />
    </div>
  )
}

function InviteDialog({
  open,
  onOpenChange,
  context,
  bidPackage,
  companies,
  tradeOptions,
  invitedCompanyIds,
  onInvited,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: BidWorkbenchContext & { bidPackageId?: string | null }
  bidPackage: BidPackage
  companies: Company[]
  tradeOptions: string[]
  invitedCompanyIds: Set<string | undefined>
  onInvited: () => Promise<void>
}) {
  const [tradeFilter, setTradeFilter] = useState(ALL_TRADES)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [email, setEmail] = useState("")
  const [emails, setEmails] = useState<string[]>([])
  const [isSaving, startSaving] = useTransition()

  const filtered = useMemo(() => {
    const subs = companies.filter(
      (company) => company.company_type === "subcontractor" || company.company_type === "supplier",
    )
    const base = subs.length > 0 ? subs : companies
    if (tradeFilter === ALL_TRADES) return base
    return base.filter((company) => (company.trade ?? "").toLowerCase() === tradeFilter.toLowerCase())
  }, [companies, tradeFilter])

  function reset() {
    setTradeFilter(ALL_TRADES)
    setSelected(new Set())
    setEmail("")
    setEmails([])
  }

  function addEmail() {
    const trimmed = email.trim()
    if (!trimmed) return
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
      toast.error("Enter a valid email")
      return
    }
    setEmails((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]))
    setEmail("")
  }

  function handleInvite() {
    const inviteItems = [
      ...Array.from(selected).map((companyId) => ({ company_id: companyId })),
      ...emails.map((address) => ({ invite_email: address })),
    ]
    if (inviteItems.length === 0) {
      toast.error("Select at least one vendor")
      return
    }
    startSaving(async () => {
      try {
        unwrapAction(
          await bulkCreateBidInvitesAction(context, {
            bid_package_id: bidPackage.id,
            invites: inviteItems,
            send_emails: true,
          }),
        )
        await onInvited()
        toast.success("Vendors invited")
        reset()
        onOpenChange(false)
      } catch (error) {
        toast.error("Failed to invite vendors", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value)
        if (!value) reset()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite vendors</DialogTitle>
          <DialogDescription>Send bid invitations for {bidPackage.title}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={tradeFilter} onValueChange={setTradeFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by trade" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TRADES}>All trades</SelectItem>
              {tradeOptions.map((trade) => (
                <SelectItem key={trade} value={trade}>
                  {trade}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <ScrollArea className="h-56 rounded-md border">
            <div className="divide-y">
              {filtered.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">No companies match.</p>
              ) : (
                filtered.map((company) => {
                  const already = invitedCompanyIds.has(company.id)
                  return (
                    <label
                      key={company.id}
                      className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-muted/40"
                    >
                      <Checkbox
                        checked={selected.has(company.id)}
                        disabled={already}
                        onCheckedChange={(value) =>
                          setSelected((prev) => {
                            const next = new Set(prev)
                            if (value === true) next.add(company.id)
                            else next.delete(company.id)
                            return next
                          })
                        }
                      />
                      <span className="flex-1">{company.name}</span>
                      {company.trade ? <span className="text-xs text-muted-foreground">{company.trade}</span> : null}
                      {already ? <span className="text-xs text-muted-foreground">Invited</span> : null}
                    </label>
                  )
                })
              )}
            </div>
          </ScrollArea>

          <div className="space-y-1.5">
            <Label className="text-xs">Invite by email</Label>
            <div className="flex gap-2">
              <Input
                value={email}
                type="email"
                placeholder="name@company.com"
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    addEmail()
                  }
                }}
              />
              <Button type="button" variant="outline" onClick={addEmail}>
                Add
              </Button>
            </div>
            {emails.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {emails.map((address) => (
                  <Badge key={address} variant="secondary" className="gap-1">
                    {address}
                    <button
                      type="button"
                      onClick={() => setEmails((prev) => prev.filter((entry) => entry !== address))}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      ×
                    </button>
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleInvite} disabled={isSaving}>
            {isSaving ? "Inviting…" : "Send invitations"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ManualRow {
  key: string
  scopeId: string | null
  description: string
  response: BidSubmissionItemResponse
  amount: string
}

let manualSeq = 0
function newManualRow(): ManualRow {
  manualSeq += 1
  return { key: `m-${manualSeq}`, scopeId: null, description: "", response: "priced", amount: "" }
}

function ManualBidDialog({
  open,
  onOpenChange,
  context,
  bidPackage,
  invites,
  companies,
  scopeItems,
  locked,
  onEntered,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: BidWorkbenchContext & { bidPackageId?: string | null }
  bidPackage: BidPackage
  invites: BidInvite[]
  companies: Company[]
  scopeItems: BidScopeItem[]
  locked: boolean
  onEntered: () => Promise<void>
}) {
  const hasScope = scopeItems.length > 0
  const [target, setTarget] = useState("")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [exclusions, setExclusions] = useState("")
  const [notes, setNotes] = useState("")
  const [scopeRows, setScopeRows] = useState<Record<string, { response: BidSubmissionItemResponse; amount: string }>>({})
  const [freeRows, setFreeRows] = useState<ManualRow[]>([newManualRow()])
  const [isSaving, startSaving] = useTransition()

  const targetOptions = useMemo(() => {
    const invited = invites.map((invite) => ({
      value: `invite:${invite.id}`,
      label: invite.company?.name ?? invite.invite_email ?? "Vendor",
    }))
    const others = companies
      .filter((company) => !invites.some((invite) => invite.company_id === company.id))
      .map((company) => ({ value: `company:${company.id}`, label: company.name }))
    return [...invited, ...others]
  }, [invites, companies])

  function reset() {
    setTarget("")
    setName("")
    setEmail("")
    setExclusions("")
    setNotes("")
    setScopeRows({})
    setFreeRows([newManualRow()])
  }

  function buildItems() {
    if (hasScope) {
      return scopeItems.map((scope) => {
        const row = scopeRows[scope.id] ?? { response: "priced" as BidSubmissionItemResponse, amount: "" }
        return {
          bid_scope_item_id: scope.id,
          description: scope.description,
          response: row.response,
          amount_cents: row.response === "priced" && row.amount.trim() ? parseCurrencyToCents(row.amount) : null,
        }
      })
    }
    return freeRows
      .filter((row) => row.description.trim())
      .map((row) => ({
        description: row.description.trim(),
        response: "priced" as BidSubmissionItemResponse,
        amount_cents: row.amount.trim() ? parseCurrencyToCents(row.amount) : null,
      }))
  }

  function handleSubmit() {
    if (!target) {
      toast.error("Select a vendor")
      return
    }
    const items = buildItems()
    const total = items
      .filter((item) => item.response === "priced")
      .reduce((sum, item) => sum + (item.amount_cents ?? 0), 0)
    if (total <= 0) {
      toast.error("Enter at least one priced amount")
      return
    }
    const [kind, id] = target.split(":")
    startSaving(async () => {
      try {
        unwrapAction(
          await createManualBidSubmissionAction(context, {
            bid_package_id: bidPackage.id,
            bid_invite_id: kind === "invite" ? id : null,
            company_id: kind === "company" ? id : null,
            total_cents: total,
            currency: "usd",
            submitted_by_name: name.trim() || null,
            submitted_by_email: email.trim() || null,
            exclusions: exclusions.trim() || null,
            notes: notes.trim() || null,
            items,
          }),
        )
        await onEntered()
        toast.success("Bid entered")
        reset()
        onOpenChange(false)
      } catch (error) {
        toast.error("Failed to enter bid", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value)
        if (!value) reset()
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Enter a bid</DialogTitle>
          <DialogDescription>Record a bid received outside the portal.</DialogDescription>
        </DialogHeader>
        {locked ? (
          <p className="text-sm text-muted-foreground">This package is awarded — bids can no longer be entered.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Vendor</Label>
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select vendor" />
                  </SelectTrigger>
                  <SelectContent>
                    {targetOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Submitted by</Label>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" />
              </div>
            </div>

            {hasScope ? (
              <div className="overflow-hidden rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-2 py-1.5">Scope</TableHead>
                      <TableHead className="w-32 px-2 py-1.5">Response</TableHead>
                      <TableHead className="w-28 px-2 py-1.5 text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scopeItems.map((scope) => {
                      const row = scopeRows[scope.id] ?? { response: "priced" as BidSubmissionItemResponse, amount: "" }
                      return (
                        <TableRow key={scope.id}>
                          <TableCell className="px-2 py-1.5">{scope.description}</TableCell>
                          <TableCell className="px-2 py-1.5">
                            <Select
                              value={row.response}
                              onValueChange={(value) =>
                                setScopeRows((prev) => ({
                                  ...prev,
                                  [scope.id]: { ...row, response: value as BidSubmissionItemResponse },
                                }))
                              }
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="priced">Priced</SelectItem>
                                <SelectItem value="excluded">Excluded</SelectItem>
                                <SelectItem value="no_bid">No bid</SelectItem>
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell className="px-2 py-1.5">
                            <Input
                              className="h-8 text-right tabular-nums"
                              value={row.amount}
                              inputMode="decimal"
                              disabled={row.response !== "priced"}
                              onChange={(event) =>
                                setScopeRows((prev) => ({
                                  ...prev,
                                  [scope.id]: { ...row, amount: event.target.value },
                                }))
                              }
                            />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="space-y-2">
                {freeRows.map((row) => (
                  <div key={row.key} className="flex gap-2">
                    <Input
                      className="flex-1"
                      value={row.description}
                      placeholder="Line description"
                      onChange={(event) =>
                        setFreeRows((prev) =>
                          prev.map((entry) => (entry.key === row.key ? { ...entry, description: event.target.value } : entry)),
                        )
                      }
                    />
                    <Input
                      className="w-32 text-right tabular-nums"
                      value={row.amount}
                      inputMode="decimal"
                      placeholder="$0"
                      onChange={(event) =>
                        setFreeRows((prev) =>
                          prev.map((entry) => (entry.key === row.key ? { ...entry, amount: event.target.value } : entry)),
                        )
                      }
                    />
                  </div>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setFreeRows((prev) => [...prev, newManualRow()])}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add line
                </Button>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Email</Label>
                <Input value={email} type="email" onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Exclusions</Label>
              <Textarea value={exclusions} rows={2} onChange={(event) => setExclusions(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Notes</Label>
              <Textarea value={notes} rows={2} onChange={(event) => setNotes(event.target.value)} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving || locked}>
            {isSaving ? "Saving…" : "Enter bid"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
