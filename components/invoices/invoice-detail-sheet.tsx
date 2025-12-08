"use client"

import type React from "react"
import { useMemo } from "react"
import { format } from "date-fns"
import { Copy, ExternalLink, Download } from "lucide-react"

import type { Invoice, InvoiceView } from "@/lib/types"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"

type Props = {
  trigger?: React.ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice?: Invoice | null
  link?: string
  views?: InvoiceView[]
  loading?: boolean
  onCopyLink?: () => void
}

function formatMoneyFromCents(cents?: number | null) {
  const value = cents ?? 0
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

type CopyInputProps = { value: string; actions?: React.ReactNode }

function CopyInput({ value, actions }: CopyInputProps) {
  return (
    <div className="relative flex items-center">
      <Input readOnly value={value} className="pr-24 text-sm" />
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {actions}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={async () => {
            try {
              if (typeof navigator !== "undefined" && navigator.clipboard) {
                await navigator.clipboard.writeText(value)
              }
            } catch (err) {
              console.error("Copy failed", err)
            }
          }}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

export function InvoiceDetailSheet({ trigger, open, onOpenChange, invoice, link, views, loading, onCopyLink }: Props) {
  const subtotal = invoice?.totals?.subtotal_cents ?? invoice?.subtotal_cents ?? 0
  const tax = invoice?.totals?.tax_cents ?? invoice?.tax_cents ?? 0
  const total = invoice?.totals?.total_cents ?? invoice?.total_cents ?? subtotal + tax
  const metadata = (invoice?.metadata as Record<string, any>) ?? {}
  const customerName = metadata.customer_name ?? "Customer"
  const customerInitial = customerName?.[0] ?? "C"
  const sentAtValue = (invoice as any)?.sent_at ?? metadata.sent_at ?? metadata.sentAt
  const sentToValue = (invoice as any)?.sent_to ?? metadata.sent_to ?? metadata.sentTo

  const activity = useMemo(() => {
    return (views ?? []).map((v) => ({
      id: v.id,
      viewed_at: v.viewed_at,
      ip: v.ip_address,
      ua: v.user_agent,
    }))
  }, [views])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
      <SheetContent
        side="right"
        className="sm:max-w-xl w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] overflow-hidden rounded-lg border shadow-2xl flex flex-col bg-white dark:bg-[#0C0C0C] gap-0 [&>button]:hidden fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 pt-6 pb-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Avatar className="size-9">
                  <AvatarFallback className="text-xs font-medium">{customerInitial}</AvatarFallback>
                </Avatar>
                <div className="flex flex-col">
                  <span className="text-base font-semibold leading-tight line-clamp-1">{customerName}</span>
                </div>
              </div>
              {invoice?.status && <Badge className="capitalize">{invoice.status}</Badge>}
            </div>

            <div className="flex flex-col gap-4">
              <span className="text-4xl font-semibold leading-none select-text">{formatMoneyFromCents(total)}</span>
              <div className="grid grid-cols-2 gap-3">
                <Button type="button" variant="secondary" size="sm" className="w-full justify-center">
                  Remind
                </Button>
                <Button type="button" variant="outline" size="sm" className="w-full justify-center">
                  Edit
                </Button>
              </div>
            </div>
          </div>

          <Separator className="my-4" />

          <div className="px-5 py-5 space-y-4">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Due date</span>
              <span className="text-foreground">
                {invoice?.due_date ? format(new Date(invoice.due_date), "MMM dd, yyyy") : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Issue date</span>
              <span className="text-foreground">
                {invoice?.issue_date ? format(new Date(invoice.issue_date), "MMM dd, yyyy") : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Sent at</span>
              <span className="text-foreground">
                {sentAtValue ? format(new Date(sentAtValue), "MMM dd, yyyy") : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Sent to</span>
              <span className="text-foreground">{sentToValue ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Invoice no.</span>
              <span className="text-foreground">{invoice?.invoice_number ?? "—"}</span>
            </div>
          </div>

          <Separator className="my-2" />

          <div className="px-5 py-5 space-y-3">
            <span className="text-sm text-muted-foreground">Invoice link</span>
            <div className="flex w-full items-start gap-2">
              <div className="relative min-w-0 flex-1">
                <CopyInput
                  value={link ?? "No link yet"}
                  actions={
                    link ? (
                      <Button variant="ghost" size="icon" asChild className="h-8 w-8 text-muted-foreground">
                        <a href={link} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </Button>
                    ) : null
                  }
                />
              </div>
              <Button
                variant="secondary"
                className="size-[38px] hover:bg-secondary shrink-0"
                onClick={() => {
                  if (typeof window !== "undefined") window.print()
                }}
              >
                <Download className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <Accordion type="multiple" className="px-5 pb-8" defaultValue={[]}>
            <AccordionItem value="internal-notes">
              <AccordionTrigger>Internal notes</AccordionTrigger>
              <AccordionContent>
                <div className="space-y-2">
                  <Textarea
                    placeholder="Add internal notes for your team"
                    defaultValue={invoice?.notes ?? ""}
                    className="min-h-[120px]"
                  />
                  <p className="text-xs text-muted-foreground">Clients will not see these notes.</p>
                </div>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="activity">
              <AccordionTrigger>Activity</AccordionTrigger>
              <AccordionContent>
                <div className="space-y-3 text-sm">
                  {activity.length === 0 && <p className="text-muted-foreground">No views yet.</p>}
                  {activity.map((a) => (
                    <div key={a.id} className="border-b pb-2 last:border-b-0 last:pb-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          {format(new Date(a.viewed_at), "MMM d, yyyy, h:mm a")}
                        </span>
                        {a.ip && <span className="text-xs text-muted-foreground">{a.ip}</span>}
                      </div>
                      {a.ua && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.ua}</p>}
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </SheetContent>
    </Sheet>
  )
}
