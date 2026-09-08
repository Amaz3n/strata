"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { SuccessCheck } from "@/components/portal/success-check"
import { vendorPaymentStage, type VendorPaymentStageLabel } from "@/lib/payments/disbursement-stage"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type {
  VendorEntityMember,
  VendorPaymentSetupContext,
} from "@/lib/services/vendor-payment-identities"
import {
  decideVendorEntityJoinRequestAction,
  inviteVendorEntityAdministratorAction,
  removeVendorEntityMemberAction,
  resendVendorEmailVerificationAction,
  respondToVendorEntityInvitationAction,
  startVendorPayoutSetupAction,
} from "./actions"

const NEW_ENTITY = "new"

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100)

const paymentDate = (value: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(value),
  )

const METHOD_LABELS: Record<string, string> = {
  ach: "Direct deposit",
  check: "Check",
  wire: "Wire",
  card: "Card",
  cash: "Cash",
  // A credit is not a way of sending money, it is the absence of one. Falling
  // through to the raw key printed "credit" beside an amount the vendor was
  // never sent.
  credit: "Credit applied",
  other: "Other",
}

/**
 * State colour for one payment stage. Returned money is the one thing on this
 * page a vendor has to act on, so it is the one thing that is not grey.
 */
const STAGE_TONE: Record<VendorPaymentStageLabel, string> = {
  Submitted: "text-muted-foreground",
  "Builder debited": "text-muted-foreground",
  "In transit": "text-foreground",
  "Paid to your bank": "text-success",
  Paid: "text-success",
  "Credit applied": "text-muted-foreground",
  Returned: "text-destructive",
  Failed: "text-destructive",
  Canceled: "text-muted-foreground",
}

function StageCell({ label }: { label: VendorPaymentStageLabel }) {
  return <span className={`whitespace-nowrap text-xs font-medium ${STAGE_TONE[label]}`}>{label}</span>
}

const ROLE_LABELS: Record<VendorEntityMember["role"], string> = {
  owner: "Owner",
  administrator: "Administrator",
  member: "Member",
}

