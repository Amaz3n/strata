"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js"
import { loadStripe, type Appearance } from "@stripe/stripe-js"
import { format } from "date-fns"
import { CheckCircle2, ChevronDown, Download, Link2, Loader2, Lock } from "lucide-react"

import type { Invoice, Receipt } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

interface Props {
  invoice: Invoice
  portalType?: "client" | "sub"
  payment?: {
    clientSecret: string
    publishableKey: string
    token: string
  } | null
  receipts?: Receipt[] | null
}

function formatMoneyFromCents(cents?: number | null) {
  const value = cents ?? 0
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

// Stripe appearance customization to match app design
function getStripeAppearance(isDark: boolean): Appearance {
  return {
    theme: isDark ? "night" : "stripe",
    variables: {
      colorPrimary: isDark ? "#7c93c4" : "#5a6fa8",
      colorBackground: isDark ? "#1a1d24" : "#ffffff",
      colorText: isDark ? "#e8e9eb" : "#1a1d24",
      colorTextSecondary: isDark ? "#8b8f96" : "#6b7280",
      colorDanger: "#dc2626",
      fontFamily: '"Geist", system-ui, sans-serif',
      fontSizeBase: "14px",
      spacingUnit: "4px",
      borderRadius: "0px",
      focusBoxShadow: "none",
      focusOutline: isDark ? "2px solid #7c93c4" : "2px solid #5a6fa8",
    },
    rules: {
      ".Input": {
        border: isDark ? "1px solid #2d3139" : "1px solid #e5e7eb",
        boxShadow: "none",
        padding: "12px",
        transition: "border-color 0.15s ease",
      },
      ".Input:focus": {
        border: isDark ? "1px solid #7c93c4" : "1px solid #5a6fa8",
        boxShadow: "none",
      },
      ".Input:hover": {
        border: isDark ? "1px solid #3d4149" : "1px solid #d1d5db",
      },
      ".Input--invalid": {
        border: "1px solid #dc2626",
      },
      ".Label": {
        fontWeight: "500",
        fontSize: "13px",
        marginBottom: "6px",
        color: isDark ? "#a1a5ad" : "#4b5563",
      },
      ".Tab": {
        border: isDark ? "1px solid #2d3139" : "1px solid #e5e7eb",
        borderRadius: "0px",
        boxShadow: "none",
      },
      ".Tab:hover": {
        border: isDark ? "1px solid #3d4149" : "1px solid #d1d5db",
      },
      ".Tab--selected": {
        border: isDark ? "1px solid #7c93c4" : "1px solid #5a6fa8",
        backgroundColor: isDark ? "#1f2229" : "#f9fafb",
      },
      ".TabIcon": {
        fill: isDark ? "#a1a5ad" : "#6b7280",
      },
      ".TabIcon--selected": {
        fill: isDark ? "#7c93c4" : "#5a6fa8",
      },
      ".Block": {
        border: isDark ? "1px solid #2d3139" : "1px solid #e5e7eb",
        borderRadius: "0px",
        boxShadow: "none",
      },
      ".CheckboxInput": {
        borderRadius: "0px",
      },
      ".CheckboxInput--checked": {
        backgroundColor: isDark ? "#7c93c4" : "#5a6fa8",
      },
    },
  }
}

function PaymentForm({
  invoice,
  token,
  isDark,
}: {
  invoice: Invoice
  token: string
  isDark: boolean
}) {
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
      setMessage("Payment submitted successfully.")
    } else {
      setMessage(`Payment status: ${paymentIntent?.status ?? "unknown"}`)
    }
  }

  return (
    <div className="space-y-6">
      <PaymentElement
        options={{
          layout: "tabs",
          business: { name: "Strata" },
        }}
      />

      {message && (
        <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 p-3">
          <CheckCircle2 className="size-4 shrink-0" />
          <span>{message}</span>
        </div>
      )}
      {error && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-3">
          {error}
        </div>
      )}

      <Button
        className="w-full h-11"
        disabled={isSubmitting || isPaid || !stripe}
        onClick={handleSubmit}
      >
        {isPaid ? (
          "Already paid"
        ) : isSubmitting ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Processing...
          </>
        ) : (
          `Pay ${formatMoneyFromCents(balanceCents)}`
        )}
      </Button>

      <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="size-3" />
        <span>Secured by Stripe. We never store your payment details.</span>
      </div>
    </div>
  )
}

