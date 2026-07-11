import type { ProjectPosture } from "@/lib/product-tier"

export const PROJECT_MODULES = [
  { key: "documents", label: "Documents", description: "Project files and document controls." },
  { key: "drawings", label: "Drawings", description: "Drawing sets, revisions, and markups." },
  { key: "bids", label: "Bids", description: "Bid packages, invitations, and leveling." },
  { key: "signatures", label: "Signatures", description: "Project e-signature envelopes." },
  { key: "schedule", label: "Schedule", description: "Project schedule and milestones." },
  { key: "daily_logs", label: "Daily logs", description: "Field activity and daily reporting." },
  { key: "time", label: "Time", description: "Project time entry and approvals." },
  { key: "punch", label: "Punch", description: "Punch-list tracking and closeout work." },
  { key: "rfis", label: "RFIs", description: "Requests for information and responses." },
  { key: "submittals", label: "Submittals", description: "Submittal register and revisions." },
  { key: "meetings", label: "Meeting minutes", description: "OAC and project meeting minutes." },
  { key: "transmittals", label: "Transmittals", description: "Tracked project document distributions." },
  { key: "inspections", label: "Inspections", description: "Safety and quality checklist inspections." },
  { key: "safety", label: "Safety", description: "Incidents, toolbox talks, and observations." },
  { key: "decisions", label: "Decisions", description: "Owner decisions and approvals." },
  { key: "closeout", label: "Closeout", description: "Closeout documents and completion." },
  { key: "warranty", label: "Warranty", description: "Warranty requests and dispatch." },
] as const

export type ProjectModuleKey = (typeof PROJECT_MODULES)[number]["key"]

export function isProjectModuleKey(value: unknown): value is ProjectModuleKey {
  return PROJECT_MODULES.some((module) => module.key === value)
}

export function isProjectModuleEnabled({
  moduleKey,
  posture,
  overrides,
  postures,
}: {
  moduleKey: ProjectModuleKey
  posture: ProjectPosture
  overrides?: Record<string, boolean>
  postures?: ProjectPosture[]
}) {
  return overrides?.[moduleKey] ?? (!postures || postures.includes(posture))
}
