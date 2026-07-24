import type { PipelineStageKey } from "@/components/prospects/prospect-funnel-bar"

/** How the pipeline surface presents itself. Production orgs get the lot-funnel morph. */
export type PipelineMode = "residential" | "production"

export interface PipelineCommunityOption {
  id: string
  name: string
}

/** Live reservation info keyed by prospect id — drives the Reserved/Converted derived stages. */
export interface ProspectReservationInfo {
  status: "hold" | "reserved" | "converted"
  askingPriceCents: number
  communityName: string | null
  lotLabel: string | null
  expiresAt: string | null
}

export const PRODUCTION_HIDDEN_STATUSES: readonly string[] = [
  "pricing",
  "estimate_sent",
  "changes_requested",
  "client_approved",
  "executed",
]

export function isDerivedStage(key: PipelineStageKey): key is "reserved" | "converted" {
  return key === "reserved" || key === "converted"
}