function PaymentSection({
  invoice,
  payment,
}: {
  invoice: Invoice
  payment: {
    clientSecret: string
    publishableKey: string
    token: string
  }
}) {
  const [isDark, setIsDark] = useState(false)

  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsDark(document.documentElement.classList.contains("dark"))
      const observer = new MutationObserver(() => {
        setIsDark(document.documentElement.classList.contains("dark"))
      })
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
      return () => observer.disconnect()
    }
  }, [])

  const stripePromise = useMemo(() => loadStripe(payment.publishableKey), [payment.publishableKey])
  const appearance = useMemo(() => getStripeAppearance(isDark), [isDark])

  const totalCents = invoice.totals?.total_cents ?? invoice.total_cents ?? 0
  const balanceCents = invoice.totals?.balance_due_cents ?? invoice.balance_due_cents ?? totalCents

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret: payment.clientSecret,
        appearance,
      }}
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Pay invoice</h3>
            <p className="text-sm text-muted-foreground">Select a payment method</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Amount due</p>
            <p className="text-xl font-semibold">{formatMoneyFromCents(balanceCents)}</p>
          </div>
        </div>

        <Separator />

        <PaymentForm invoice={invoice} token={payment.token} isDark={isDark} />
      </div>
    </Elements>
  )
}

