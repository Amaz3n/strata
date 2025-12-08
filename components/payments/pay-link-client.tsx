"use client"

import { useEffect, useMemo, useState } from "react"
import { format } from "date-fns"
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js"
import { loadStripe } from "@stripe/stripe-js"

import type { Invoice } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

interface PayLinkClientProps {
  token: string
  invoice: Invoice
  publishableKey: string
  clientSecret: string
}

function formatMoney(cents?: number | null, currency = "USD") {
  const value = (cents ?? 0) / 100
  return value.toLocaleString("en-US", { style: "currency", currency })
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
        return_url: `${window.location.origin}/p/pay/${token}?status=success`,
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
    <div className="min-h-screen bg-gradient-to-b from-background to-muted px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Invoice Payment</p>
          <h1 className="text-2xl font-bold">{invoice.title}</h1>
          <p className="text-sm text-muted-foreground">Invoice #{invoice.invoice_number}</p>
          {invoice.due_date && (
            <p className="text-sm text-muted-foreground">
              Due {format(new Date(invoice.due_date), "MMM d, yyyy")}
            </p>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Balance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="font-semibold">{formatMoney(totalCents)}</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Balance due</span>
              <span className="text-lg font-bold">{formatMoney(balanceCents)}</span>
            </div>
          </CardContent>
        </Card>

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
      </div>
    </div>
  )
}

export function PayLinkClient({ token, invoice, publishableKey, clientSecret }: PayLinkClientProps) {
  const stripePromise = useMemo(() => loadStripe(publishableKey), [publishableKey])

  if (!clientSecret) {
    return <div className="p-4 text-sm text-red-600">Unable to start payment: missing client secret.</div>
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
