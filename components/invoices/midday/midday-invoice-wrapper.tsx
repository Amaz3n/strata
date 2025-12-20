"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useForm, FormProvider } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"

import type { Contact, CostCode, Invoice, Project } from "@/lib/types"
import type { JSONContent } from "@tiptap/react"
import type { InvoiceInput, InvoiceLineInput } from "@/lib/validation/invoices"
import { toast } from "sonner"

import { FormContext, invoiceFormSchema } from "@/components/midday/invoice/form-context"
import { Form as MiddayForm } from "@/components/midday/invoice/form"
import { SettingsMenu } from "@/components/midday/invoice/settings-menu"
import { SubmitButton } from "@/components/midday/invoice/submit-button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const jsonLike = z.any().nullable().optional()

const mappedSchema = invoiceFormSchema.extend({
  // Map Midday fields to ours as optional JSON blobs
  fromDetails: jsonLike,
  customerDetails: jsonLike,
  paymentDetails: jsonLike,
  noteDetails: jsonLike,
  topBlock: jsonLike,
  bottomBlock: jsonLike,
  // Ensure line items map to our shape
  lineItems: z.array(
    z.object({
      name: z.string().min(1),
      quantity: z.number(),
      unit: z.string().optional(),
      price: z.number(),
      productId: z.string().optional().nullable(),
      tax: z.number().optional().nullable(),
      vat: z.number().optional().nullable(),
      costCodeId: z.string().uuid().optional().nullable(),
    }),
  ),
})

type MappedValues = z.infer<typeof mappedSchema>

type Props = {
  projects: Project[]
  defaultProjectId?: string
  onSubmit: (values: InvoiceInput, sendToClient: boolean) => Promise<void>
  isSubmitting?: boolean
  mode?: "create" | "edit"
  invoice?: Invoice
  builderInfo?: {
    name?: string | null
    email?: string | null
    address?: string | null
  }
  contacts?: Contact[]
  costCodes?: CostCode[]
}

function buildRichTextContent(lines: string[]): JSONContent {
  const content = lines.filter((line) => line.trim().length > 0).map((line) => ({
    type: "paragraph",
    content: [{ type: "text", text: line }],
  }))
  return { type: "doc", content }
}

function buildEmailOnlyContent(email: string, name?: string | null): JSONContent {
  const parts = [name ?? null, email].filter(Boolean) as string[]
  return buildRichTextContent(parts)
}

function buildContactContent(contact: Contact): JSONContent {
  const lines = [
    contact.full_name,
    contact.email ?? "",
    contact.phone ?? "",
    contact.role ?? "",
    contact.primary_company?.name ?? "",
  ].filter((line) => line && line.trim().length > 0)

  return buildRichTextContent(lines)
}

function toMappedValues(invoice: Invoice, contacts?: Contact[], builderDefaultContent?: JSONContent | null): MappedValues {
  const taxRate = invoice.totals?.tax_rate ?? (invoice.metadata as any)?.tax_rate ?? 0
  const paymentTerms = (invoice.metadata as any)?.payment_terms_days ?? 30
  const linesSource = invoice.lines && invoice.lines.length > 0 ? invoice.lines : (invoice.metadata as any)?.lines ?? []
  const noteBlob = invoice.notes
  let parsedNotes: any = null
  if (noteBlob) {
    try {
      parsedNotes = JSON.parse(noteBlob)
    } catch {
      parsedNotes = null
    }
  }

  const recipientEmail = invoice.sent_to_emails?.[0]
  const recipientContact = recipientEmail ? contacts?.find((c) => c.email === recipientEmail) : undefined
  const metadataCustomerDetails = parsedNotes?.customer_details ?? (invoice.metadata as any)?.customer_details ?? null
  const metadataFromDetails = parsedNotes?.from_details ?? (invoice.metadata as any)?.from_details ?? null
  const metadataCustomerId = (invoice.metadata as any)?.customer_id
  const metadataCustomerName = (invoice.metadata as any)?.customer_name

  const mappedLines =
    linesSource && linesSource.length > 0
      ? linesSource.map((l: any) => ({
        name: l.description ?? l.name ?? "Item",
        quantity: Number(l.quantity ?? 0),
        unit: l.unit ?? "unit",
        price: typeof l.unit_cost_cents === "number" ? l.unit_cost_cents / 100 : Number(l.unit_cost ?? 0),
        productId: l.productId ?? null,
        tax: null,
        vat: null,
        costCodeId: l.cost_code_id ?? null,
      }))
      : [
        {
          name: "Item",
          quantity: 1,
          unit: "item",
          price: 0,
          productId: null,
          tax: null,
          vat: null,
          costCodeId: null,
        },
      ]

  return {
    id: invoice.id,
    status: invoice.status,
    template: {
      title: invoice.title ?? "Invoice",
      customerLabel: "Bill to",
      fromLabel: "From",
      invoiceNoLabel: "Invoice #",
      issueDateLabel: "Issue date",
      dueDateLabel: "Due date",
      descriptionLabel: "Description",
      priceLabel: "Price",
      quantityLabel: "Qty",
      totalLabel: "Total",
      paymentLabel: "Payment details",
      noteLabel: "Notes",
      logoUrl: null,
      currency: "USD",
      size: "letter",
      includeVat: false,
      includeTax: true,
      includeDiscount: false,
      includeDecimals: true,
      includePdf: true,
      includeUnits: true,
      includeQr: false,
      taxRate,
      vatRate: 0,
      dateFormat: "MM/dd/yyyy",
      deliveryType: invoice.status === "sent" || invoice.client_visible ? "create_and_send" : "create",
      paymentTermsDays: paymentTerms,
      totalSummaryLabel: "Total",
      subtotalLabel: "Subtotal",
      taxLabel: "Tax",
      discountLabel: "Discount",
      locale: "en-US",
      timezone: "America/New_York",
    },
    fromDetails: metadataFromDetails ?? builderDefaultContent ?? null,
    customerDetails:
      metadataCustomerDetails ??
      (recipientContact
        ? buildContactContent(recipientContact)
        : recipientEmail
          ? buildEmailOnlyContent(recipientEmail, metadataCustomerName)
          : null),
    paymentDetails: parsedNotes?.payment_details ?? null,
    noteDetails: parsedNotes?.note_details ?? (noteBlob ? buildRichTextContent([noteBlob]) : null),
    topBlock: parsedNotes?.top_block ?? null,
    bottomBlock: parsedNotes?.bottom_block ?? null,
    dueDate: invoice.due_date ?? undefined,
    issueDate: invoice.issue_date ?? undefined,
    invoiceNumber: invoice.invoice_number,
    logoUrl: null,
    vat: null,
    tax: null,
    discount: null,
    subtotal: null,
    amount: (invoice.total_cents ?? invoice.totals?.total_cents ?? 0) / 100,
    lineItems: mappedLines,
    token: invoice.token ?? undefined,
    scheduledAt: null,
    customerId: recipientContact?.id ?? metadataCustomerId ?? null,
    customerName: recipientContact?.full_name ?? metadataCustomerName ?? recipientEmail ?? null,
  }
}

