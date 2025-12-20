"use client"

import { format } from "date-fns"
import { FileText } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { ClientPortalData } from "@/lib/types"

interface PortalDocumentsTabProps {
  data: ClientPortalData
  token: string
  portalType: "client" | "sub"
}

export function PortalDocumentsTab({ data, token, portalType }: PortalDocumentsTabProps) {
  const basePath = portalType === "client" ? "p" : "s"

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Invoices</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet</p>
          ) : (
            data.invoices.map((inv) => (
              <a
                key={inv.id}
                href={inv.token ? `/i/${inv.token}` : `/${basePath}/${token}/invoices/${inv.id}`}
                className="flex items-center justify-between py-3 border-b last:border-0 hover:bg-muted/50 -mx-2 px-2 rounded"
              >
                <div>
                  <p className="text-sm font-medium">{inv.invoice_number}</p>
                  <p className="text-xs text-muted-foreground">{inv.title}</p>
                </div>
                <div className="text-right">
                  <Badge variant="outline" className="capitalize text-xs mb-1">
                    {inv.status}
                  </Badge>
                  {inv.total_cents != null && (
                    <p className="text-sm font-medium">${(inv.total_cents / 100).toLocaleString()}</p>
                  )}
                </div>
              </a>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Shared Files</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.sharedFiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">No files shared yet</p>
          ) : (
            data.sharedFiles.map((file) => (
              <div key={file.id} className="flex items-center gap-3 py-2 border-b last:border-0">
                <FileText className="h-8 w-8 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.file_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(file.created_at), "MMM d, yyyy")}
                  </p>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
