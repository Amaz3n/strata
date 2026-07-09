"use client"

import { format } from "date-fns"
import { Download, Eye, FileText } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FILE_CATEGORIES } from "@/components/files/types"
import { logPortalFileAccessClientAction } from "@/app/(app)/documents/actions"
import type { ClientPortalData } from "@/lib/types"

import { unwrapAction } from "@/lib/action-result"

interface PortalDocumentsTabProps {
  data: ClientPortalData
  token: string
  canDownload?: boolean
}

export function PortalDocumentsTab({ data, token, canDownload = true }: PortalDocumentsTabProps) {
  return (
    <div className="space-y-4">
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
                  {file.category && (
                    <Badge variant="secondary" className="mt-1 text-[11px]">
                      {FILE_CATEGORIES[file.category]?.label ?? file.category}
                    </Badge>
                  )}
                </div>
                {file.url ? (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => logPortalFileAccessClientAction(file.id, token, "view")}
                      asChild
                    >
                      <a href={file.url} target="_blank" rel="noopener noreferrer" aria-label={`View ${file.file_name}`}>
                        <Eye className="h-4 w-4" />
                      </a>
                    </Button>
                    {canDownload ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => logPortalFileAccessClientAction(file.id, token, "download")}
                        asChild
                      >
                        <a href={`${file.url}?download=1`} download={file.file_name} aria-label={`Download ${file.file_name}`}>
                          <Download className="h-4 w-4" />
                        </a>
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