export function MiddayInvoiceWrapper({
  projects,
  defaultProjectId,
  onSubmit,
  isSubmitting,
  mode = "create",
  invoice,
  builderInfo,
  contacts,
  costCodes,
}: Props) {
  const [projectId, setProjectId] = useState<string | undefined>(defaultProjectId ?? invoice?.project_id ?? undefined)
  const [, setIsLoadingNumber] = useState(false)
  const reservationRef = useRef<string | null>(null)
  const reservationUsedRef = useRef(false)
  const today = new Date()
  const formatDate = (date: Date) => date.toISOString().slice(0, 10)
  const defaultIssueDate = formatDate(today)
  const defaultTerms = 30
  const defaultDueDate = formatDate(new Date(today.getTime() + defaultTerms * 24 * 60 * 60 * 1000))

  const builderDefaultContent = useMemo(() => {
    const lines = [builderInfo?.name ?? "", builderInfo?.address ?? "", builderInfo?.email ?? ""].filter(
      (line) => line.trim().length > 0,
    )
    return lines.length > 0 ? buildRichTextContent(lines) : null
  }, [builderInfo])

  const initialValues = useMemo(() => {
    if (invoice) {
      return toMappedValues(invoice, contacts, builderDefaultContent)
    }
    return {
      // Minimal defaults to satisfy Midday schema
      id: crypto.randomUUID(),
      status: "draft",
      template: {
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
        paymentLabel: "Payment details",
        noteLabel: "Notes",
        logoUrl: null,
        currency: "USD",
        size: "letter",
        includeVat: false,
        includeTax: true,
        includeDiscount: false,
        includeDecimals: true,
        includePdf: true,
        includeUnits: true,
        includeQr: false,
        taxRate: 0,
        vatRate: 0,
        dateFormat: "MM/dd/yyyy",
        deliveryType: "create",
        paymentTermsDays: defaultTerms,
        totalSummaryLabel: "Total",
        subtotalLabel: "Subtotal",
        taxLabel: "Tax",
        discountLabel: "Discount",
        locale: "en-US",
        timezone: "America/New_York",
      },
      fromDetails: builderDefaultContent,
      customerDetails: null,
      paymentDetails: null,
      noteDetails: null,
      topBlock: null,
      bottomBlock: null,
      dueDate: defaultDueDate,
      issueDate: defaultIssueDate,
      invoiceNumber: "INV-001",
      logoUrl: null,
      vat: null,
      tax: null,
      discount: null,
      subtotal: null,
      amount: 0,
      lineItems: [
        {
          name: "Item",
          quantity: 1,
          unit: "item",
          price: 0,
          productId: null,
          tax: null,
          vat: null,
          costCodeId: null,
        },
      ],
      token: undefined,
      scheduledAt: null,
      customerId: crypto.randomUUID(),
    } satisfies MappedValues
  }, [invoice, contacts, builderDefaultContent, defaultDueDate, defaultIssueDate, defaultTerms])

  const form = useForm<MappedValues>({
    resolver: zodResolver(mappedSchema),
    defaultValues: initialValues,
    mode: "onChange",
  })

  const resolveRecipientEmails = (customerId?: string | null) => {
    if (!customerId || !contacts?.length) return []
    const contact = contacts.find((c) => c.id === customerId)
    return contact?.email ? [contact.email] : []
  }

  const releaseReservation = useCallback(async () => {
    if (mode === "edit") return
    if (reservationRef.current && !reservationUsedRef.current) {
      await fetch("/api/invoices/release-reservation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservation_id: reservationRef.current }),
      }).catch((err) => console.error("Failed to release reservation", err))
      reservationRef.current = null
    }
  }, [])

  const loadNextNumber = useCallback(async () => {
    if (mode === "edit") return
    reservationUsedRef.current = false
    setIsLoadingNumber(true)
    try {
      const response = await fetch("/api/invoices/next-number", { cache: "no-store" })
      if (!response.ok) throw new Error("Failed to get next invoice number")
      const data = await response.json()
      form.setValue("invoiceNumber", data.number ?? "", { shouldDirty: false })
      reservationRef.current = data.reservation_id ?? null
    } catch (err) {
      console.error("Unable to fetch next invoice number", err)
    } finally {
      setIsLoadingNumber(false)
    }
  }, [form, mode])

  // Bind project selection into template metadata (simple map)
  useEffect(() => {
    if (defaultProjectId) {
      form.setValue("template.currency", "USD", { shouldDirty: false })
    }
  }, [defaultProjectId, form])

  // Reserve the next invoice number from QBO (or local fallback) and release if abandoned (create only).
  useEffect(() => {
    if (mode === "create") {
      loadNextNumber()
    }
    return () => {
      if (mode === "create") {
        void releaseReservation()
      }
    }
  }, [loadNextNumber, mode, releaseReservation])

  // Sync form defaults when editing an existing invoice.
  useEffect(() => {
    form.reset(initialValues)
    if (invoice?.project_id) {
      setProjectId(invoice.project_id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, invoice?.id, mode])

  // Wire submit to our createInvoiceAction
  const handleSubmit = async (values: MappedValues) => {
    try {
      const deliveryType = values.template?.deliveryType
      const shouldSend = deliveryType === "create_and_send"
      const mappedLines: InvoiceLineInput[] = values.lineItems.map((l) => ({
        description: l.name,
        quantity: l.quantity,
        unit: l.unit ?? "unit",
        unit_cost: l.price * 100, // Convert dollars to cents for backend
        taxable: true,
        cost_code_id: l.costCodeId ?? undefined,
      }))

      const payload: InvoiceInput = {
        project_id: projectId ?? null,
        invoice_number: values.invoiceNumber || "INV-",
        title: values.template.title || "Invoice",
        status: shouldSend ? "sent" : "draft",
        customer_id: values.customerId ?? undefined,
        customer_name: values.customerName ?? undefined,
        issue_date: values.issueDate || undefined,
        due_date: values.dueDate || undefined,
        notes: values.noteDetails ? JSON.stringify(values.noteDetails) : undefined,
        client_visible: shouldSend,
        tax_rate: values.template.taxRate ?? 0,
        reservation_id: reservationRef.current ?? undefined,
        lines: mappedLines,
        sent_to_emails: resolveRecipientEmails(values.customerId),
        payment_terms_days: values.template.paymentTermsDays ?? defaultTerms,
      }

      await onSubmit(payload, shouldSend)
      if (mode === "create") {
        reservationUsedRef.current = true
        reservationRef.current = null
        // Preload the next invoice number for the next create flow.
        void loadNextNumber()
      }
      toast.success(shouldSend ? "Invoice sent" : "Draft saved")
    } catch (err: any) {
      console.error(err)
      toast.error("Could not save invoice", { description: err?.message ?? "Please try again." })
    }
  }

  // We still render Midday Form inside a FormProvider, but we bypass TRPC
  return (
    <FormProvider {...form}>
      <form
        className="flex h-full flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          form.handleSubmit(handleSubmit)()
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <Select
            value={projectId ?? "none"}
            onValueChange={(val) => {
              setProjectId(val === "none" ? undefined : val)
            }}
          >
            <SelectTrigger className="w-48 h-8 text-sm">
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No project</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SettingsMenu />
        </div>
        <div className="flex-1 overflow-hidden">
          <MiddayForm hideSubmit isSubmitting={isSubmitting} contacts={contacts} costCodes={costCodes} />
        </div>
        <div className="flex justify-end">
          <SubmitButton isSubmitting={!!isSubmitting} disabled={!!isSubmitting} isEdit={mode === "edit"} />
        </div>
      </form>
    </FormProvider>
  )
}
