"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { SuccessCheck } from "@/components/portal/success-check"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { VendorPaymentSetupContext } from "@/lib/services/vendor-payment-identities"
import { startVendorPayoutSetupAction } from "./actions"

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
  other: "Other",
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
  const otherBuilders = context.relationships.filter((candidate) => candidate.orgId !== builder.orgId)
  /**
   * A payout account this vendor already verified with another builder. It
   * belongs to their legal entity, not to any builder, so connecting it here is
   * a confirmation rather than a second round of Stripe onboarding.
   */
  const verifiedEntity =
    context.entities.find((candidate) => candidate.recipient?.status === "ready" && candidate.recipient.payoutsEnabled) ?? null

  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [selectedEntity, setSelectedEntity] = useState(context.entities[0]?.id ?? NEW_ENTITY)
  const [editingName, setEditingName] = useState(false)
  const [choosingEntity, setChoosingEntity] = useState(false)
  const [legalName, setLegalName] = useState(builder.companyName)
  const [dbaName, setDbaName] = useState("")

  const namingNewEntity = context.entities.length === 0 || selectedEntity === NEW_ENTITY
  const canSubmit = !pending && (!namingNewEntity || legalName.trim().length > 0)

  const start = (vendorEntityId?: string) => {
    setError(null)
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

  return (
    <div className="space-y-6">
      {error ? (
        <div role="alert" className="border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
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
              <Button onClick={() => start(verifiedEntity.id)} disabled={pending}>
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
        ) : linkedEntity ? (
          <>
            <h2 className="text-base font-semibold">Finish verifying {linkedEntity.legalName}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Stripe still needs information before {builder.orgName} can pay you electronically. You can leave and come
              back — your progress is saved.
            </p>
            <div className="mt-5">
              <Button onClick={() => start(linkedEntity.id)} disabled={pending}>
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
        <h2 className="text-base font-semibold">Recent payments</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Up to 100 recent payments across every builder you are connected to, however they were sent.
        </p>
        {context.recentPayments.length === 0 ? (
          <div className="mt-4 border border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No payments recorded yet.
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Builder</th>
                  <th className="px-3 py-2 font-medium">Invoice</th>
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
        )}
      </section>
    </div>
  )
}
