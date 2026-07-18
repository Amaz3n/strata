"use client"

import { useTransition, useState } from "react"
import { format } from "date-fns"
import { Download, CheckCircle2, Bell, FileText } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import type { BidPortalAddendum } from "@/lib/services/bid-portal"
import { acknowledgeBidAddendumAction } from "@/app/b/[token]/actions"
import { formatFileSize } from "@/components/bid-portal/lib"

interface BidAddendaTabProps {
  addenda: BidPortalAddendum[]
  token: string
  onAddendaChange?: (addenda: BidPortalAddendum[]) => void
}

export function BidAddendaTab({ addenda, token, onAddendaChange }: BidAddendaTabProps) {
  const [, startAcknowledging] = useTransition()
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
      onAddendaChange?.(updated)
      toast.success("Addendum acknowledged")
      setAcknowledgingId(null)
    })
  }

  if (addenda.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Bell className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
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
            Review and acknowledge every addendum before submitting your bid.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {addenda.map((addendum) => {
            const acknowledged = Boolean(addendum.acknowledged_at)
            return (
              <div key={addendum.id} className="space-y-3 rounded-md border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">Addendum {addendum.number}</span>
                      {acknowledged ? (
                        <Badge
                          variant="outline"
                          className="border-success/30 bg-success/10 text-success"
                        >
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          Acknowledged
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-warning/30 bg-warning/10 text-warning"
                        >
                          Pending
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Issued {format(new Date(addendum.issued_at), "MMMM d, yyyy")}
                    </p>
                  </div>
                </div>

                {addendum.title ? <p className="text-sm font-medium">{addendum.title}</p> : null}

                {addendum.message ? (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{addendum.message}</p>
                ) : null}

                {addendum.files.length > 0 ? (
                  <div className="space-y-2 border-t pt-2">
                    <p className="text-xs font-medium text-muted-foreground">Attachments</p>
                    {addendum.files.map((file) => (
                      <div
                        key={file.id}
                        className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium">{file.file_name}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {formatFileSize(file.size_bytes)}
                            </p>
                          </div>
                        </div>
                        {file.url ? (
                          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" asChild>
                            <a href={file.url} target="_blank" rel="noopener noreferrer">
                              <Download className="h-3.5 w-3.5" />
                            </a>
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {!acknowledged ? (
                  <label className="flex cursor-pointer items-center gap-2 border-t pt-3 text-sm">
                    <Checkbox
                      checked={false}
                      disabled={acknowledgingId === addendum.id}
                      onCheckedChange={() => handleAcknowledge(addendum.id)}
                    />
                    <span className="font-medium">I acknowledge this addendum</span>
                  </label>
                ) : null}
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
