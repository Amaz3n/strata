"use client"

import { useMemo, useState } from "react"
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js"
import { loadStripe } from "@stripe/stripe-js"

import type { Invoice } from "@/lib/types"
import { InvoicePublicMiddayView } from "@/components/invoices/invoice-public-midday"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

type PaymentProps = {
  clientSecret: string
  publishableKey: string
  token: string
}

interface Props {
  invoice: Invoice
  payment?: PaymentProps | null
}

function formatMoney(cents?: number | null, currency = "USD") {
  const value = (cents ?? 0) / 100
  return value.toLocaleString("en-US", { style: "currency", currency })
}

function PaymentPanel({ invoice, payment }: { invoice: Invoice; payment: PaymentProps }) {
  const stripePromise = useMemo(() => loadStripe(payment.publishableKey), [payment.publishableKey])

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret: payment.clientSecret,
        appearance: { theme: "stripe" },
      }}
    >
      <PaymentForm invoice={invoice} token={payment.token} />
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
        return_url: `${window.location.origin}/i/${token}?status=success`,
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
        <div className="space-y-1 text-sm text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>Amount due</span>
            <span className="font-semibold text-foreground">{formatMoney(balanceCents)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Total</span>
            <span>{formatMoney(totalCents)}</span>
          </div>
        </div>
        <Separator />
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

export function InvoicePublicWithPay({ invoice, payment }: Props) {
  return (
    <div className="w-full flex flex-col lg:flex-row gap-6">
      <div className="flex-1">
        <InvoicePublicMiddayView invoice={invoice} />
      </div>
      <div className="w-full lg:w-[380px] space-y-4">
        {payment ? (
          <PaymentPanel invoice={invoice} payment={payment} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pay securely</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Payments are unavailable. Add Stripe keys and refresh to enable.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

