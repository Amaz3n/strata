"use client"

import type React from "react"
import { useMemo, useEffect, useState } from "react"
import { format } from "date-fns"
import { Copy, ExternalLink, Download, RefreshCw } from "lucide-react"

import type { Invoice, InvoiceView } from "@/lib/types"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { QBOSyncBadge } from "@/components/invoices/qbo-sync-badge"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/(app)/files/actions"
import { generateInvoicePdfAction } from "@/app/(app)/invoices/actions"
import { toast } from "sonner"

type Props = {
  trigger?: React.ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice?: Invoice | null
  link?: string
  views?: InvoiceView[]
  syncHistory?: Array<{ id: string; status: string; last_synced_at: string; error_message?: string | null; qbo_id?: string | null }>
  loading?: boolean
  onCopyLink?: () => void
  onManualResync?: () => Promise<void>
  manualResyncing?: boolean
  onEdit?: () => void
}

function formatMoneyFromCents(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

async function openPdfUrl(url: string, fileName?: string) {
  const response = await fetch(url, { credentials: "include", cache: "no-store" })
  if (!response.ok) {
    throw new Error("Unable to open generated PDF")
  }
  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const popup = window.open(objectUrl, "_blank", "noopener,noreferrer")
  if (!popup) {
    const link = document.createElement("a")
    link.href = objectUrl
    link.download = fileName || "invoice.pdf"
    document.body.appendChild(link)
    link.click()
    link.remove()
  }
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
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

export function InvoiceDetailSheet({
  trigger,
  open,
  onOpenChange,
  invoice,
  link,
  views,
  syncHistory,
  loading,
  onCopyLink,
  onManualResync,
  manualResyncing,
  onEdit,
}: Props) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [pdfLoading, setPdfLoading] = useState(false)

  useEffect(() => {
    if (!open || !invoice?.id) return
    setAttachmentsLoading(true)
    listAttachmentsAction("invoice", invoice.id)
      .then((links) =>
        setAttachments(
          links.map((link) => ({
            id: link.file.id,
            linkId: link.id,
            file_name: link.file.file_name,
            mime_type: link.file.mime_type,
            size_bytes: link.file.size_bytes,
            download_url: link.file.download_url,
            thumbnail_url: link.file.thumbnail_url,
            created_at: link.created_at,
            link_role: link.link_role,
          }))
        )
      )
      .catch((error) => console.error("Failed to load invoice attachments", error))
      .finally(() => setAttachmentsLoading(false))
  }, [open, invoice?.id])

  const handleAttach = async (files: File[], linkRole?: string) => {
    if (!invoice) return
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      if (invoice.project_id) {
        formData.append("projectId", invoice.project_id)
      }
      formData.append("category", "financials")

      const uploaded = await uploadFileAction(formData)
      await attachFileAction(uploaded.id, "invoice", invoice.id, invoice.project_id ?? undefined, linkRole)
    }

    const links = await listAttachmentsAction("invoice", invoice.id)
    setAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      }))
    )
  }

  const handleDetach = async (linkId: string) => {
    if (!invoice) return
    await detachFileLinkAction(linkId)
    const links = await listAttachmentsAction("invoice", invoice.id)
    setAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      }))
    )
  }

  const loadingView = (
    <div className="px-5 pt-6 pb-4 space-y-4 animate-pulse">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-full bg-muted" />
          <div className="flex flex-col gap-1">
            <div className="h-3 w-32 rounded bg-muted" />
            <div className="h-3 w-24 rounded bg-muted" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-6 w-16 rounded bg-muted" />
          <div className="h-6 w-16 rounded bg-muted" />
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <div className="h-8 w-24 rounded bg-muted" />
        <div className="grid grid-cols-2 gap-3">
          <div className="h-9 rounded bg-muted" />
          <div className="h-9 rounded bg-muted" />
        </div>
      </div>
      <div className="space-y-3">
        {[...Array(4)].map((_, idx) => (
          <div key={idx} className="flex items-center justify-between text-sm text-muted-foreground">
            <span className="h-3 w-20 rounded bg-muted" />
            <span className="h-3 w-24 rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )

  const subtotal = invoice?.totals?.subtotal_cents ?? invoice?.subtotal_cents ?? 0
  const tax = invoice?.totals?.tax_cents ?? invoice?.tax_cents ?? 0
  const total = invoice?.totals?.total_cents ?? invoice?.total_cents ?? subtotal + tax
  const metadata = (invoice?.metadata as Record<string, any>) ?? {}
  const sentToArray = invoice?.sent_to_emails ?? (metadata.sent_to ?? metadata.sentTo ?? []) ?? []
  const customerName = (invoice?.customer_name as string | undefined) ?? metadata.customer_name ?? sentToArray?.[0] ?? "Customer"
  const customerInitial = customerName?.[0] ?? "C"
  const numberAdjustedByQbo = Boolean(metadata.invoice_number_changed)
  const previousInvoiceNumber = metadata.invoice_number_previous as string | undefined
  const sentAtValue = (invoice as any)?.sent_at ?? metadata.sent_at ?? metadata.sentAt
  const sentToValue =
    typeof sentToArray === "string"
      ? sentToArray
      : Array.isArray(sentToArray)
        ? sentToArray.filter(Boolean).join(", ")
        : undefined

  const activity = useMemo(() => {
    return (views ?? []).map((v) => ({
      id: v.id,
      viewed_at: v.viewed_at,
      ip: v.ip_address,
      ua: v.user_agent,
    }))
  }, [views])

  const syncLogs = useMemo(() => {
    return (syncHistory ?? []).map((item) => ({
      id: item.id,
      status: item.status,
      last_synced_at: item.last_synced_at,
      error: item.error_message,
      qbo_id: item.qbo_id,
    }))
  }, [syncHistory])

  const handleDownloadPdf = async () => {
    if (!invoice?.id) return
    setPdfLoading(true)
    try {
      const result = await generateInvoicePdfAction(invoice.id, { persistToArc: true })
      if (result.downloadUrl && typeof window !== "undefined") {
        await openPdfUrl(result.downloadUrl, result.fileName)
      }
      toast.success("Invoice PDF saved to Arc")
    } catch (error: any) {
      toast.error("Failed to generate invoice PDF", { description: error?.message ?? "Please try again." })
    } finally {
      setPdfLoading(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] overflow-hidden shadow-2xl flex flex-col bg-white dark:bg-[#0C0C0C] gap-0 [&>button]:hidden fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 pt-6 pb-4 space-y-4">
            {loading ? (
              loadingView
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Avatar className="size-9">
                      <AvatarFallback className="text-xs font-medium">{customerInitial}</AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                      <span className="text-base font-semibold leading-tight line-clamp-1">{customerName}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {invoice?.qbo_sync_status && (
                      <QBOSyncBadge
                        status={invoice.qbo_sync_status}
                        syncedAt={invoice.qbo_synced_at ?? undefined}
                        qboId={invoice.qbo_id ?? undefined}
                      />
                    )}
                    {invoice?.status && <Badge className="capitalize">{invoice.status}</Badge>}
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  <span className="text-4xl font-semibold leading-none select-text">{formatMoneyFromCents(total)}</span>
                  <div className="grid grid-cols-2 gap-3">
                    <Button type="button" variant="secondary" size="sm" className="w-full justify-center">
                      Remind
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full justify-center"
                      onClick={onEdit}
                      disabled={!onEdit}
                    >
                      Edit
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>

          <Separator className="my-4" />

          {loading ? (
            <div className="px-5 py-5 space-y-3 animate-pulse">
              {[...Array(5)].map((_, idx) => (
                <div key={idx} className="flex items-center justify-between text-sm text-muted-foreground">
                  <span className="h-3 w-24 rounded bg-muted" />
                  <span className="h-3 w-28 rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : (
            <div className="px-5 py-5 space-y-4">
            {numberAdjustedByQbo && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Invoice number updated after a QuickBooks conflict
                {previousInvoiceNumber ? ` (previous: ${previousInvoiceNumber}).` : "."}
              </div>
            )}
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
          )}

          <Separator className="my-2" />

          {loading ? (
            <div className="px-5 py-5 space-y-3 animate-pulse">
              <div className="h-3 w-24 rounded bg-muted" />
              <div className="h-9 rounded bg-muted" />
              <div className="flex items-center justify-between mt-2">
                <span className="h-3 w-24 rounded bg-muted" />
                <span className="h-8 w-24 rounded bg-muted" />
              </div>
              <div className="space-y-2">
                {[...Array(2)].map((_, idx) => (
                  <div key={idx} className="h-14 rounded border bg-muted/30" />
                ))}
              </div>
            </div>
          ) : (
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
                  onClick={handleDownloadPdf}
                  disabled={pdfLoading || !invoice?.id}
                >
                  <Download className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">QuickBooks sync</span>
                {onManualResync && (
                  <Button size="sm" variant="outline" onClick={onManualResync} disabled={manualResyncing}>
                    <RefreshCw className={`h-4 w-4 mr-2 ${manualResyncing ? "animate-spin" : ""}`} />
                    {manualResyncing ? "Syncing..." : "Sync now"}
                  </Button>
                )}
              </div>
              {syncLogs && syncLogs.length > 0 ? (
                <div className="space-y-2">
                  {syncLogs.map((log) => (
                    <div key={log.id} className="rounded-md border px-3 py-2 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium capitalize">{log.status}</span>
                        <span className="text-xs text-muted-foreground">
                          {log.last_synced_at ? new Date(log.last_synced_at).toLocaleString() : "—"}
                        </span>
                      </div>
                      {log.qbo_id && (
                        <p className="text-xs text-muted-foreground mt-1">QBO ID: {log.qbo_id}</p>
                      )}
                      {log.error && <p className="text-xs text-destructive mt-1">{log.error}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No syncs yet.</p>
              )}
            </div>
          )}

          {!loading && (
            <Accordion type="multiple" className="px-5 pb-8" defaultValue={[]}>
              <AccordionItem value="attachments">
                <AccordionTrigger>Attachments</AccordionTrigger>
                <AccordionContent>
                  <EntityAttachments
                    entityType="invoice"
                    entityId={invoice?.id ?? ""}
                    projectId={invoice?.project_id ?? undefined}
                    attachments={attachments}
                    onAttach={handleAttach}
                    onDetach={handleDetach}
                    readOnly={attachmentsLoading}
                    compact
                  />
                </AccordionContent>
              </AccordionItem>
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
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