export function InvoicePortalClient({ invoice, portalType = "client", payment, receipts }: Props) {
  const [copied, setCopied] = useState(false)
  const paymentRef = useRef<HTMLDivElement>(null)

  const subtotal = invoice.totals?.subtotal_cents ?? invoice.subtotal_cents ?? 0
  const tax = invoice.totals?.tax_cents ?? invoice.tax_cents ?? 0
  const total = invoice.totals?.total_cents ?? invoice.total_cents ?? subtotal + tax
  const balanceDue = invoice.totals?.balance_due_cents ?? invoice.balance_due_cents ?? total
  const isPaid = balanceDue <= 0 || invoice.status === "paid" || invoice.status === "void"
  const receiptList = receipts ?? []

  // Match container width (600px content + 48px padding)
  const containerMaxWidth = 648

  const fallbackShareUrl = `${process.env.NEXT_PUBLIC_APP_URL || "https://app.strata.build"}/i/${invoice.token}`
  const [shareUrl, setShareUrl] = useState(fallbackShareUrl)

  useEffect(() => {
    if (typeof window === "undefined") return
    setShareUrl(window.location.href)
  }, [])

  const handleCopyLink = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && shareUrl) {
        await navigator.clipboard.writeText(shareUrl)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    } catch (err) {
      console.error("Failed to copy link", err)
    }
  }

  const handleDownload = () => {
    if (typeof window !== "undefined") {
      window.print()
    }
  }

  const scrollToPayment = () => {
    paymentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="invoice-grid-bg min-h-screen pb-24">
      {/* Sticky Pay Now Banner (only if not paid) */}
      {!isPaid && payment && (
        <div className="sticky top-0 z-40 border-b bg-primary text-primary-foreground print:hidden">
          <div className="mx-auto px-4 py-3 sm:px-6" style={{ maxWidth: containerMaxWidth }}>
            <button
              onClick={scrollToPayment}
              className="w-full flex items-center justify-between gap-4 text-left"
            >
              <div>
                <p className="font-semibold">Pay this invoice</p>
                <p className="text-sm opacity-90">
                  {formatMoneyFromCents(balanceDue)} due
                </p>
              </div>
              <div className="flex items-center gap-2 text-sm font-medium">
                <span>Pay now</span>
                <ChevronDown className="size-4" />
              </div>
            </button>
          </div>
        </div>
      )}

      <div className="mx-auto px-4 py-8 sm:px-6" style={{ maxWidth: containerMaxWidth }}>
        {/* Header */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Invoice
            </p>
            <h1 className="text-xl font-semibold">{invoice.title}</h1>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant={isPaid ? "default" : "secondary"}
              className={`capitalize ${isPaid ? "bg-green-600 hover:bg-green-600" : ""}`}
            >
              {isPaid ? "Paid" : invoice.status}
            </Badge>
            {invoice.due_date && (
              <Badge variant="outline">Due {format(new Date(invoice.due_date), "MMM d, yyyy")}</Badge>
            )}
          </div>
        </div>

        {/* Invoice Details */}
        <div className="border bg-card">
          <div className="border-b p-6">
            <h2 className="text-sm font-medium text-muted-foreground mb-4">Details</h2>
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Invoice #</dt>
                <dd className="font-medium">{invoice.invoice_number}</dd>
              </div>
              {invoice.issue_date && (
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Issued</dt>
                  <dd>{format(new Date(invoice.issue_date), "MMM d, yyyy")}</dd>
                </div>
              )}
              {invoice.due_date && (
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Due</dt>
                  <dd>{format(new Date(invoice.due_date), "MMM d, yyyy")}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* Line Items */}
          <div className="border-b p-6">
            <h2 className="text-sm font-medium text-muted-foreground mb-4">Line items</h2>
            <div className="space-y-3">
              {invoice.lines && invoice.lines.length > 0 ? (
                invoice.lines.map((line, idx) => (
                  <div key={idx} className="flex items-start justify-between gap-4 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{line.description}</p>
                      <p className="text-xs text-muted-foreground">
                        Qty {line.quantity} {line.unit ? line.unit : ""}
                        {line.taxable === false ? " · Non-taxable" : ""}
                      </p>
                    </div>
                    <p className="text-sm font-medium shrink-0">
                      {formatMoneyFromCents(line.unit_cost_cents)}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No line items.</p>
              )}
            </div>
          </div>

          {/* Totals */}
          <div className="p-6">
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatMoneyFromCents(subtotal)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Tax</span>
                <span>{formatMoneyFromCents(tax)}</span>
              </div>
              <Separator className="my-3" />
              <div className="flex items-center justify-between text-base">
                <span className="font-medium">Total</span>
                <span className="font-semibold">{formatMoneyFromCents(total)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Balance due</span>
                <span className="text-lg font-bold">{formatMoneyFromCents(balanceDue)}</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          {invoice.notes && (
            <div className="border-t p-6">
              <h2 className="text-sm font-medium text-muted-foreground mb-2">Notes</h2>
              <p className="whitespace-pre-line text-sm">{invoice.notes}</p>
            </div>
          )}
        </div>

        {/* Receipt Download (if paid) */}
        {isPaid && receiptList.length > 0 && (
          <div className="mt-6 border bg-green-50 dark:bg-green-950/20 p-6">
            <div className="flex items-start gap-4">
              <div className="flex size-10 items-center justify-center bg-green-100 dark:bg-green-900/40">
                <CheckCircle2 className="size-5 text-green-600 dark:text-green-400" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-green-900 dark:text-green-100">
                  Payment received
                </h3>
                <p className="mt-1 text-sm text-green-700 dark:text-green-300">
                  Thank you for your payment. Download your receipt below.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {receiptList.map((receipt) => (
                    <Button key={receipt.id} variant="outline" size="sm" asChild>
                      <a
                        href={`/i/${invoice.token}/receipt/${receipt.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Download className="size-4" />
                        Download receipt
                      </a>
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Payment Section (if not paid) */}
        {!isPaid && (
          <div ref={paymentRef} className="mt-8 scroll-mt-20 border bg-card p-6 sm:p-8">
            {payment ? (
              <PaymentSection invoice={invoice} payment={payment} />
            ) : (
              <div className="text-center py-8">
                <Lock className="mx-auto size-8 text-muted-foreground" />
                <h3 className="mt-4 font-semibold">Online payments unavailable</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Please contact the sender for payment instructions.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Bottom Toolbar */}
        <div className="fixed inset-x-0 bottom-6 flex justify-center pointer-events-none print:hidden">
          <div className="pointer-events-auto flex items-center gap-1 border bg-background/95 backdrop-blur-sm px-2 py-1.5 shadow-lg">
            <Button variant="ghost" size="sm" onClick={handleDownload}>
              <Download className="size-4" />
              Download
            </Button>
            <Separator orientation="vertical" className="h-5" />
            <Button variant="ghost" size="sm" onClick={handleCopyLink}>
              <Link2 className="size-4" />
              {copied ? "Copied!" : "Copy link"}
            </Button>
          </div>
        </div>
      </div>

      <style jsx global>{`
        .invoice-grid-bg {
          background-color: var(--background);
          background-image: radial-gradient(
            circle at 1px 1px,
            rgba(0, 0, 0, 0.04) 1px,
            transparent 0
          );
          background-size: 24px 24px;
        }
        .dark .invoice-grid-bg {
          background-color: var(--background);
          background-image: radial-gradient(
            circle at 1px 1px,
            rgba(255, 255, 255, 0.06) 1px,
            transparent 0
          );
        }
        @media print {
          .invoice-grid-bg {
            background-image: none;
          }
        }
      `}</style>
    </div>
  )
}
