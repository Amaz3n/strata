"use client"

import { useState, useTransition } from "react"
import { format } from "date-fns"
import { Download, CheckCircle2, Bell, FileText } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { BidPortalAddendum } from "@/lib/services/bid-portal"
import { acknowledgeBidAddendumAction } from "@/app/b/[token]/actions"

interface BidAddendaTabProps {
  addenda: BidPortalAddendum[]
  token: string
  onAddendaChange?: (addenda: BidPortalAddendum[]) => void
}

function formatFileSize(bytes?: number) {
  if (!bytes) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function BidAddendaTab({ addenda: initialAddenda, token, onAddendaChange }: BidAddendaTabProps) {
  const [addenda, setAddenda] = useState(initialAddenda)
  const [isAcknowledging, startAcknowledging] = useTransition()
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null)

  const handleAcknowledge = (addendumId: string) => {
    setAcknowledgingId(addendumId)
    startAcknowledging(async () => {
      const result = await acknowledgeBidAddendumAction({ token, addendumId })
      if (!result.success) {
        toast.error(result.error ?? "Failed to acknowledge addendum")
        setAcknowledgingId(null)
        return
      }
      const updated = addenda.map((item) =>
        item.id === addendumId
          ? { ...item, acknowledged_at: result.acknowledged_at ?? new Date().toISOString() }
          : item
      )
      setAddenda(updated)
      onAddendaChange?.(updated)
      toast.success("Addendum acknowledged")
      setAcknowledgingId(null)
    })
  }

  if (addenda.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Bell className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
          <p className="text-sm text-muted-foreground">No addenda have been issued for this bid package.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Addenda</CardTitle>
          <p className="text-sm text-muted-foreground">
            Review and acknowledge all addenda before submitting your bid
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {addenda.map((addendum) => (
            <div
              key={addendum.id}
              className="rounded-lg border p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">Addendum {addendum.number}</span>
                    {addendum.acknowledged_at ? (
                      <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Acknowledged
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                        Pending
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Issued {format(new Date(addendum.issued_at), "MMMM d, yyyy")}
                  </p>
                </div>
              </div>

              {addendum.title && (
                <p className="text-sm font-medium">{addendum.title}</p>
              )}

              {addendum.message && (
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{addendum.message}</p>
              )}

              {addendum.files.length > 0 && (
                <div className="space-y-2 pt-2 border-t">
                  <p className="text-xs font-medium text-muted-foreground">Attachments</p>
                  {addendum.files.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs font-medium truncate">{file.file_name}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {formatFileSize(file.size_bytes)}
                          </p>
                        </div>
                      </div>
                      {file.url && (
                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" asChild>
                          <a href={file.url} target="_blank" rel="noopener noreferrer">
                            <Download className="h-3.5 w-3.5" />
                          </a>
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {!addendum.acknowledged_at && (
                <Button
                  size="sm"
                  onClick={() => handleAcknowledge(addendum.id)}
                  disabled={isAcknowledging && acknowledgingId === addendum.id}
                >
                  {isAcknowledging && acknowledgingId === addendum.id
                    ? "Acknowledging..."
                    : "Acknowledge Addendum"}
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
