"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js"
import { loadStripe, type Appearance } from "@stripe/stripe-js"
import { Building2, CheckCircle2, CreditCard, Download, Link2, Loader2, Lock } from "lucide-react"

import type { Invoice } from "@/lib/types"
import type { Receipt } from "@/lib/types"
import {
  ArcInvoiceDocument,
  toArcInvoiceData,
  toArcInvoiceLines,
  type ArcInvoiceBranding,
} from "@/components/invoices/arc-invoice-document"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { createPublicInvoicePaymentIntentAction } from "@/app/i/[token]/actions"

type PaymentProps = {
  publishableKey: string
  token: string
  feeQuotes: {
    ach: PaymentFeeQuote
    card: PaymentFeeQuote
  }
}

type PaymentFeeQuote = {
  method: "ach" | "card"
  enabled: boolean
  invoiceBalanceCents: number
  feeCents: number
  totalCents: number
  feePercent: number
  feeFixedCents: number
  feeCapCents: number | null
  label: string
  disclosure: string
}

interface Props {
  invoice: Invoice
  payment?: PaymentProps | null
  receipts?: Receipt[] | null
  branding?: ArcInvoiceBranding | null
}

function formatMoney(cents?: number | null, currency = "USD") {
  const value = (cents ?? 0) / 100
  return value.toLocaleString("en-US", { style: "currency", currency })
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

function ConfirmPaymentForm({
  quote,
  token,
}: {
  quote: PaymentFeeQuote
  token: string
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async () => {
    setError(null)
    setMessage(null)
    if (!stripe || !elements) {
      setError("Payment form not ready yet.")
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
      setMessage(paymentIntent.status === "processing" ? "Payment is processing. This page will refresh shortly." : "Payment submitted successfully. This page will refresh shortly.")
      window.setTimeout(() => window.location.reload(), 2500)
    } else {
      setMessage(`Payment status: ${paymentIntent?.status ?? "unknown"}`)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2 border bg-muted/30 p-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Invoice balance</span>
          <span>{formatMoney(quote.invoiceBalanceCents)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{quote.label} processing fee</span>
          <span>{formatMoney(quote.feeCents)}</span>
        </div>
        <Separator />
        <div className="flex items-center justify-between font-semibold">
          <span>Total charged</span>
          <span>{formatMoney(quote.totalCents)}</span>
        </div>
      </div>

      <PaymentElement
        options={{
          layout: "tabs",
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
        disabled={isSubmitting || !stripe}
        onClick={handleSubmit}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Processing...
          </>
        ) : (
          `Pay ${formatMoney(quote.totalCents)}`
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
  payment: PaymentProps
}) {
  const [isDark, setIsDark] = useState(false)
  const [selectedQuote, setSelectedQuote] = useState<PaymentFeeQuote | null>(null)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [stripeAccountId, setStripeAccountId] = useState<string | null>(null)
  const [isCreatingIntent, setIsCreatingIntent] = useState(false)
  const [intentError, setIntentError] = useState<string | null>(null)
  const [unavailableMethods, setUnavailableMethods] = useState<Array<PaymentFeeQuote["method"]>>([])

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

  const stripePromise = useMemo(
    () => loadStripe(payment.publishableKey, stripeAccountId ? { stripeAccount: stripeAccountId } : undefined),
    [payment.publishableKey, stripeAccountId],
  )
  const appearance = useMemo(() => getStripeAppearance(isDark), [isDark])

  const totalCents = invoice.totals?.total_cents ?? invoice.total_cents ?? 0
  const balanceCents = invoice.totals?.balance_due_cents ?? invoice.balance_due_cents ?? totalCents
  const isPaid = balanceCents <= 0 || invoice.status === "paid" || invoice.status === "void"
  const availableQuotes = useMemo(
    () => [payment.feeQuotes.ach, payment.feeQuotes.card].filter((quote) => quote.enabled),
    [payment.feeQuotes.ach, payment.feeQuotes.card],
  )

  async function handleMethodSelect(quote: PaymentFeeQuote) {
    if (!quote.enabled || isPaid || isCreatingIntent || unavailableMethods.includes(quote.method)) return
    setSelectedQuote(quote)
    setClientSecret(null)
    setStripeAccountId(null)
    setIntentError(null)
    setIsCreatingIntent(true)
    try {
      const intent = await createPublicInvoicePaymentIntentAction({
        token: payment.token,
        method: quote.method,
      })
      if (!intent.client_secret) {
        throw new Error("Stripe did not return a payment form secret.")
      }
      setClientSecret(intent.client_secret)
      setStripeAccountId(intent.connected_account_id ?? null)
    } catch (err) {
      setUnavailableMethods((current) => (current.includes(quote.method) ? current : [...current, quote.method]))
      setIntentError(
        err instanceof Error
          ? err.message
          : `${quote.label} is unavailable. Try another payment method or contact the sender.`,
      )
    } finally {
      setIsCreatingIntent(false)
    }
  }

  function renderMethodButton(quote: PaymentFeeQuote) {
    const isSelected = selectedQuote?.method === quote.method
    const unavailable = unavailableMethods.includes(quote.method)
    const disabled = !quote.enabled || unavailable || isPaid || isCreatingIntent
    const Icon = quote.method === "ach" ? Building2 : CreditCard
    return (
      <button
        type="button"
        key={quote.method}
        disabled={disabled}
        onClick={() => handleMethodSelect(quote)}
        className={[
          "group w-full border p-4 text-left transition-all",
          isSelected ? "border-primary bg-primary/[0.04] ring-1 ring-primary" : "bg-background hover:border-foreground/25 hover:bg-muted/40",
          disabled ? "cursor-not-allowed opacity-60" : "",
        ].join(" ")}
      >
        <div className="flex items-center gap-3">
          <div
            className={[
              "flex size-10 shrink-0 items-center justify-center border transition-colors",
              isSelected ? "border-primary bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground group-hover:text-foreground",
            ].join(" ")}
          >
            <Icon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium leading-tight">{quote.label}</p>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {unavailable ? "Unavailable for this builder's Stripe account." : quote.disclosure}
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-dashed pt-3 text-sm">
          <span className="text-muted-foreground">
            Total {quote.feeCents > 0 ? `incl. ${formatMoney(quote.feeCents)} fee` : "— no fee"}
          </span>
          <span className="font-semibold tabular-nums">{formatMoney(quote.totalCents)}</span>
        </div>
      </button>
    )
  }

  return (
    <div className="space-y-5">
      <h3 className="text-sm font-semibold">Payment method</h3>

      {availableQuotes.length > 0 ? (
        <div className="grid gap-2.5">{availableQuotes.map(renderMethodButton)}</div>
      ) : (
        <div className="border bg-muted/30 p-4 text-sm text-muted-foreground">
          Online payments are not enabled for this invoice. Please contact the sender for payment instructions.
        </div>
      )}

      {isCreatingIntent && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Preparing secure payment form...
        </div>
      )}
      {intentError && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-3">
          {intentError}
        </div>
      )}

      {selectedQuote && clientSecret ? (
        <Elements
          key={clientSecret}
          stripe={stripePromise}
          options={{
            clientSecret,
            appearance,
          }}
        >
          <ConfirmPaymentForm quote={selectedQuote} token={payment.token} />
        </Elements>
      ) : null}
    </div>
  )
}

export function InvoicePublicWithPay({ invoice, payment, receipts, branding }: Props) {
  const [copied, setCopied] = useState(false)
  const [containerWidth, setContainerWidth] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const arcData = useMemo(() => toArcInvoiceData(invoice, branding), [invoice, branding])
  const arcLines = useMemo(() => toArcInvoiceLines(invoice), [invoice])
  const customerName = invoice.customer_name ?? (invoice.metadata as any)?.customer_name ?? "Customer"
  const invoiceToken = payment?.token ?? invoice.token ?? null
  const receiptList = receipts ?? []
  const fallbackShareUrl = `${process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"}/i/${invoice.token}`
  const [shareUrl, setShareUrl] = useState(fallbackShareUrl)

  const totalCents = invoice.totals?.total_cents ?? invoice.total_cents ?? 0
  const balanceCents = invoice.totals?.balance_due_cents ?? invoice.balance_due_cents ?? totalCents
  const isPaid = balanceCents <= 0 || invoice.status === "paid" || invoice.status === "void"

  // Fixed dimensions for invoice - letter size
  const invoiceWidth = 750
  const invoiceHeight = 1056
  // Wide enough for the invoice (750) + gap + a roomy sticky pay panel beside it.
  const containerMaxWidth = 1340

  // Measure container and calculate scale for mobile
  useEffect(() => {
    const measure = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth)
      }
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [])

  // Scale invoice to fit container on mobile
  const scale = containerWidth > 0 && containerWidth < invoiceWidth
    ? containerWidth / invoiceWidth
    : 1
  const scaledHeight = invoiceHeight * scale

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
    if (typeof window !== "undefined" && invoiceToken) {
      // Download the canonical Arc PDF (same template as the composer export / emailed copy).
      window.location.href = `/i/${invoiceToken}/pdf`
    }
  }

  const dueLabel = arcData.dueDate
    ? new Date(arcData.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null

  return (
    <div className="invoice-grid-bg min-h-screen pb-16">
      {/* Slim neutral bar — branding lives in the document below */}
      <div className="border-b bg-background/80 backdrop-blur-sm print:hidden">
        <div className="mx-auto flex items-center justify-between gap-3 px-3 py-2.5 sm:px-5 lg:px-6" style={{ maxWidth: containerMaxWidth }}>
          <div className="flex items-center gap-2.5 text-sm">
            <span className="font-medium">Invoice {arcData.invoiceNumber}</span>
            <Badge
              variant={isPaid ? "default" : "secondary"}
              className={`capitalize ${isPaid ? "bg-green-600 hover:bg-green-600" : ""}`}
            >
              {isPaid ? "Paid" : invoice.status}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">
            Powered by <span className="font-medium text-foreground/80">Arc</span>
          </span>
        </div>
      </div>

      <div className="mx-auto px-3 py-6 sm:px-5 sm:py-8 lg:px-6" style={{ maxWidth: containerMaxWidth }}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-7">
          {/* Invoice document — scales to fit its column */}
          <div ref={containerRef} className="order-2 w-full lg:order-1 lg:w-[750px] lg:flex-none">
            <div className="overflow-hidden" style={{ height: scale < 1 ? scaledHeight : invoiceHeight }}>
              <div
                className="border shadow-lg origin-top-left"
                style={{
                  width: invoiceWidth,
                  height: invoiceHeight,
                  transform: scale < 1 ? `scale(${scale})` : undefined,
                }}
              >
                <ArcInvoiceDocument data={arcData} lines={arcLines} width={invoiceWidth} height={invoiceHeight} />
              </div>
            </div>
          </div>

          {/* Payment panel — sticky on desktop, on top on mobile */}
          <aside className="order-1 w-full lg:order-2 lg:flex-1 lg:max-w-[480px] lg:sticky lg:top-6 print:hidden">
            <div className="border bg-card shadow-lg">
              {/* Amount header */}
              <div className="border-b bg-muted/30 p-6">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {isPaid ? "Amount paid" : "Balance due"}
                  </p>
                  {!isPaid && dueLabel ? (
                    <p className="text-xs text-muted-foreground">
                      Due <span className="font-medium text-foreground/80">{dueLabel}</span>
                    </p>
                  ) : null}
                </div>
                <p className="mt-1.5 text-[2rem] font-semibold leading-none tracking-tight tabular-nums">
                  {formatMoney(isPaid ? totalCents : balanceCents)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Invoice {arcData.invoiceNumber} · {customerName}
                </p>
              </div>

              {/* State-specific body */}
              <div className="p-6">
                {isPaid ? (
                  <div className="space-y-4">
                    <div className="flex items-start gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center bg-green-100 dark:bg-green-900/40">
                        <CheckCircle2 className="size-5 text-green-600 dark:text-green-400" />
                      </div>
                      <div>
                        <h3 className="font-semibold">Payment received</h3>
                        <p className="mt-0.5 text-sm text-muted-foreground">Thank you for your payment.</p>
                      </div>
                    </div>
                    {receiptList.length > 0 && (
                      <div className="flex flex-col gap-2">
                        {receiptList.map((receipt) => (
                          <Button key={receipt.id} variant="outline" size="sm" className="w-full justify-start" asChild>
                            <a href={`/i/${invoiceToken}/receipt/${receipt.id}`} target="_blank" rel="noreferrer">
                              <Download className="size-4" />
                              Download receipt
                            </a>
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : payment ? (
                  <PaymentSection invoice={invoice} payment={payment} />
                ) : (
                  <div className="py-6 text-center">
                    <Lock className="mx-auto size-7 text-muted-foreground" />
                    <h3 className="mt-3 font-semibold">Online payments unavailable</h3>
                    <p className="mt-1 text-sm text-muted-foreground">Please contact the sender for payment instructions.</p>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 border-t p-2.5">
                <Button variant="ghost" size="sm" className="flex-1" onClick={handleDownload}>
                  <Download className="size-4" />
                  Download PDF
                </Button>
                <Separator orientation="vertical" className="h-5" />
                <Button variant="ghost" size="sm" className="flex-1" onClick={handleCopyLink}>
                  <Link2 className="size-4" />
                  {copied ? "Copied!" : "Copy link"}
                </Button>
              </div>
            </div>

            <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3" />
              Secured by Stripe
            </p>
          </aside>
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
