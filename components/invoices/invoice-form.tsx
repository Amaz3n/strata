"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useFieldArray, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"

import type { CostCode, Project } from "@/lib/types"
import { invoiceInputSchema, type InvoiceInput } from "@/lib/validation/invoices"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Plus, Trash2, Calendar, Building2 } from "@/components/icons"

type InvoiceFormValues = InvoiceInput

interface InvoiceFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  defaultProjectId?: string
  costCodes: CostCode[]
  onSubmit: (values: InvoiceFormValues, sendToClient: boolean) => Promise<void>
  isSubmitting?: boolean
}

const defaultLine = {
  cost_code_id: undefined as string | undefined,
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

export function InvoiceForm({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  costCodes,
  onSubmit,
  isSubmitting,
}: InvoiceFormProps) {
  const [submitMode, setSubmitMode] = useState<"draft" | "send">("draft")
  const [numberSource, setNumberSource] = useState<"qbo" | "local">("local")
  const [reservationId, setReservationId] = useState<string | null>(null)
  const [reservationUsed, setReservationUsed] = useState(false)
  const [isLoadingNumber, setIsLoadingNumber] = useState(false)
  const reservationRef = useRef<string | null>(null)
  const reservationUsedRef = useRef(false)

  const costCodeOptions = useMemo(() => {
    const activeCodes = (costCodes ?? []).filter((c) => c.is_active !== false)
    return activeCodes.sort((a, b) => (a.code || "").localeCompare(b.code || ""))
  }, [costCodes])

  const form = useForm<InvoiceFormValues>({
    resolver: zodResolver(invoiceInputSchema),
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
    const normalized: InvoiceFormValues = {
      ...values,
      status: submitMode === "send" ? "sent" : "draft",
      client_visible: submitMode === "send" ? true : values.client_visible,
    }
    try {
      await onSubmit(normalized, submitMode === "send")
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
      })
    } finally {
      // Parent handles errors/toasts; we don't swallow failures here.
    }
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        <Form {...form}>
          <form onSubmit={handleSubmit} className="flex h-full flex-col">
            <div className="flex-shrink-0 border-b bg-muted/30 px-6 pt-6 pb-4">
              <SheetTitle className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-primary" />
                New Invoice
              </SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">
                Create progress or final invoices with line items and tax.
              </SheetDescription>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="project_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Project</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? undefined}>
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
                          <Input placeholder="INV-001" readOnly {...field} />
                        )}
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="reservation_id"
                  render={({ field }) => <input type="hidden" {...field} value={field.value ?? ""} className="hidden" />}
                />
              </div>

              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input placeholder="Progress Billing #1" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="issue_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Issue date</FormLabel>
                      <FormControl>
                        <Input type="date" value={field.value || ""} onChange={(e) => field.onChange(e.target.value)} />
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
                        <Input type="date" value={field.value || ""} onChange={(e) => field.onChange(e.target.value)} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Payment instructions, retainage notes, etc." rows={3} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 md:grid-cols-3">
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

                <FormField
                  control={form.control}
                  name="client_visible"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-md border p-3">
                      <div className="space-y-0.5">
                        <FormLabel>Client can view</FormLabel>
                        <FormDescription>Show this invoice in the portal.</FormDescription>
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-semibold text-sm">Line items</h4>
                    <p className="text-xs text-muted-foreground">Qty x Unit cost. Mark items taxable as needed.</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => lineArray.append({ ...defaultLine })}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add line
                  </Button>
                </div>

                <div className="space-y-3">
                  {lineArray.fields.map((field, index) => (
                    <div key={field.id} className="rounded-lg border p-4 space-y-3 bg-muted/30">
                      <div className="flex items-start justify-between gap-2">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.description`}
                          render={({ field }) => (
                            <FormItem className="flex-1">
                              <FormLabel>Description</FormLabel>
                              <FormControl>
                                <Input placeholder="Work description" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="mt-6"
                          onClick={() => lineArray.remove(index)}
                          disabled={lineArray.fields.length === 1}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-[minmax(100px,1fr)_70px_70px_100px_90px] gap-2">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.cost_code_id`}
                          render={({ field }) => {
                            const selectedCode = costCodeOptions.find(c => c.id === field.value)
                            return (
                              <FormItem>
                                <FormLabel className="text-xs">Cost code</FormLabel>
                                <Select
                                  onValueChange={(val) => field.onChange(val === "none" ? undefined : val)}
                                  value={field.value ?? "none"}
                                >
                                  <FormControl>
                                    <SelectTrigger className="h-9 font-mono text-xs">
                                      <SelectValue placeholder="—">
                                        {selectedCode ? selectedCode.code : "—"}
                                      </SelectValue>
                                    </SelectTrigger>
                                  </FormControl>
                                  <SelectContent>
                                    <SelectItem value="none">
                                      <span className="text-muted-foreground">Unassigned</span>
                                    </SelectItem>
                                    {costCodeOptions.map((code) => (
                                      <SelectItem key={code.id} value={code.id}>
                                        <div className="flex items-center gap-2">
                                          <span className="font-mono text-xs font-medium min-w-[50px]">
                                            {code.code}
                                          </span>
                                          <span className="text-xs text-muted-foreground truncate">
                                            {code.name}
                                          </span>
                                        </div>
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <FormMessage />
                              </FormItem>
                            )
                          }}
                        />

                        <FormField
                          control={form.control}
                          name={`lines.${index}.quantity`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">Qty</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  step={0.01}
                                  min={0}
                                  className="h-9 text-center text-sm tabular-nums"
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
                          name={`lines.${index}.unit`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">Unit</FormLabel>
                              <FormControl>
                                <Input placeholder="ea" className="h-9 text-sm" {...field} />
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
                              <FormLabel className="text-xs">Price</FormLabel>
                              <FormControl>
                                <div className="relative">
                                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                                  <Input
                                    type="number"
                                    step={0.01}
                                    min={0}
                                    className="h-9 pl-6 text-right text-sm tabular-nums"
                                    value={field.value}
                                    onChange={(e) => field.onChange(Number(e.target.value) || 0)}
                                  />
                                </div>
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        {/* Line total - read only */}
                        <div className="flex flex-col">
                          <span className="text-xs font-medium mb-1.5">Total</span>
                          <div className="h-9 flex items-center justify-end px-2 bg-muted/50 rounded-md text-sm font-medium tabular-nums">
                            {formatMoney((watchedValues.lines?.[index]?.quantity ?? 0) * (watchedValues.lines?.[index]?.unit_cost ?? 0))}
                          </div>
                        </div>

                      </div>

                      {/* Taxable toggle - compact row */}
                      <FormField
                        control={form.control}
                        name={`lines.${index}.taxable`}
                        render={({ field }) => (
                          <FormItem className="flex items-center gap-2 pt-1">
                            <FormControl>
                              <Switch checked={field.value} onCheckedChange={field.onChange} className="scale-90" />
                            </FormControl>
                            <FormLabel className="text-xs text-muted-foreground font-normal cursor-pointer">
                              Taxable
                            </FormLabel>
                          </FormItem>
                        )}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <Separator />

              <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <h4 className="font-semibold text-sm">Totals (USD)</h4>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
                  <div className="flex items-center justify-between rounded-md bg-background border px-3 py-2">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="font-semibold">{formatMoney(previewTotals.subtotal)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-md bg-background border px-3 py-2">
                    <span className="text-muted-foreground">Tax</span>
                    <span className="font-semibold">{formatMoney(previewTotals.tax)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-md bg-background border px-3 py-2 md:col-span-2">
                    <span className="text-muted-foreground">Total</span>
                    <span className="text-lg font-bold">{formatMoney(previewTotals.total)}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex-shrink-0 border-t bg-background/80 px-6 py-4 flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">USD only</Badge>
                <Badge variant="outline">Progress or final invoices</Badge>
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
                <Button
                  type="submit"
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => setSubmitMode("send")}
                >
                  Send to client
                </Button>
              </div>
            </div>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
