"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useFieldArray, useForm } from "react-hook-form"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import type { Project } from "@/lib/types"
import { invoiceInputSchema, type InvoiceInput } from "@/lib/validation/invoices"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RichEditor } from "./rich-editor"
import { Calendar, Building2, Plus, Trash2 } from "@/components/icons"
import { Skeleton } from "@/components/ui/skeleton"

const jsonLike = z.any().nullable().optional()

const middayInvoiceSchema = invoiceInputSchema.extend({
  from_details: jsonLike,
  customer_details: jsonLike,
  payment_details: jsonLike,
  note_details: jsonLike,
  top_block: jsonLike,
  bottom_block: jsonLike,
})

type InvoiceFormValues = InvoiceInput & {
  from_details?: any | null
  customer_details?: any | null
  payment_details?: any | null
  note_details?: any | null
  top_block?: any | null
  bottom_block?: any | null
}

interface MiddayInvoiceFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  defaultProjectId?: string
  onSubmit: (values: InvoiceInput, sendToClient: boolean) => Promise<void>
  isSubmitting?: boolean
}

const defaultLine = {
  description: "",
  quantity: 1,
  unit: "item",
  unit_cost: 0,
  taxable: true,
}

function formatMoney(value: number) {
  if (Number.isNaN(value)) return "$0.00"
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function calculatePreviewTotals(values: InvoiceFormValues) {
  const subtotal = values.lines.reduce((sum, line) => sum + line.quantity * line.unit_cost, 0)
  const taxableBase = values.lines.reduce((sum, line) => {
    const lineTotal = line.quantity * line.unit_cost
    return line.taxable === false ? sum : sum + lineTotal
  }, 0)
  const tax = taxableBase * ((values.tax_rate ?? 0) / 100)
  const total = subtotal + tax

  return { subtotal, tax, total }
}

export function MiddayInvoiceForm({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  onSubmit,
  isSubmitting,
}: MiddayInvoiceFormProps) {
  const [submitMode, setSubmitMode] = useState<"draft" | "send">("draft")
  const [numberSource, setNumberSource] = useState<"qbo" | "local">("local")
  const [reservationId, setReservationId] = useState<string | null>(null)
  const [reservationUsed, setReservationUsed] = useState(false)
  const [isLoadingNumber, setIsLoadingNumber] = useState(false)
  const reservationRef = useRef<string | null>(null)
  const reservationUsedRef = useRef(false)

  const form = useForm<InvoiceFormValues>({
    resolver: zodResolver(middayInvoiceSchema),
    defaultValues: {
      project_id: defaultProjectId ?? projects[0]?.id ?? "",
      invoice_number: "",
      title: "",
      status: "draft",
      issue_date: "",
      due_date: "",
      notes: "",
      reservation_id: "",
      client_visible: false,
      tax_rate: 0,
      lines: [defaultLine],
      from_details: null,
      customer_details: null,
      payment_details: null,
      note_details: null,
      top_block: null,
      bottom_block: null,
    },
  })

  const lineArray = useFieldArray({
    control: form.control,
    name: "lines",
  })

  const watchedValues = form.watch()
  const previewTotals = useMemo(() => calculatePreviewTotals(watchedValues), [watchedValues])

  useEffect(() => {
    let cancelled = false

    async function releaseReservation() {
      if (reservationRef.current && !reservationUsedRef.current) {
        await fetch("/api/invoices/release-reservation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reservation_id: reservationRef.current }),
        }).catch((err) => console.error("Failed to release reservation", err))
        reservationRef.current = null
        setReservationId(null)
      }
    }

    async function loadNextNumber() {
      setIsLoadingNumber(true)
      setReservationUsed(false)
      reservationUsedRef.current = false
      try {
        const response = await fetch("/api/invoices/next-number", { cache: "no-store" })
        if (!response.ok) throw new Error("Failed to get next invoice number")
        const data = await response.json()
        if (cancelled) return
        form.setValue("invoice_number", data.number ?? "")
        form.setValue("reservation_id", data.reservation_id ?? "")
        reservationRef.current = data.reservation_id ?? null
        setReservationId(data.reservation_id ?? null)
        setNumberSource(data.source ?? "local")
      } catch (err) {
        console.error(err)
      } finally {
        if (!cancelled) setIsLoadingNumber(false)
      }
    }

    if (open) {
      loadNextNumber()
    } else {
      void releaseReservation()
    }

    return () => {
      cancelled = true
    }
  }, [form, open])

  useEffect(() => {
    return () => {
      if (reservationRef.current && !reservationUsedRef.current) {
        void fetch("/api/invoices/release-reservation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reservation_id: reservationRef.current }),
        }).catch((err) => console.error("Failed to release reservation", err))
      }
    }
  }, [])

  const handleSubmit = form.handleSubmit(async (values) => {
    const payload: InvoiceInput = {
      ...values,
      status: submitMode === "send" ? "sent" : "draft",
      client_visible: submitMode === "send" ? true : values.client_visible,
      notes:
        values.note_details || values.payment_details || values.from_details || values.customer_details
          ? JSON.stringify({
              note_details: values.note_details,
              payment_details: values.payment_details,
              from_details: values.from_details,
              customer_details: values.customer_details,
              top_block: values.top_block,
              bottom_block: values.bottom_block,
              plain_notes: values.notes,
            })
          : values.notes,
    }

    try {
      await onSubmit(payload, submitMode === "send")
      setReservationUsed(true)
      reservationUsedRef.current = true
      reservationRef.current = null
      setReservationId(null)
      form.reset({
        project_id: defaultProjectId ?? projects[0]?.id ?? "",
        invoice_number: "",
        reservation_id: "",
        title: "",
        status: "draft",
        issue_date: "",
        due_date: "",
        notes: "",
        client_visible: false,
        tax_rate: 0,
        lines: [defaultLine],
        from_details: null,
        customer_details: null,
        payment_details: null,
        note_details: null,
        top_block: null,
        bottom_block: null,
      })
    } finally {
      // no-op; errors bubble to parent so toast can show
    }
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-5xl w-full ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 bg-[#fdfdfd] dark:bg-[#0f0f0f]"
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/40">
          <SheetTitle className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-primary" />
            Midday Invoice Composer
          </SheetTitle>
          <p className="text-sm text-muted-foreground">Identical layout to Midday’s sheet, wired to Strata data.</p>
        </SheetHeader>

        <Form {...form}>
          <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
              <div className="flex items-start justify-between gap-6">
                <div className="space-y-3 w-full">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="invoice_number"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="flex items-center gap-2">
                            Invoice #
                            {numberSource === "qbo" && (
                              <Badge variant="outline" className="text-[11px]">
                                From QuickBooks
                              </Badge>
                            )}
                          </FormLabel>
                          <FormControl>
                            {isLoadingNumber ? (
                              <Skeleton className="h-10 w-full" />
                            ) : (
                              <Input placeholder="INV-00024" readOnly {...field} />
                            )}
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="reservation_id"
                      render={({ field }) => (
                        <input type="hidden" {...field} value={field.value ?? ""} className="hidden" />
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="title"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Title</FormLabel>
                          <FormControl>
                            <Input placeholder="Web invoice" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="issue_date"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Issue date</FormLabel>
                          <FormControl>
                            <Input type="date" value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value)} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="due_date"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Due date</FormLabel>
                          <FormControl>
                            <Input type="date" value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value)} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-3 min-w-[200px]">
                  <FormField
                    control={form.control}
                    name="project_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Project</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select a project" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {projects.map((project) => (
                              <SelectItem key={project.id} value={project.id}>
                                <div className="flex items-center gap-2">
                                  <Building2 className="h-4 w-4 text-muted-foreground" />
                                  <span>{project.name}</span>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="client_visible"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between rounded-md border px-3 py-2">
                        <div>
                          <FormLabel>Client can view</FormLabel>
                          <p className="text-xs text-muted-foreground">Show in portal / public link.</p>
                        </div>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-2">
                  <FormLabel>From</FormLabel>
                  <RichEditor
                    value={form.watch("from_details") as any}
                    onChange={(val) => form.setValue("from_details", val, { shouldDirty: true })}
                    placeholder="Your company, address, contact"
                  />
                </div>
                <div className="space-y-2">
                  <FormLabel>Customer</FormLabel>
                  <RichEditor
                    value={form.watch("customer_details") as any}
                    onChange={(val) => form.setValue("customer_details", val, { shouldDirty: true })}
                    placeholder="Client name, email, phone, address"
                  />
                </div>
              </div>

              <div>
                <RichEditor
                  value={form.watch("top_block") as any}
                  onChange={(val) => form.setValue("top_block", val, { shouldDirty: true })}
                  placeholder="Top block (intro)"
                  minHeight="60px"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-semibold text-sm">Line items</h4>
                    <p className="text-xs text-muted-foreground">Drag-friendly grid similar to Midday.</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => lineArray.append({ ...defaultLine })}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add item
                  </Button>
                </div>

                <div className="space-y-3">
                  <div className="grid grid-cols-[1.5fr_0.6fr_0.8fr_0.6fr] gap-3 text-[11px] font-medium text-muted-foreground uppercase">
                    <span>Description</span>
                    <span>Qty</span>
                    <span>Unit cost</span>
                    <span className="text-right">Total</span>
                  </div>

                  {lineArray.fields.map((field, index) => {
                    const quantity = form.watch(`lines.${index}.quantity`)
                    const unitCost = form.watch(`lines.${index}.unit_cost`)
                    const lineTotal = (quantity ?? 0) * (unitCost ?? 0)
                    return (
                      <div
                        key={field.id}
                        className="grid grid-cols-[1.5fr_0.6fr_0.8fr_0.6fr] gap-3 items-start border rounded-lg p-3 bg-muted/40 relative"
                      >
                        <div className="space-y-2">
                          <FormField
                            control={form.control}
                            name={`lines.${index}.description`}
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>
                                  <Input placeholder="Item description" {...field} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name={`lines.${index}.unit`}
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>
                                  <Input placeholder="Unit (hr, item, etc.)" {...field} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>

                        <FormField
                          control={form.control}
                          name={`lines.${index}.quantity`}
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input
                                  type="number"
                                  step={0.01}
                                  min={0}
                                  value={field.value}
                                  onChange={(e) => field.onChange(Number(e.target.value) || 0)}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name={`lines.${index}.unit_cost`}
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input
                                  type="number"
                                  step={0.01}
                                  min={0}
                                  value={field.value}
                                  onChange={(e) => field.onChange(Number(e.target.value) || 0)}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <div className="flex flex-col items-end gap-2">
                          <div className="text-sm font-semibold">{formatMoney(lineTotal)}</div>
                          <FormField
                            control={form.control}
                            name={`lines.${index}.taxable`}
                            render={({ field }) => (
                              <FormItem className="flex items-center gap-2 text-xs text-muted-foreground">
                                <FormControl>
                                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                                </FormControl>
                                <FormLabel className="text-xs font-normal">Taxable</FormLabel>
                              </FormItem>
                            )}
                          />
                        </div>

                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute -right-2 -top-2"
                          onClick={() => lineArray.remove(index)}
                          disabled={lineArray.fields.length === 1}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <FormField
                  control={form.control}
                  name="tax_rate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tax rate (%)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step={0.01}
                          min={0}
                          max={20}
                          value={field.value ?? 0}
                          onChange={(e) => field.onChange(Number(e.target.value) || 0)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="rounded-lg border bg-muted/40 p-4 space-y-2 md:col-span-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="font-semibold">{formatMoney(previewTotals.subtotal)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Tax</span>
                    <span className="font-semibold">{formatMoney(previewTotals.tax)}</span>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between text-base">
                    <span className="text-muted-foreground">Total</span>
                    <span className="text-lg font-bold">{formatMoney(previewTotals.total)}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <FormLabel>Payment details</FormLabel>
                  <RichEditor
                    value={form.watch("payment_details") as any}
                    onChange={(val) => form.setValue("payment_details", val, { shouldDirty: true })}
                    placeholder="Payment terms, ACH info, etc."
                  />
                </div>
                <div className="space-y-2">
                  <FormLabel>Notes</FormLabel>
                  <RichEditor
                    value={form.watch("note_details") as any}
                    onChange={(val) => form.setValue("note_details", val, { shouldDirty: true })}
                    placeholder="Internal or client-facing notes"
                  />
                </div>
              </div>

              <div>
                <RichEditor
                  value={form.watch("bottom_block") as any}
                  onChange={(val) => form.setValue("bottom_block", val, { shouldDirty: true })}
                  placeholder="Bottom block (thank you, footer)"
                  minHeight="60px"
                />
              </div>
            </div>

            <SheetFooter className="border-t bg-background/90 px-6 py-4 flex flex-col gap-3">
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">Midday-style layout</Badge>
                <Badge variant="outline">Rich text blocks</Badge>
                <Badge variant="outline">Totals auto-calc</Badge>
              </div>
              <div className="flex gap-3">
                <Button
                  type="submit"
                  variant="secondary"
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => setSubmitMode("draft")}
                >
                  Save draft
                </Button>
                <Button type="submit" className="w-full" disabled={isSubmitting} onClick={() => setSubmitMode("send")}>
                  Send to client
                </Button>
              </div>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
