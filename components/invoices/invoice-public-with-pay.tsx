"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js"
import { loadStripe, type Appearance } from "@stripe/stripe-js"
import { CheckCircle2, ChevronDown, Download, Link2, Loader2, Lock } from "lucide-react"

import type { Invoice } from "@/lib/types"
import type { Invoice as MiddayInvoice, LineItem, Template } from "@/packages/invoice/src/types"
import type { Receipt } from "@/lib/types"
import { HtmlTemplate } from "@/packages/invoice/src/templates/html"
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
      setMessage("Payment submitted successfully.")
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
  const [isCreatingIntent, setIsCreatingIntent] = useState(false)
  const [intentError, setIntentError] = useState<string | null>(null)

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
  const isPaid = balanceCents <= 0 || invoice.status === "paid" || invoice.status === "void"

  async function handleMethodSelect(quote: PaymentFeeQuote) {
    if (!quote.enabled || isPaid || isCreatingIntent) return
    setSelectedQuote(quote)
    setClientSecret(null)
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
    } catch (err) {
      setIntentError(err instanceof Error ? err.message : "Unable to start payment.")
    } finally {
      setIsCreatingIntent(false)
    }
  }

  function renderMethodButton(quote: PaymentFeeQuote) {
    const isSelected = selectedQuote?.method === quote.method
    return (
      <button
        type="button"
        key={quote.method}
        disabled={!quote.enabled || isPaid || isCreatingIntent}
        onClick={() => handleMethodSelect(quote)}
        className={[
          "w-full border p-4 text-left transition-colors",
          isSelected ? "border-primary bg-primary/5" : "bg-background hover:bg-muted/50",
          !quote.enabled || isPaid ? "cursor-not-allowed opacity-60" : "",
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-medium">{quote.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">{quote.disclosure}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="font-semibold">{formatMoney(quote.totalCents)}</p>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>Processing fee</span>
          <span>{formatMoney(quote.feeCents)}</span>
        </div>
      </button>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Pay invoice</h3>
          <p className="text-sm text-muted-foreground">Choose how you want to pay</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Balance due</p>
          <p className="text-xl font-semibold">{formatMoney(balanceCents)}</p>
        </div>
      </div>

      <Separator />

      <div className="grid gap-3 sm:grid-cols-2">
        {renderMethodButton(payment.feeQuotes.ach)}
        {renderMethodButton(payment.feeQuotes.card)}
      </div>

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

// Convert invoice to Midday format for the template
const defaultTemplate: Template = {
  title: "Invoice",
  customerLabel: "Bill to",
  fromLabel: "From",
  invoiceNoLabel: "Invoice #",
  issueDateLabel: "Issue date",
  dueDateLabel: "Due date",
  descriptionLabel: "Description",
  priceLabel: "Price",
  quantityLabel: "Qty",
  totalLabel: "Total",
  totalSummaryLabel: "Total",
  vatLabel: "VAT",
  subtotalLabel: "Subtotal",
  taxLabel: "Tax",
  discountLabel: "Discount",
  timezone: "America/New_York",
  paymentLabel: "Payment details",
  noteLabel: "Notes",
  logoUrl: null,
  currency: "USD",
  paymentDetails: null,
  fromDetails: null,
  noteDetails: null,
  dateFormat: "MM/dd/yyyy",
  includeVat: false,
  includeTax: true,
  includeDiscount: false,
  includeDecimals: true,
  includeUnits: true,
  includeQr: false,
  taxRate: 0,
  vatRate: 0,
  size: "letter",
  deliveryType: "create",
  locale: "en-US",
}

function mapStatus(status?: string | null): MiddayInvoice["status"] {
  switch (status) {
    case "paid":
      return "paid"
    case "partial":
      return "unpaid"
    case "overdue":
      return "overdue"
    case "void":
      return "canceled"
    case "sent":
      return "unpaid"
    default:
      return "draft"
  }
}

function mapLineItems(invoice: Invoice): LineItem[] {
  const source =
    invoice.lines && invoice.lines.length > 0 ? invoice.lines : ((invoice.metadata as any)?.lines ?? [])

  return (source ?? []).map((line: any) => {
    // Handle both unit_cost_cents (from mapping) and unit_price_cents (raw from DB)
    const priceCents = line.unit_cost_cents ?? line.unit_price_cents ?? null
    const price = typeof priceCents === "number" ? priceCents / 100 : Number(line.unit_cost ?? line.price ?? 0)

    return {
      name: line.description ?? line.name ?? "Item",
      quantity: Number(line.quantity ?? 0),
      unit: line.unit ?? undefined,
      price,
      productId: line.productId ?? undefined,
    }
  })
}

// Helper to convert plain text to EditorDoc format for the invoice template
function textToEditorDoc(text: string | null | undefined): import("@/packages/invoice/src/types").EditorDoc | null {
  if (!text) return null
  const lines = text.split("\n").filter(Boolean)
  if (lines.length === 0) return null

  return {
    type: "doc",
    content: lines.map(line => ({
      type: "paragraph",
      content: [{ type: "text", text: line }]
    }))
  }
}

function toMiddayInvoice(invoice: Invoice): MiddayInvoice {
  const lineItems = mapLineItems(invoice)
  const totalCents = invoice.total_cents ?? invoice.totals?.total_cents ?? 0
  const amount = totalCents ? totalCents / 100 : null
  const metadata = invoice.metadata as any

  // Build customer details from metadata
  const customerName = metadata?.customer_name ?? null
  const customerEmail = metadata?.customer_email ?? null
  const customerDetailsText = [customerName, customerEmail].filter(Boolean).join("\n")

  // Build from details from org info if available
  const orgName = metadata?.org_name ?? null
  const orgEmail = metadata?.org_email ?? null
  const orgPhone = metadata?.org_phone ?? null
  const orgAddress = metadata?.org_address ?? null
  const fromDetailsText = [orgName, orgAddress, orgPhone, orgEmail].filter(Boolean).join("\n")

  // Payment details from metadata
  const paymentDetailsText = metadata?.payment_details ?? null

  const template: Template = {
    ...defaultTemplate,
    taxRate: (invoice.totals?.tax_rate ?? metadata?.tax_rate ?? 0) || 0,
    includeTax: true,
    includeVat: false,
    currency: "USD",
  }

  return {
    id: invoice.id,
    token: invoice.token ?? "",
    invoiceNumber: invoice.invoice_number,
    issueDate: invoice.issue_date ?? null,
    dueDate: invoice.due_date ?? null,
    createdAt: invoice.created_at ?? new Date().toISOString(),
    updatedAt: invoice.updated_at ?? null,
    amount,
    currency: "USD",
    lineItems,
    paymentDetails: textToEditorDoc(paymentDetailsText),
    customerDetails: textToEditorDoc(customerDetailsText),
    fromDetails: textToEditorDoc(fromDetailsText),
    noteDetails: textToEditorDoc(invoice.notes),
    reminderSentAt: null,
    note: invoice.notes ?? null,
    internalNote: null,
    paidAt: invoice.status === "paid" ? invoice.updated_at ?? invoice.created_at ?? null : null,
    vat: null,
    tax: null,
    filePath: null,
    status: mapStatus(invoice.status),
    viewedAt: invoice.viewed_at ?? null,
    sentAt: invoice.sent_at ?? null,
    template,
    customerName: customerName ?? "Customer",
    sentTo: null,
    discount: null,
    topBlock: null,
    bottomBlock: null,
    customer: {
      name: customerName,
      website: null,
      email: customerEmail,
    },
    customerId: null,
    team: {
      name: orgName,
    },
  }
}

export function InvoicePublicWithPay({ invoice, payment, receipts }: Props) {
  const [copied, setCopied] = useState(false)
  const [containerWidth, setContainerWidth] = useState(0)
  const paymentRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapped = useMemo(() => toMiddayInvoice(invoice), [invoice])
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
          <div className="mx-auto px-4 py-3 sm:px-6 lg:px-8" style={{ maxWidth: invoiceWidth + 48 }}>
            <button
              onClick={scrollToPayment}
              className="w-full flex items-center justify-between gap-4 text-left"
            >
              <div>
                <p className="font-semibold">Pay this invoice</p>
                <p className="text-sm opacity-90">
                  {formatMoney(balanceCents)} due
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

      <div className="mx-auto px-4 py-8 sm:px-6 lg:px-8" style={{ maxWidth: invoiceWidth + 48 }}>
        {/* Header */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Invoice
              </p>
              <h1 className="text-lg font-semibold">
                {mapped.invoiceNumber}
                <span className="ml-2 text-muted-foreground font-normal">
                  {mapped.customerName}
                </span>
              </h1>
            </div>
          </div>
          <Badge
            variant={isPaid ? "default" : "secondary"}
            className={`capitalize ${isPaid ? "bg-green-600 hover:bg-green-600" : ""}`}
          >
            {isPaid ? "Paid" : mapped.status}
          </Badge>
        </div>

        {/* Invoice Document - scales to fit on mobile */}
        <div ref={containerRef} className="w-full">
          <div
            className="overflow-hidden"
            style={{ height: scale < 1 ? scaledHeight : invoiceHeight }}
          >
            <div
              className="shadow-lg origin-top-left"
              style={{
                width: invoiceWidth,
                height: invoiceHeight,
                transform: scale < 1 ? `scale(${scale})` : undefined,
              }}
            >
              <HtmlTemplate data={mapped} width={invoiceWidth} height={invoiceHeight} />
            </div>
          </div>
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
                        href={`/i/${invoiceToken}/receipt/${receipt.id}`}
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