export function VendorPaymentSetup({
  token,
  context,
  justVerified,
  linkExpired,
}: {
  token: string
  /** True only on the redirect back from a completed Stripe onboarding. */
  justVerified: boolean
  /** Stripe bounced the vendor back because the onboarding link timed out. */
  linkExpired: boolean
  context: VendorPaymentSetupContext
}) {
  const { builder } = context
  const relationship = context.relationships.find((candidate) => candidate.orgId === builder.orgId) ?? null
  const linkedEntity = relationship
    ? context.entities.find((candidate) => candidate.id === relationship.vendorEntityId) ?? null
    : null
  const recipient = linkedEntity?.recipient ?? null
  const isReady = recipient?.status === "ready" && recipient.payoutsEnabled
  /**
   * Stripe has everything and is deciding. Offering "Continue verification"
   * here reopened a hosted form with no fields left to fill in, which reads as
   * a broken flow and generated the "I did this already" support calls. The
   * button comes back the moment Stripe asks for something.
   */
  const underReview = recipient?.status === "pending_review" && recipient.requirementsCurrentlyDue.length === 0
  const otherBuilders = context.relationships.filter((candidate) => candidate.orgId !== builder.orgId)
  /**
   * A payout account this vendor already verified with another builder. It
   * belongs to their legal entity, not to any builder, so connecting it here is
   * a confirmation rather than a second round of Stripe onboarding.
   */
  const verifiedEntity =
    context.entities.find((candidate) => candidate.recipient?.status === "ready" && candidate.recipient.payoutsEnabled) ?? null
  const administeredEntities = context.entities.filter((candidate) => candidate.role !== "member")

  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedEntity, setSelectedEntity] = useState(context.entities[0]?.id ?? NEW_ENTITY)
  const [editingName, setEditingName] = useState(false)
  const [choosingEntity, setChoosingEntity] = useState(false)
  const [legalName, setLegalName] = useState(builder.companyName)
  const [dbaName, setDbaName] = useState("")

  const namingNewEntity = context.entities.length === 0 || selectedEntity === NEW_ENTITY
  const canSubmit = !pending && context.emailVerified && (!namingNewEntity || legalName.trim().length > 0)

  /** One place every mutation on this page reports through. */
  const run = <T,>(action: () => Promise<{ success: true; data: T } | { success: false; error: string }>, onDone: (data: T) => void) => {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const result = await action()
      if (!result.success) {
        setError(result.error)
        return
      }
      onDone(result.data)
    })
  }

  const start = (vendorEntityId?: string) => {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const result = await startVendorPayoutSetupAction({
        portal_token: token,
        return_path: `/s/${token}/payments`,
        ...(vendorEntityId
          ? { vendor_entity_id: vendorEntityId }
          : { legal_name: legalName.trim(), dba_name: dbaName.trim() || undefined }),
      })
      if (!result.success) {
        setError(result.error)
        return
      }
      // No url means the existing account was adopted — there is nothing left
      // to verify, so stay here and show the connected state.
      if (result.data.url) {
        window.location.assign(result.data.url)
        return
      }
      router.refresh()
    })
  }

  const resendVerification = () =>
    run(resendVendorEmailVerificationAction, (data) => {
      setNotice(
        data.alreadyVerified
          ? "Your email is already confirmed. Reload this page to continue."
          : data.sent
            ? `We sent a new confirmation link to ${context.identity?.email ?? "your email"}.`
            : "We could not send the confirmation email just now. Try again in a few minutes.",
      )
      if (data.alreadyVerified) router.refresh()
    })

  return (
    <div className="space-y-6 desk-rise">
      {error ? (
        <div role="alert" className="border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div role="status" className="border border-border bg-muted/40 px-4 py-3 text-sm">
          {notice}
        </div>
      ) : null}

      {context.invitations.length > 0 ? (
        <section className="border border-border bg-card p-5">
          <h2 className="text-base font-semibold">You were invited to administer a company</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Accepting lets you set up and manage payouts for it. Only accept if you work there.
          </p>
          <ul className="mt-4 divide-y border border-border">
            {context.invitations.map((invitation) => (
              <li key={invitation.membershipId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm font-medium">{invitation.entityLegalName}</span>
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => respondToVendorEntityInvitationAction({ membership_id: invitation.membershipId, accept: true }),
                        () => router.refresh(),
                      )
                    }
                  >
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => respondToVendorEntityInvitationAction({ membership_id: invitation.membershipId, accept: false }),
                        () => router.refresh(),
                      )
                    }
                  >
                    Decline
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {context.pendingJoinRequests.length > 0 ? (
        <section className="border border-border bg-card p-5" role="status">
          <h2 className="text-base font-semibold">Waiting on an administrator</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {context.pendingJoinRequests.map((request) => request.entityLegalName).join(", ")} is already set up on Arc.
            We asked its administrators to add you. Once one of them approves, come back here and finish payout setup —
            do not create a second company for the same business.
          </p>
        </section>
      ) : null}

      {!context.emailVerified ? (
        <section className="border border-warning/40 bg-warning/5 p-5">
          <h2 className="text-base font-semibold text-warning">Confirm your email first</h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Payout setup decides where {builder.orgName}&rsquo;s money lands, so Arc confirms your address before it
            starts. Open the confirmation link we emailed to{" "}
            <span className="font-medium text-foreground">{context.identity?.email ?? "your address"}</span>, then
            reload this page. The rest of your portal keeps working either way.
          </p>
          <div className="mt-4">
            <Button variant="outline" size="sm" onClick={resendVerification} disabled={pending}>
              {pending ? "Sending…" : "Send it again"}
            </Button>
          </div>
        </section>
      ) : null}

      {linkExpired && !isReady ? (
        <div className="border border-warning bg-warning/10 px-4 py-3 text-sm">
          <p className="font-medium">Your verification link expired</p>
          <p className="mt-1 text-muted-foreground">
            Nothing was lost — anything you already entered is saved. Start again below to pick up where you left off.
          </p>
        </div>
      ) : null}

      <section className="border border-border bg-card p-5">
        {isReady ? (
          <>
            {justVerified ? <SuccessCheck className="mb-3" /> : null}
            <h2 className="text-base font-semibold">
              {justVerified ? "You're verified. You can be paid." : "Verified and ready"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {linkedEntity?.legalName} is verified. When {builder.orgName} pays you electronically, deposits go to{" "}
              {recipient?.bankName ?? "your verified bank"}
              {recipient?.bankLast4 ? ` •••• ${recipient.bankLast4}` : ""}. They may still send some payments by check.
            </p>
            <p className="mt-4 text-xs text-muted-foreground">
              To change your payout bank, contact Arc support. Bank changes require independent review before they take
              effect.
            </p>
          </>
        ) : verifiedEntity && !choosingEntity ? (
          <>
            <h2 className="text-base font-semibold">You&rsquo;re already verified</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {verifiedEntity.legalName} is verified with Arc, and deposits go to{" "}
              {verifiedEntity.recipient?.bankName ?? "your verified bank"}
              {verifiedEntity.recipient?.bankLast4 ? ` •••• ${verifiedEntity.recipient.bankLast4}` : ""}. Confirm this is
              the company {builder.orgName} knows as &ldquo;{builder.companyName}&rdquo; and they can pay you
              electronically right away — there is nothing to verify again.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-4">
              <Button onClick={() => start(verifiedEntity.id)} disabled={pending || !context.emailVerified}>
                {pending ? "Connecting…" : `Connect to ${builder.orgName}`}
              </Button>
              <button
                type="button"
                onClick={() => setChoosingEntity(true)}
                className="text-sm underline underline-offset-4 hover:text-muted-foreground"
              >
                That&rsquo;s a different company
              </button>
            </div>
          </>
        ) : linkedEntity && underReview ? (
          <>
            <h2 className="text-base font-semibold">Submitted — Stripe is reviewing</h2>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              {linkedEntity.legalName} is with Stripe for review. It usually takes a few minutes and sometimes up to a
              day. There is nothing for you to do — we will email you, and {builder.orgName} sees the same status. If
              Stripe needs anything else, a Continue button appears here.
            </p>
          </>
        ) : linkedEntity ? (
          <>
            <h2 className="text-base font-semibold">Finish verifying {linkedEntity.legalName}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Stripe still needs information before {builder.orgName} can pay you electronically. You can leave and come
              back — your progress is saved.
            </p>
            <div className="mt-5">
              <Button onClick={() => start(linkedEntity.id)} disabled={pending || !context.emailVerified}>
                {pending ? "Opening Stripe…" : "Continue verification"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold">Set up payouts from {builder.orgName}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Stripe will verify your business details, tax information, and payout bank. This usually takes a few
              minutes.
            </p>

            {context.entities.length > 0 ? (
              <fieldset className="mt-5">
                <legend className="text-sm font-medium">
                  Which of your companies is {builder.orgName}&rsquo;s &ldquo;{builder.companyName}&rdquo;?
                </legend>
                <div className="mt-3 divide-y border border-border">
                  {context.entities.map((entity) => (
                    <label key={entity.id} className="flex cursor-pointer items-center gap-3 px-4 py-3">
                      <input
                        type="radio"
                        name="vendor-entity"
                        value={entity.id}
                        checked={selectedEntity === entity.id}
                        onChange={() => setSelectedEntity(entity.id)}
                        className="accent-primary"
                      />
                      <span>
                        <span className="block text-sm font-medium">{entity.legalName}</span>
                        <span className="mt-0.5 block text-xs capitalize text-muted-foreground">
                          {entity.recipient ? entity.recipient.status.replaceAll("_", " ") : "Verification not started"}
                        </span>
                      </span>
                    </label>
                  ))}
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-3">
                    <input
                      type="radio"
                      name="vendor-entity"
                      value={NEW_ENTITY}
                      checked={selectedEntity === NEW_ENTITY}
                      onChange={() => setSelectedEntity(NEW_ENTITY)}
                      className="accent-primary"
                    />
                    <span className="text-sm font-medium">A different company</span>
                  </label>
                </div>
              </fieldset>
            ) : null}

            {namingNewEntity ? (
              editingName || context.entities.length > 0 ? (
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="legal-name">Legal company name</Label>
                    <Input id="legal-name" value={legalName} onChange={(event) => setLegalName(event.target.value)} />
                    <p className="text-xs text-muted-foreground">As filed with the IRS. Stripe verifies this.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="dba-name">DBA name (optional)</Label>
                    <Input id="dba-name" value={dbaName} onChange={(event) => setDbaName(event.target.value)} />
                  </div>
                </div>
              ) : (
                <p className="mt-5 text-sm">
                  Paying <span className="font-medium">{legalName}</span>.{" "}
                  <button
                    type="button"
                    onClick={() => setEditingName(true)}
                    className="underline underline-offset-4 hover:text-muted-foreground"
                  >
                    Use a different legal name
                  </button>
                </p>
              )
            ) : null}

            <div className="mt-5">
              <Button
                onClick={() => start(namingNewEntity ? undefined : selectedEntity)}
                disabled={!canSubmit}
              >
                {pending ? "Opening Stripe…" : "Set up payouts"}
              </Button>
            </div>
          </>
        )}
      </section>

      {administeredEntities.map((entity) => (
        <EntityAdministrators
          key={entity.id}
          entityId={entity.id}
          legalName={entity.legalName}
          members={entity.members}
          pending={pending}
          run={run}
          onChanged={() => router.refresh()}
          onNotice={setNotice}
        />
      ))}

      {!context.builder.w9OnFile ? (
        <section className="border border-border bg-card p-5">
          <h2 className="text-base font-semibold">Add your W-9</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {context.builder.orgName} needs a W-9 on file to report what they pay you. Adding it
            now saves a scramble in January — it takes a minute and you only do it once.
          </p>
          <a
            href={`/s/${token}/compliance`}
            className="mt-4 inline-flex items-center border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            Upload your W-9
          </a>
        </section>
      ) : null}

      {otherBuilders.length > 0 ? (
        <section className="border border-border bg-card p-5">
          <h2 className="text-base font-semibold">Your other Arc builders</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each builder sees only their own work with you. Your verified payout account is shared.
          </p>
          <div className="mt-4 divide-y border border-border">
            {otherBuilders.map((connected) => (
              <div key={connected.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{connected.orgName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{connected.companyName}</p>
                </div>
                <span className="text-xs capitalize text-muted-foreground">
                  {connected.status.replaceAll("_", " ")}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="border border-border bg-card p-5">
        <h2 className="text-base font-semibold">On the way</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Payments a builder has already released. Arrival dates are estimates from the
          bank&apos;s normal processing window, not guarantees.
        </p>
        {context.inFlightPayments.length === 0 ? (
          <div className="mt-4 border border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Nothing on the way right now.
          </div>
        ) : (
          <>
            <div className="mt-4 overflow-x-auto border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Sent</th>
                    <th className="px-3 py-2 font-medium">Builder</th>
                    <th className="px-3 py-2 font-medium">Invoice</th>
                    <th className="px-3 py-2 font-medium">Stage</th>
                    <th className="px-3 py-2 font-medium">Expected</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {context.inFlightPayments.map((payment) => (
                    <tr key={payment.id} className="border-b border-border last:border-0">
                      <td className="whitespace-nowrap px-3 py-3 tabular-nums">{paymentDate(payment.initiatedOn)}</td>
                      <td className="px-3 py-3">{payment.orgName}</td>
                      <td className="px-3 py-3">{payment.billNumber}</td>
                      <td className="px-3 py-3">
                        <StageCell label={vendorPaymentStage({ disbursementStatus: payment.status }).label} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">
                        {payment.expectedEarliest === payment.expectedLatest
                          ? paymentDate(payment.expectedEarliest)
                          : `${paymentDate(payment.expectedEarliest)} – ${paymentDate(payment.expectedLatest)}`}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{money(payment.amountCents, payment.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {context.inFlightPaymentsTruncated ? (
              <TruncationNotice count={context.inFlightPayments.length} noun="in-flight payments" />
            ) : null}
          </>
        )}
      </section>

      <section className="border border-border bg-card p-5">
        <h2 className="text-base font-semibold">Recent payments</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Payments from every builder you are connected to, however they were sent.
        </p>
        {context.recentPayments.length === 0 ? (
          <div className="mt-4 border border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No payments recorded yet.
          </div>
        ) : (
          <>
            <div className="mt-4 overflow-x-auto border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Builder</th>
                    <th className="px-3 py-2 font-medium">Invoice</th>
                    <th className="px-3 py-2 font-medium">Stage</th>
                    <th className="px-3 py-2 font-medium">Method</th>
                    <th className="px-3 py-2 text-right font-medium">Retainage held</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {context.recentPayments.map((payment) => (
                    <tr key={payment.id} className="border-b border-border last:border-0">
                      <td className="whitespace-nowrap px-3 py-3 tabular-nums">{paymentDate(payment.paidAt)}</td>
                      <td className="px-3 py-3">{payment.orgName}</td>
                      <td className="px-3 py-3">{payment.billNumber}</td>
                      <td className="px-3 py-3">
                        <StageCell label={payment.stage} />
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">
                        {METHOD_LABELS[payment.method] ?? payment.method}
                        {payment.reference ? (
                          <span className="mt-0.5 block text-xs">{payment.reference}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                        {payment.retainageHeldCents > 0 ? money(payment.retainageHeldCents, payment.currency) : "—"}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {money(payment.amountCents, payment.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {context.recentPaymentsTruncated ? (
              <TruncationNotice count={context.recentPayments.length} noun="most recent payments" />
            ) : null}
          </>
        )}
      </section>
    </div>
  )
}

/**
 * Says out loud that the list stopped. A busy vendor silently losing their older
 * payments off the bottom of a capped table is how "you never paid me" arguments
 * start.
 */
function TruncationNotice({ count, noun }: { count: number; noun: string }) {
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      Showing the {count} {noun}. There are more than this — ask the builder for a full statement if you need one.
    </p>
  )
}

/**
 * Who may administer this vendor entity.
 *
 * This exists because the alternative is worse: without a way to add a second
 * person, the second administrator at a vendor ends up creating a duplicate Arc
 * company for the same legal business, with its own payout account. Membership
 * is the only route onto an existing company — Arc never merges two vendors
 * because their name, email domain or tax ID look alike.
 */
function EntityAdministrators({
  entityId,
  legalName,
  members,
  pending,
  run,
  onChanged,
  onNotice,
}: {
  entityId: string
  legalName: string
  members: VendorEntityMember[]
  pending: boolean
  run: <T>(
    action: () => Promise<{ success: true; data: T } | { success: false; error: string }>,
    onDone: (data: T) => void,
  ) => void
  onChanged: () => void
  onNotice: (message: string) => void
}) {
  const [email, setEmail] = useState("")
  const active = members.filter((member) => member.status === "active")
  const requests = members.filter((member) => member.status === "invited" && member.invitedByIdentityId === null)
  const invited = members.filter((member) => member.status === "invited" && member.invitedByIdentityId !== null)

  const invite = () =>
    run(
      () => inviteVendorEntityAdministratorAction({ vendor_entity_id: entityId, email: email.trim() }),
      (data) => {
        setEmail("")
        onNotice(data.message)
        onChanged()
      },
    )

  return (
    <section className="border border-border bg-card p-5">
      <h2 className="text-base font-semibold">Who can manage payouts for {legalName}</h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Administrators can connect this company to a builder and finish payout verification. Add your colleagues here
        rather than letting them set up a second Arc company for the same business.
      </p>

      {requests.length > 0 ? (
        <div className="mt-4 border border-warning/40 bg-warning/5">
          <p className="border-b border-warning/40 px-4 py-2 text-xs font-medium text-warning">
            Waiting for your decision
          </p>
          <ul className="divide-y divide-border">
            {requests.map((member) => (
              <li key={member.membershipId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{member.fullName ?? member.email}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {member.email} · asked to join
                  </span>
                </span>
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => decideVendorEntityJoinRequestAction({ membership_id: member.membershipId, approve: true }),
                        onChanged,
                      )
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => decideVendorEntityJoinRequestAction({ membership_id: member.membershipId, approve: false }),
                        onChanged,
                      )
                    }
                  >
                    Decline
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ul className="mt-4 divide-y border border-border">
        {[...active, ...invited].map((member) => (
          <li key={member.membershipId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {member.fullName ?? member.email}
                {member.isSelf ? <span className="ml-2 text-xs font-normal text-muted-foreground">You</span> : null}
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {member.email} · {ROLE_LABELS[member.role]}
                {member.status === "invited" ? " · invitation sent" : ""}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(() => removeVendorEntityMemberAction({ membership_id: member.membershipId }), onChanged)
              }
            >
              {member.isSelf ? "Leave" : member.status === "invited" ? "Cancel" : "Remove"}
            </Button>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor={`invite-${entityId}`}>Invite a colleague</Label>
          <Input
            id={`invite-${entityId}`}
            type="email"
            placeholder="name@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <Button variant="outline" onClick={invite} disabled={pending || email.trim().length === 0}>
          {pending ? "Sending…" : "Send invitation"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        They need their own Arc login first. If they do not have one, ask your builder to send them a payment
        invitation, then invite them here.
      </p>
    </section>
  )
}
