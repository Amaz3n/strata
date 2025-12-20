"use client"

import { PhotoTimeline } from "@/components/portal/photo-timeline"
import type { ClientPortalData } from "@/lib/types"

interface PortalTimelineTabProps {
  data: ClientPortalData
}

export function PortalTimelineTab({ data }: PortalTimelineTabProps) {
  return <PhotoTimeline entries={data.photos} />
}
