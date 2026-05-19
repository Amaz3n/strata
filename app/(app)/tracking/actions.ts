"use server"

import { headers } from "next/headers"

import { requireOrgMembership } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const DEFAULT_TRACKED_DEMO_ORG_IDS = ["7982e17e-501e-4640-b410-f6d2385391f8"]
const DEFAULT_TRACKED_DEMO_EMAILS = ["demo@arcnaples.com"]

function trackedDemoOrgIds() {
  const configured = process.env.DEMO_USAGE_TRACKING_ORG_IDS
  if (!configured) return DEFAULT_TRACKED_DEMO_ORG_IDS
  return configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

function trackedDemoEmails() {
  const configured = process.env.DEMO_USAGE_TRACKING_EMAILS
  const emails = configured ? configured.split(",") : DEFAULT_TRACKED_DEMO_EMAILS
  return emails
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

function normalizePathname(pathname: string) {
  const cleaned = pathname.trim()
  if (!cleaned.startsWith("/")) return `/${cleaned}`
  return cleaned
}

function routeLabel(pathname: string) {
  if (pathname === "/") return "Dashboard"
  if (pathname === "/projects") return "Projects"
  if (pathname.includes("/financials")) return "Project financials"
  if (pathname.includes("/budget")) return "Project budget"
  if (pathname.includes("/drawings")) return "Drawings"
  if (pathname.includes("/bids")) return "Bids"
  if (pathname.includes("/schedule")) return "Schedule"
  if (pathname.includes("/daily-logs")) return "Daily logs"
  if (pathname.includes("/documents")) return "Documents"
  if (pathname.includes("/rfis")) return "RFIs"
  if (pathname.includes("/submittals")) return "Submittals"
  if (pathname.includes("/settings")) return "Settings"
  return pathname
    .split("/")
    .filter(Boolean)
    .slice(-1)[0]
    ?.replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase()) ?? "App"
}

export async function recordDemoPageViewAction(pathname: string) {
  const normalizedPathname = normalizePathname(pathname)
  const { orgId, user } = await requireOrgMembership()

  if (!trackedDemoOrgIds().includes(orgId) || !trackedDemoEmails().includes((user.email ?? "").toLowerCase())) {
    return { tracked: false }
  }

  const headerStore = await headers()
  const userAgent = headerStore.get("user-agent") ?? null
  const referer = headerStore.get("referer") ?? null

  const supabase = createServiceSupabaseClient()
  const { error } = await supabase.from("events").insert({
    org_id: orgId,
    event_type: "demo_page_view",
    entity_type: "usage",
    payload: {
      actor_id: user.id,
      actor_email: user.email ?? null,
      path: normalizedPathname,
      label: routeLabel(normalizedPathname),
      user_agent: userAgent,
      referer,
    },
    channel: "activity",
  })

  if (error) {
    console.error("Failed to record demo page view", error)
    return { tracked: false }
  }

  return { tracked: true }
}
