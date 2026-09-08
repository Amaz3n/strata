import "server-only"

import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access"
import { requireBooksWorkspaceEnabled } from "@/lib/services/books/module"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export const GREENFIELD_ATTESTATION = "I confirm Arc Books contains the complete opening position and will be the sole accounting ledger."

async function requireLauncher(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireBooksWorkspaceEnabled(context.orgId)
  await requireAuthorization({ permission: "books.cutover", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "books_settings", resourceId: context.orgId, logDecision: true })
  return context
}

export async function getGreenfieldReadiness(orgId?: string) {
  const context = await requireLauncher(orgId)
  const service = createServiceSupabaseClient()
  const [settings, connections, unmappedBanks, drafts, opening, periods, launch] = await Promise.all([
    service.from("books_settings").select("ledger_authority,arc_ledger_mode").eq("org_id", context.orgId).single(),
    service.from("accounting_connections").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("status", "active"),
    service.from("bank_accounts").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("active", true).is("gl_account_id", null),
    service.from("journal_entries").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("status", "draft"),
    service.from("opening_balance_batches").select("id,status").eq("org_id", context.orgId).eq("status", "posted").limit(1),
    service.from("accounting_periods").select("period_start,period_end").eq("org_id", context.orgId).order("period_start"),
    service.from("books_greenfield_launches").select("id,launched_on,launched_at").eq("org_id", context.orgId).maybeSingle(),
  ])
  const error = settings.error ?? connections.error ?? unmappedBanks.error ?? drafts.error ?? opening.error ?? periods.error ?? launch.error
  if (error) throw new Error(`Failed to evaluate greenfield readiness: ${error.message}`)
  if (!settings.data) throw new Error("Arc Books settings are not initialized")
  const blockers: string[] = []
  if (settings.data.ledger_authority === "arc") blockers.push("Arc Books is already official")
  if ((connections.count ?? 0) > 0) blockers.push("An external accounting connection is active; use the parallel cutover workflow")
  if ((unmappedBanks.count ?? 0) > 0) blockers.push(`${unmappedBanks.count} active bank account(s) are not mapped to the chart`)
  if ((drafts.count ?? 0) > 0) blockers.push(`${drafts.count} draft journal(s) remain unresolved`)
  if ((periods.data ?? []).length === 0) blockers.push("No accounting period exists")
  return { ready: blockers.length === 0, blockers, hasPostedOpeningBalances: (opening.data ?? []).length > 0, periods: periods.data ?? [], existingLaunch: launch.data }
}

export async function launchGreenfieldBooks(input: { launchedOn: string; openingPosition: "zero" | "posted_opening_balances"; attestation: string }, orgId?: string) {
  const context = await requireLauncher(orgId)
  const parsed = z.object({ launchedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), openingPosition: z.enum(["zero","posted_opening_balances"]), attestation: z.literal(GREENFIELD_ATTESTATION) }).parse(input)
  const service = createServiceSupabaseClient()
  const { data, error } = await service.rpc("launch_books_greenfield_atomic", { p_org_id: context.orgId, p_actor_id: context.userId, p_launched_on: parsed.launchedOn, p_opening_position: parsed.openingPosition, p_attestation: parsed.attestation })
  if (error) throw new Error(`Greenfield launch failed: ${error.message}`)
  const id = String(data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "books_settings", entityId: context.orgId, before: { ledgerAuthority: "external" }, after: { ledgerAuthority: "arc", arcLedgerMode: "official", externalSyncPosture: "disconnected", greenfieldLaunchId: id }, source: "books.greenfield" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books_greenfield_launched", entityType: "books_greenfield_launch", entityId: id, payload: { launched_on: parsed.launchedOn, opening_position: parsed.openingPosition } })
  return { id }
}
