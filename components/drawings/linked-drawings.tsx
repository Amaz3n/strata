"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { getPinsForEntityAction, type DrawingPin, type PinEntityType } from "@/app/(app)/drawings/actions"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Layers, MapPin } from "@/components/icons"

export function LinkedDrawings({
  projectId,
  entityType,
  entityId,
  title = "Linked drawings",
}: {
  projectId: string
  entityType: PinEntityType
  entityId: string
  title?: string
}) {
  const [pins, setPins] = useState<DrawingPin[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    getPinsForEntityAction(entityType, entityId)
      .then((data) => {
        if (!cancelled) setPins(data)
      })
      .catch((error) => console.error("Failed to load drawing pins for entity", error))
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [entityType, entityId])

  const sortedPins = useMemo(() => {
    return [...pins].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
  }, [pins])

  if (isLoading) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Layers className="h-4 w-4 text-muted-foreground" />
            {title}
          </div>
          <Skeleton className="h-8 w-24" />
        </div>
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }

  if (sortedPins.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Layers className="h-4 w-4 text-muted-foreground" />
          {title}
          <Badge variant="secondary" className="text-[11px]">
            {sortedPins.length}
          </Badge>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/projects/${projectId}/drawings`}>Open drawings</Link>
        </Button>
      </div>

      <div className="space-y-1">
        {sortedPins.slice(0, 5).map((pin) => (
          <Button
            key={pin.id}
            asChild
            variant="ghost"
            className="w-full justify-start gap-2 px-2"
          >
            <Link href={`/projects/${projectId}/drawings?sheetId=${pin.drawing_sheet_id}&pinId=${pin.id}`}>
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span className="truncate text-sm">
                {pin.label ?? pin.entity_title ?? "Pinned item"}
              </span>
              {pin.status && (
                <Badge variant="outline" className="ml-auto text-[11px] capitalize">
                  {pin.status.replace(/_/g, " ")}
                </Badge>
              )}
            </Link>
          </Button>
        ))}
        {sortedPins.length > 5 && (
          <div className="text-xs text-muted-foreground px-2">
            +{sortedPins.length - 5} more
          </div>
        )}
      </div>
    </div>
  )
}

