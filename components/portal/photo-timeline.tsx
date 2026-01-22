"use client"

import { useState } from "react"
import { format } from "date-fns"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type { PhotoTimelineEntry, Photo } from "@/lib/types"

interface PhotoTimelineProps {
  entries: PhotoTimelineEntry[]
}

export function PhotoTimeline({ entries }: PhotoTimelineProps) {
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null)

  if (entries.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p>No photos yet</p>
        <p className="text-sm">Photos from daily logs will appear here</p>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-4">
        {entries.map((entry, idx) => (
          <Card key={idx}>
            <CardContent className="p-4 space-y-3">
              <h3 className="text-sm font-medium">
                Week of {format(new Date(entry.week_start), "MMM d")} - {format(new Date(entry.week_end), "MMM d")}
              </h3>

              <div className="grid grid-cols-3 gap-2">
                {entry.photos.slice(0, 6).map((photo) => (
                  <button
                    key={photo.id}
                    onClick={() => setSelectedPhoto(photo)}
                    className="aspect-square rounded-md overflow-hidden bg-muted"
                  >
                    <img
                      src={photo.url}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
                {entry.photos.length > 6 && (
                  <div className="aspect-square rounded-md bg-muted flex items-center justify-center text-sm text-muted-foreground">
                    +{entry.photos.length - 6} more
                  </div>
                )}
              </div>

              {entry.log_summaries.length > 0 && (
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {entry.log_summaries[0]}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!selectedPhoto} onOpenChange={() => setSelectedPhoto(null)}>
        <DialogContent className="max-w-3xl p-0">
          <DialogTitle className="sr-only">Photo preview</DialogTitle>
          {selectedPhoto && (
            <img
              src={selectedPhoto.url}
              alt=""
              className="w-full h-auto"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
