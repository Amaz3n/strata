"use client"

import { useMemo, useState, useEffect } from "react"
import { useFieldArray, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"

import { changeOrderInputSchema, type ChangeOrderInput } from "@/lib/validation/change-orders"
import type { CostCode, Project } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Plus, Trash2, DollarSign, Sparkles } from "@/components/icons"

type ChangeOrderFormValues = ChangeOrderInput

interface ChangeOrderFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  costCodes?: CostCode[]
  defaultProjectId?: string
  onSubmit: (values: ChangeOrderFormValues, publish: boolean) => Promise<void>
  isSubmitting?: boolean
}

const defaultLine = {
  cost_code_id: undefined,
  description: "",
  quantity: 1,
  unit: "item",
  unit_cost: 0,
  allowance: 0,
  taxable: true,
}

function formatMoney(value: number) {
  if (Number.isNaN(value)) return "$0.00"
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function calculatePreviewTotals(values: ChangeOrderFormValues) {
  const subtotal = values.lines.reduce((sum, line) => {
    return sum + line.quantity * line.unit_cost + (line.allowance ?? 0)
  }, 0)

  const allowanceTotal = values.lines.reduce((sum, line) => sum + (line.allowance ?? 0), 0)
  const taxableBase = values.lines.reduce((sum, line) => {
    const lineTotal = line.quantity * line.unit_cost + (line.allowance ?? 0)
    return line.taxable === false ? sum : sum + lineTotal
  }, 0)

  const tax = taxableBase * ((values.tax_rate ?? 0) / 100)
  const markup = subtotal * ((values.markup_percent ?? 0) / 100)
  const total = subtotal + tax + markup

  return { subtotal, allowanceTotal, tax, markup, total }
}

export function ChangeOrderForm({
  open,
  onOpenChange,
  projects,
  costCodes = [],
  defaultProjectId,
  onSubmit,
  isSubmitting,
}: ChangeOrderFormProps) {
  const [submitMode, setSubmitMode] = useState<"draft" | "publish">("draft")
  const [summaryManuallyEdited, setSummaryManuallyEdited] = useState(false)

  const form = useForm<ChangeOrderFormValues>({
    resolver: zodResolver(changeOrderInputSchema),
    defaultValues: {
      project_id: defaultProjectId ?? projects[0]?.id ?? "",
      title: "",
      summary: "",
      description: "",
      days_impact: undefined,
      requires_signature: true,
      tax_rate: 0,
      markup_percent: 0,
      status: "draft",
      client_visible: false,
      lines: [defaultLine],
    },
  })

  const lineArray = useFieldArray({
    control: form.control,
    name: "lines",
  })

  const watchedValues = form.watch()
  const previewTotals = useMemo(() => calculatePreviewTotals(watchedValues), [watchedValues])
  const titleValue = form.watch("title")

  // Auto-populate summary from title, but stop if user manually edited summary
  useEffect(() => {
    if (!summaryManuallyEdited && titleValue) {
      form.setValue("summary", titleValue, { shouldValidate: false, shouldDirty: false })
    }
  }, [titleValue, summaryManuallyEdited, form])

  const handleSubmit = form.handleSubmit(async (values) => {
    const normalized: ChangeOrderFormValues = {
      ...values,
      status: submitMode === "publish" ? "pending" : "draft",
      client_visible: submitMode === "publish",
      days_impact: values.days_impact ?? null,
      lines: values.lines.map((line) => ({
        ...line,
        cost_code_id: line.cost_code_id === "none" ? undefined : line.cost_code_id,
      })),
    }
    await onSubmit(normalized, submitMode === "publish")
    setSummaryManuallyEdited(false)
    form.reset({
      project_id: defaultProjectId ?? projects[0]?.id ?? "",
      title: "",
      summary: "",
      description: "",
      days_impact: undefined,
      requires_signature: true,
      tax_rate: 0,
      markup_percent: 0,
      status: "draft",
      client_visible: false,
      lines: [defaultLine],
    })
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            New Change Order
          </SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            Capture scope, pricing, taxes, markup, and publish to the client when ready.
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
            <ScrollArea className="flex-1 min-h-0">
              <div className="px-6 py-4 space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Title</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g., Add recessed lighting in living room" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="summary"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Client-facing summary</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Brief summary the client will see"
                          {...field}
                          onChange={(e) => {
                            setSummaryManuallyEdited(true)
                            field.onChange(e)
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Scope & notes</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Detailed scope, assumptions, exclusions" rows={4} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 md:grid-cols-3">
                <FormField
                  control={form.control}
                  name="days_impact"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Schedule impact (days)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          value={field.value ?? ""}
                          onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                          placeholder="0"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

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
                  name="markup_percent"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Markup (%)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step={0.1}
                          min={0}
                          max={100}
                          value={field.value ?? 0}
                          onChange={(e) => field.onChange(Number(e.target.value) || 0)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-semibold text-sm">Line items</h4>
                    <p className="text-xs text-muted-foreground">
                      Include allowances and mark items taxable as needed.
                    </p>
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
                      <div className="flex items-center gap-2">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.description`}
                          render={({ field }) => (
                            <FormItem className="flex-1 space-y-0">
                              <FormControl>
                                <Input placeholder="Work description" {...field} className="w-full" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-10 w-10 shrink-0"
                          onClick={() => lineArray.remove(index)}
                          disabled={lineArray.fields.length === 1}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.cost_code_id`}
                          render={({ field }) => (
                            <FormItem className="md:col-span-2 space-y-2">
                              <FormLabel className="text-xs font-medium text-muted-foreground">Cost code</FormLabel>
                              <Select
                                value={field.value ?? "none"}
                                onValueChange={(value) => field.onChange(value === "none" ? undefined : value)}
                              >
                                <FormControl>
                                  <SelectTrigger>
                                    <SelectValue placeholder="No cost code" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="none">No cost code</SelectItem>
                                  {costCodes.map((code) => (
                                    <SelectItem key={code.id} value={code.id}>
                                      {code.code} · {code.name}
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
                          name={`lines.${index}.quantity`}
                          render={({ field }) => (
                            <FormItem className="space-y-2">
                              <FormLabel className="text-xs font-medium text-muted-foreground">Qty</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  step={0.01}
                                  min={0}
                                  value={field.value}
                                  onChange={(e) => field.onChange(Number(e.target.value) || 0)}
                                  placeholder="1"
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
                            <FormItem className="space-y-2">
                              <FormLabel className="text-xs font-medium text-muted-foreground">Unit cost</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  step={0.01}
                                  min={0}
                                  value={field.value}
                                  onChange={(e) => field.onChange(Number(e.target.value) || 0)}
                                  placeholder="0.00"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name={`lines.${index}.allowance`}
                          render={({ field }) => (
                            <FormItem className="space-y-2">
                              <FormLabel className="text-xs font-medium text-muted-foreground">Allowance</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  step={0.01}
                                  min={0}
                                  value={field.value}
                                  onChange={(e) => field.onChange(Number(e.target.value) || 0)}
                                  placeholder="0.00"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      <div className="flex items-center justify-between gap-3">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.taxable`}
                          render={({ field }) => (
                            <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                              <FormControl>
                                <Checkbox
                                  checked={field.value}
                                  onCheckedChange={field.onChange}
                                />
                              </FormControl>
                              <FormLabel className="text-xs font-medium cursor-pointer">
                                Taxable
                              </FormLabel>
                            </FormItem>
                          )}
                        />
                        <Badge variant="secondary" className="text-xs">
                          Total: {formatMoney(
                            (form.watch(`lines.${index}.quantity`) || 0) *
                              (form.watch(`lines.${index}.unit_cost`) || 0) +
                              (form.watch(`lines.${index}.allowance`) || 0),
                          )}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <Separator />

              <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                  <h4 className="font-semibold text-sm">Totals preview</h4>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
                  <div className="flex items-center justify-between rounded-md bg-background border px-3 py-2">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="font-semibold">{formatMoney(previewTotals.subtotal)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-md bg-background border px-3 py-2">
                    <span className="text-muted-foreground">Allowances</span>
                    <span className="font-semibold">{formatMoney(previewTotals.allowanceTotal)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-md bg-background border px-3 py-2">
                    <span className="text-muted-foreground">Markup</span>
                    <span className="font-semibold">{formatMoney(previewTotals.markup)}</span>
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

              <FormField
                control={form.control}
                name="requires_signature"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-md border p-4">
                    <div className="space-y-0.5">
                      <FormLabel>Require signature</FormLabel>
                      <FormDescription>Client must sign the change order when approving.</FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
              </div>
            </ScrollArea>

            <SheetFooter className="flex-shrink-0 border-t bg-muted/30 px-6 py-4">
              <div className="flex gap-2 w-full">
                <Button
                  type="submit"
                  variant="secondary"
                  className="flex-1"
                  disabled={isSubmitting}
                  onClick={() => setSubmitMode("draft")}
                >
                  Save as draft
                </Button>
                <Button
                  type="submit"
                  className="flex-1"
                  disabled={isSubmitting}
                  onClick={() => setSubmitMode("publish")}
                >
                  Publish to client
                </Button>
              </div>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}

