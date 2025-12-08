"use client"

import { useMemo, useState } from "react"
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js"
import { loadStripe } from "@stripe/stripe-js"
import { format } from "date-fns"

import type { Invoice } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

interface Props {
  invoice: Invoice
  portalType?: "client" | "sub"
  payment?: {
    clientSecret: string
    publishableKey: string
    token: string
  } | null
}

function formatMoneyFromCents(cents?: number | null) {
  const value = cents ?? 0
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function PaymentPanel({
  invoice,
  clientSecret,
  publishableKey,
  token,
}: {
  invoice: Invoice
  clientSecret: string
  publishableKey: string
  token: string
}) {
  const stripePromise = useMemo(() => loadStripe(publishableKey), [publishableKey])

  if (!clientSecret) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pay securely</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Payment unavailable for this invoice.</CardContent>
      </Card>
    )
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        appearance: { theme: "stripe" },
      }}
    >
      <PaymentForm invoice={invoice} token={token} />
    </Elements>
  )
}

function PaymentForm({ invoice, token }: { invoice: Invoice; token: string }) {
  const stripe = useStripe()
  const elements = useElements()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const totalCents = invoice.totals?.total_cents ?? invoice.total_cents ?? 0
  const balanceCents = invoice.totals?.balance_due_cents ?? invoice.balance_due_cents ?? totalCents
  const isPaid = balanceCents <= 0 || invoice.status === "paid" || invoice.status === "void"

  const handleSubmit = async () => {
    setError(null)
    setMessage(null)
    if (!stripe || !elements) {
      setError("Payment form not ready yet.")
      return
    }
    if (isPaid) {
      setMessage("This invoice is already paid.")
      return
    }
    setIsSubmitting(true)
    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/p/${token}/invoices/${invoice.id}?status=success`,
      },
      redirect: "if_required",
    })
    setIsSubmitting(false)

    if (stripeError) {
      setError(stripeError.message ?? "Payment failed.")
      return
    }
    if (paymentIntent?.status === "succeeded" || paymentIntent?.status === "processing") {
      setMessage("Payment submitted. We will refresh once the payment is confirmed.")
    } else {
      setMessage(`Payment status: ${paymentIntent?.status ?? "unknown"}`)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pay securely</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <PaymentElement />
        {message && <p className="text-sm text-green-700">{message}</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button className="w-full" disabled={isSubmitting || isPaid || !stripe} onClick={handleSubmit}>
          {isPaid ? "Already paid" : isSubmitting ? "Processing..." : "Pay now"}
        </Button>
        <p className="text-xs text-muted-foreground">
          ACH-first checkout. Your payment is processed by Stripe; we do not store your bank details.
        </p>
      </CardContent>
    </Card>
  )
}

export function InvoicePortalClient({ invoice, portalType = "client", payment }: Props) {
  const subtotal = invoice.totals?.subtotal_cents ?? invoice.subtotal_cents ?? 0
  const tax = invoice.totals?.tax_cents ?? invoice.tax_cents ?? 0
  const total = invoice.totals?.total_cents ?? invoice.total_cents ?? subtotal + tax
  const balanceDue = invoice.totals?.balance_due_cents ?? invoice.balance_due_cents ?? total

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted px-4 py-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 lg:flex-row">
        <div className="flex-1 space-y-4">
          <div className="text-center space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Invoice</p>
            <h1 className="text-2xl font-bold">{invoice.title}</h1>
            <div className="flex justify-center gap-2 flex-wrap">
              <Badge variant="secondary" className="capitalize">
                {invoice.status}
              </Badge>
              {invoice.due_date && (
                <Badge variant="outline">Due {format(new Date(invoice.due_date), "MMM d, yyyy")}</Badge>
              )}
              <Badge variant="outline" className="capitalize">
                {portalType}
              </Badge>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>Invoice #</span>
                <span className="font-semibold text-foreground">{invoice.invoice_number}</span>
              </div>
              {invoice.issue_date && (
                <div className="flex items-center justify-between">
                  <span>Issued</span>
                  <span>{format(new Date(invoice.issue_date), "MMM d, yyyy")}</span>
                </div>
              )}
              {invoice.due_date && (
                <div className="flex items-center justify-between">
                  <span>Due</span>
                  <span>{format(new Date(invoice.due_date), "MMM d, yyyy")}</span>
                </div>
              )}
              {invoice.notes && <p className="mt-2 whitespace-pre-line">{invoice.notes}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Line items</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {invoice.lines && invoice.lines.length > 0 ? (
                invoice.lines.map((line, idx) => (
                  <div key={idx} className="rounded-lg border bg-muted/30 p-3 space-y-1">
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-sm">{line.description}</p>
                      <p className="text-sm">{formatMoneyFromCents(line.unit_cost_cents)}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Qty {line.quantity} {line.unit ? line.unit : ""}
                      {line.taxable === false ? " • Non-taxable" : ""}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No line items.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Totals</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="font-semibold">{formatMoneyFromCents(subtotal)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Tax</span>
                <span className="font-semibold">{formatMoneyFromCents(tax)}</span>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Total</span>
                <span className="text-lg font-bold">{formatMoneyFromCents(total)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Balance due</span>
                <span className="text-base font-semibold">{formatMoneyFromCents(balanceDue)}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="w-full lg:w-[360px] space-y-4">
          {payment ? (
            <PaymentPanel
              invoice={invoice}
              clientSecret={payment.clientSecret}
              publishableKey={payment.publishableKey}
              token={payment.token}
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Pay securely</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Payments are unavailable for this invoice.
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

