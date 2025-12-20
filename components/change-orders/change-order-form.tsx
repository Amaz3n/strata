"use client"

import { useMemo, useState } from "react"
import { useFieldArray, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"

import { changeOrderInputSchema, type ChangeOrderInput } from "@/lib/validation/change-orders"
import type { Project } from "@/lib/types"
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
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Plus, Trash2, DollarSign, Building2, Sparkles } from "@/components/icons"

type ChangeOrderFormValues = ChangeOrderInput

interface ChangeOrderFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  defaultProjectId?: string
  onSubmit: (values: ChangeOrderFormValues, publish: boolean) => Promise<void>
  isSubmitting?: boolean
}

const defaultLine = {
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
  defaultProjectId,
  onSubmit,
  isSubmitting,
}: ChangeOrderFormProps) {
  const [submitMode, setSubmitMode] = useState<"draft" | "publish">("draft")

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

  const handleSubmit = form.handleSubmit(async (values) => {
    const normalized: ChangeOrderFormValues = {
      ...values,
      status: submitMode === "publish" ? "pending" : "draft",
      client_visible: submitMode === "publish",
      days_impact: values.days_impact ?? null,
    }
    await onSubmit(normalized, submitMode === "publish")
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
        className="sm:max-w-xl w-full ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 fast-sheet-animation"
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
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
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
                        <Input placeholder="Brief summary the client will see" {...field} />
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
                      <FormDescription>Positive values push the schedule.</FormDescription>
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

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.quantity`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Qty</FormLabel>
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
                          name={`lines.${index}.unit`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Unit</FormLabel>
                              <FormControl>
                                <Input placeholder="unit" {...field} />
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
                              <FormLabel>Unit cost (USD)</FormLabel>
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
                          name={`lines.${index}.allowance`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Allowance (USD)</FormLabel>
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
                      </div>

                      <div className="flex items-center justify-between">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.taxable`}
                          render={({ field }) => (
                            <FormItem className="flex flex-row items-center justify-between rounded-md border p-3">
                              <div className="space-y-0.5">
                                <FormLabel>Taxable</FormLabel>
                                <FormDescription>Apply tax to this line item.</FormDescription>
                              </div>
                              <FormControl>
                                <Switch checked={field.value} onCheckedChange={field.onChange} />
                              </FormControl>
                            </FormItem>
                          )}
                        />
                        <Badge variant="secondary" className="text-xs">
                          Est. line total:{" "}
                          {formatMoney(
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
                  <h4 className="font-semibold text-sm">Totals preview (USD)</h4>
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

            <SheetFooter className="border-t bg-background/80 px-6 py-4 flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">USD only</Badge>
                <Badge variant="outline">Supports taxes, markup, allowances</Badge>
              </div>
              <div className="flex gap-3">
                <Button
                  type="submit"
                  variant="secondary"
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => setSubmitMode("draft")}
                >
                  Save as draft
                </Button>
                <Button
                  type="submit"
                  className="w-full"
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




