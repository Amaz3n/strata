"use client"

import { useEffect, useMemo, useState } from "react"
import { useForm, FormProvider, useFieldArray } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"

import type { Contact, CostCode, Project } from "@/lib/types"
import type { JSONContent } from "@tiptap/react"
import type { InvoiceInput, InvoiceLineInput } from "@/lib/validation/invoices"
import { invoiceInputSchema } from "@/lib/validation/invoices"
import { createInvoiceAction } from "@/app/invoices/actions"
import { toast } from "sonner"

import { FormContext, invoiceFormSchema } from "@/components/midday/invoice/form-context"
import { Form as MiddayForm } from "@/components/midday/invoice/form"
import { SettingsMenu } from "@/components/midday/invoice/settings-menu"
import { SubmitButton } from "@/components/midday/invoice/submit-button"
import { transformFormValuesToDraft } from "@/components/midday/invoice/utils"
import { Label } from "@/components/ui/label"
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
  submitMode: "draft" | "send"
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

export function MiddayInvoiceWrapper({
  projects,
  defaultProjectId,
  onSubmit,
  isSubmitting,
  submitMode,
  builderInfo,
  contacts,
  costCodes,
}: Props) {
  const [projectId, setProjectId] = useState<string | undefined>(defaultProjectId)
  const today = new Date()
  const formatDate = (date: Date) => date.toISOString().slice(0, 10)
  const defaultIssueDate = formatDate(today)
  const defaultTerms = 30
  const defaultDueDate = formatDate(new Date(today.getTime() + defaultTerms * 24 * 60 * 60 * 1000))

  const builderLines = [
    builderInfo?.name ?? "",
    builderInfo?.address ?? "",
    builderInfo?.email ?? "",
  ].filter((line) => line.trim().length > 0)
  const builderDefaultContent = builderLines.length > 0 ? buildRichTextContent(builderLines) : null

  const resolveRecipientEmails = (customerId?: string | null) => {
    if (!customerId || !contacts?.length) return []
    const contact = contacts.find((c) => c.id === customerId)
    return contact?.email ? [contact.email] : []
  }
  const form = useForm<MappedValues>({
    resolver: zodResolver(mappedSchema),
    defaultValues: {
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
    },
    mode: "onChange",
  })

  // Bind project selection into template metadata (simple map)
  useEffect(() => {
    if (defaultProjectId) {
      form.setValue("template.currency", "USD", { shouldDirty: false })
    }
  }, [defaultProjectId, form])

  // Wire submit to our createInvoiceAction
  const handleSubmit = async (values: MappedValues) => {
    try {
      const mappedLines: InvoiceLineInput[] = values.lineItems.map((l) => ({
        description: l.name,
        quantity: l.quantity,
        unit: l.unit ?? "unit",
        unit_cost: l.price,
        taxable: true,
        cost_code_id: l.costCodeId ?? undefined,
      }))

      const payload: InvoiceInput = {
        project_id: projectId ?? null,
        invoice_number: values.invoiceNumber || "INV-",
        title: values.template.title || "Invoice",
        status: submitMode === "send" ? "sent" : "draft",
        issue_date: values.issueDate || undefined,
        due_date: values.dueDate || undefined,
        notes: values.noteDetails ? JSON.stringify(values.noteDetails) : undefined,
        client_visible: submitMode === "send",
        tax_rate: values.template.taxRate ?? 0,
        lines: mappedLines,
        sent_to_emails: resolveRecipientEmails(values.customerId),
        payment_terms_days: values.template.paymentTermsDays ?? defaultTerms,
      }

      await onSubmit(payload, submitMode === "send")
      toast.success(submitMode === "send" ? "Invoice sent" : "Draft saved")
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
          <SubmitButton isSubmitting={!!isSubmitting} disabled={!!isSubmitting} />
        </div>
      </form>
    </FormProvider>
  )
}



