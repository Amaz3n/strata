import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { authorizeMany, getProjectReadScopeForUser } from "@/lib/services/authorization"
import { deliverTradeNotice, resolveTradePortalLink, type TradeNoticeDraft } from "@/lib/services/trade-notices"
import { readAllRowsById } from "@/lib/land/paging"
import { SCHEDULE_DIGEST_WINDOW_MS, scheduleDigestKey } from "@/lib/starts/even-flow-math"
import {
  LOOKAHEAD_EXCLUDED_STATUSES, LOOKAHEAD_HOME_STATUSES, LOOKAHEAD_PO_STATUSES, lookaheadDedupeKey, lookaheadWindow, releaseNoticeDedupeKey,
  scheduleChangeDedupeKey,
} from "@/lib/starts/lookahead-rules"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { lookaheadSchema, tradeLookaheadWorkspaceSchema, tradeSchedulePageSchema, tradeWorkspaceReplySchema } from "@/lib/validation/starts"

const scheduleDigestChangesSchema = z.array(z.object({
  schedule_item_id: z.string(), name: z.string().default("Scheduled work"),
  old_start: z.string().nullable(), new_start: z.string().nullable(),
}))

export interface TradeLookaheadRow {
  companyId: string | null
  companyName: string
  trade: string | null
  items: Array<{
    scheduleItemId: string
    projectId: string
    lotLabel: string
    communityName: string
    name: string
    startDate: string
    endDate: string
    status: string
    /** `inferred`: the only vendor with an approved purchase order for this cost code, never assigned. */
    assignment: "assigned" | "inferred" | "unassigned"
    confirmation: "unsent" | "sent" | "confirmed" | "declined"
  }>
}

function one(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === "object" ? row as Record<string, unknown> : null
}

function text(value: unknown) {
  return typeof value === "string" ? value : null
}

async function companyRecipients(supabase: SupabaseClient, orgId: string, companyId: string) {
  // contact_company_links is the only person-to-company link.
  const links = await readAllRowsById((after, take) => {
    let query = supabase.from("contact_company_links").select("id,contact:contacts!inner(org_id,email)")
      .eq("org_id", orgId).eq("company_id", companyId).eq("contact.org_id", orgId)
    if (after) query = query.gt("id", after)
    return query.order("id").limit(take)
  }, { cap: 10000, label: "Failed to load trade contacts" })
  return Array.from(new Set(links.flatMap((link) => {
    const email = text(one(link.contact)?.email)
    return email ? [email] : []
  })))
}

async function loadTradeLookahead(
  input: { weeks: 2 | 3 | 4; communityId?: string; divisionId?: string; companyId?: string; projectId?: string; page?: number; pageSize?: number },
  orgId?: string,
): Promise<TradeLookaheadRow[]> {
  const parsed = lookaheadSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const access = await getProjectReadScopeForUser(context)
  // Authorized above. The schedule's row security admits only project members
  // and org admins, which would show a starts coordinator or purchasing
  // manager an empty look-ahead; the division and membership predicates below
  // are the scope.
  const reader = createServiceSupabaseClient()
  const divisions = parsed.divisionId ? access.divisionIds === null || access.divisionIds.includes(parsed.divisionId) ? [parsed.divisionId] : [] : access.divisionIds
  if (divisions !== null && !divisions.length) return []
  const lot = `lot:lots!lots_project_id_fkey${parsed.communityId ? "!inner" : ""}(org_id,lot_number,block,community_id,community:communities${parsed.communityId ? "!inner" : ""}(org_id,name))`
  const projectSelect = `project:projects!inner(property_type,status,${lot}${access.projectMembershipRequired ? ",access:project_members!project_members_project_id_fkey!inner(id)" : ""})`
  const { start, end } = lookaheadWindow(new Date(), parsed.weeks)
  // The lot hangs off the project, not off the schedule item — there is no
  // schedule_items → lots foreign key to embed through. The project owns the
  // lot filter; its join is inner only for an explicit community lens.
  // Unscoped work keeps projects without lots, while scoped queries narrow early.
  const candidates = await readAllRowsById(async (after, take) => {
    let query = reader.from("schedule_items").select(`
    id,project_id,name,trade,status,start_date,end_date,cost_code_id,
    ${projectSelect},
    assignments:schedule_assignments(company_id,confirmed_at,company:companies(name))
  `).eq("org_id", context.orgId).eq("project.org_id", context.orgId)
      .eq("project.property_type", "production").in("project.status", [...LOOKAHEAD_HOME_STATUSES])
      .lte("start_date", end).or(`end_date.gte.${start},and(end_date.is.null,start_date.gte.${start})`)
      .not("status", "in", `(${LOOKAHEAD_EXCLUDED_STATUSES.join(",")})`)
    if (parsed.projectId) query = query.eq("project_id", parsed.projectId)
    if (divisions !== null) query = query.in("project.division_id", divisions)
    if (access.projectMembershipRequired) query = query.eq("project.access.org_id", context.orgId).eq("project.access.user_id", context.userId).eq("project.access.status", "active")
    if (parsed.communityId) query = query.eq("project.lot.org_id", context.orgId).eq("project.lot.community.org_id", context.orgId).eq("project.lot.community_id", parsed.communityId)
    if (after) query = query.gt("id", after)
    const result = await query.order("id").limit(take)
    if (result.error) return { data: null, error: result.error }
    return { data: tradeSchedulePageSchema.parse(result.data), error: null }
  }, { cap: 100000, label: "Failed to load trade look-ahead; narrow the community or schedule window" })
  // The reads above run unscoped by row security, so project.read is decided
  // here by the same policy as authorize(): explicit denies, division and
  // project-member scope, and per-house grants all apply, as in the SQL twin.
  const verdicts = await authorizeMany({
    permission: "project.read", userId: context.userId, orgId: context.orgId,
    projectIds: Array.from(new Set(candidates.map((item) => item.project_id))),
  })
  const items = candidates.filter((item) => verdicts.get(item.project_id) === true)
  items.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id.localeCompare(b.id))
  const unresolved = items.filter((item) => !(item.assignments ?? []).some((assignment: { company_id?: string | null }) => assignment.company_id) && item.cost_code_id)
  const projectIds = Array.from(new Set(unresolved.map((item) => item.project_id)))
  const costsByProject = new Map<string, Set<string>>()
  for (const item of unresolved) {
    if (!item.cost_code_id) continue
    const costs = costsByProject.get(item.project_id) ?? new Set<string>()
    costs.add(item.cost_code_id)
    costsByProject.set(item.project_id, costs)
  }
  const vendorsByProjectCost = new Map<string, Map<string, { id: string; name: string }>>()
  for (let offset = 0; offset < projectIds.length; offset += 100) {
    const batch = projectIds.slice(offset, offset + 100)
    const costCodeIds = Array.from(new Set(batch.flatMap((id) => Array.from(costsByProject.get(id) ?? []))))
    for (let costOffset = 0; costOffset < costCodeIds.length; costOffset += 100) {
      const commitments = await readAllRowsById((after, take) => {
        let query = reader.from("commitment_lines").select("id,cost_code_id,commitment:commitments!inner(project_id,company_id,company:companies(name),commitment_type)")
          .eq("org_id", context.orgId).eq("commitment.org_id", context.orgId)
          .in("commitment.project_id", batch).in("cost_code_id", costCodeIds.slice(costOffset, costOffset + 100))
          .eq("commitment.commitment_type", "purchase_order").in("commitment.status", [...LOOKAHEAD_PO_STATUSES])
        if (after) query = query.gt("id", after)
        return query.order("id").limit(take)
      }, { cap: 100000, label: "Failed to load look-ahead purchase orders" })
      for (const line of commitments) {
        const commitment = one(line.commitment)
        const company = one(commitment?.company)
        if (commitment?.company_id && typeof commitment.project_id === "string") {
          if (!batch.includes(commitment.project_id)) throw new Error("Look-ahead purchase order belongs to an unexpected home")
          const key = `${commitment.project_id}:${line.cost_code_id}`
          const vendors = vendorsByProjectCost.get(key) ?? new Map<string, { id: string; name: string }>()
          vendors.set(String(commitment.company_id), { id: String(commitment.company_id), name: String(company?.name ?? "Trade company") })
          vendorsByProjectCost.set(key, vendors)
        }
      }
    }
  }
  const groups = new Map<string, TradeLookaheadRow>()
  for (const item of items ?? []) {
    const itemLot = one(one(item.project)?.lot)
    if (parsed.communityId && text(itemLot?.community_id) !== parsed.communityId) continue
    const assigned = (item.assignments ?? []).filter((row: { company_id?: string | null }) => row.company_id)
    const seenCompanies = new Set<string | null>()
    for (const assignment of assigned.length ? assigned : [null]) {
      const assignedCompany = assignment ? one(assignment.company) : null
      const possibleVendors = item.cost_code_id ? vendorsByProjectCost.get(`${item.project_id}:${item.cost_code_id}`) : undefined
      // Multiple PO vendors are not an assignment. Keep the task unassigned so
      // the coordinator fixes its original schedule rather than emailing a guess.
      // A single vendor is a guess too, and is marked as one.
      const fallback = possibleVendors?.size === 1 ? possibleVendors.values().next().value : undefined
      const companyId = assignment?.company_id ?? fallback?.id ?? null
      if (seenCompanies.has(companyId)) continue
      seenCompanies.add(companyId)
      if (parsed.companyId && companyId !== parsed.companyId) continue
      const companyName = assignedCompany?.name ? String(assignedCompany.name) : fallback?.name ?? "Unassigned"
      const key = `${companyId ?? "unassigned"}:${item.trade ?? ""}`
      const lot = itemLot
      const community = one(lot?.community)
      const row: TradeLookaheadRow = groups.get(key) ?? { companyId, companyName, trade: item.trade, items: [] }
      row.items.push({
        scheduleItemId: item.id, projectId: item.project_id,
        lotLabel: lot?.block ? `${lot.block}-${lot.lot_number}` : String(lot?.lot_number ?? "Lot"),
        communityName: String(community?.name ?? "Community"), name: item.name, startDate: item.start_date,
        endDate: item.end_date ?? item.start_date, status: item.status,
        assignment: companyId === null ? "unassigned" : assignment?.company_id ? "assigned" : "inferred",
        confirmation: assignment?.confirmed_at ? "confirmed" : "unsent",
      })
      groups.set(key, row)
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.companyName.localeCompare(b.companyName)
    || (a.companyId ?? "").localeCompare(b.companyId ?? "") || (a.trade ?? "").localeCompare(b.trade ?? ""))
}

export async function getTradeLookahead(
  input: { weeks: 2 | 3 | 4; communityId?: string; divisionId?: string; companyId?: string; page?: number; pageSize?: number },
  orgId?: string,
): Promise<{ rows: TradeLookaheadRow[]; total: number }> {
  const parsed = lookaheadSchema.parse(input)
  const all = await loadTradeLookahead(parsed, orgId)
  const offset = (parsed.page - 1) * parsed.pageSize
  return { rows: all.slice(offset, offset + parsed.pageSize), total: all.length }
}

export interface TradeLookaheadSummary {
  key: string
  companyId: string | null
  companyName: string
  trade: string | null
  itemCount: number
  confirmedCount: number
  inferredCount: number
  firstDate: string | null
}

/** Original read owner; summaries avoid serializing every task into the desk. */
export async function getTradeLookaheadWorkspace(input: unknown, orgId?: string) {
  const parsed = tradeLookaheadWorkspaceSchema.parse(input)
  if (process.env.ARC_TRADE_DATABASE_WORKSPACE_ENABLED === "true") {
    const context = await requireOrgContext(orgId)
    await requirePermission("start.read", context)
    const { data, error } = await context.supabase.rpc("read_trade_lookahead_workspace", {
      p_org: context.orgId, p_actor: context.userId, p_weeks: parsed.weeks,
      p_division: parsed.divisionId ?? null, p_community: parsed.communityId ?? null,
      p_q: parsed.q, p_page: parsed.page, p_group: parsed.group ?? null, p_item_page: parsed.itemPage,
    })
    if (error) throw new Error(`Failed to load database trade workspace: ${error.message}`)
    const page = tradeWorkspaceReplySchema.parse(data)
    const expectedRows = Math.min(50, Math.max(0, page.total - (parsed.page - 1) * 50))
    const sameScope = page.orgId === context.orgId && page.actorId === context.userId && page.divisionId === (parsed.divisionId ?? null) && page.communityId === (parsed.communityId ?? null)
    const sameQuery = page.weeks === parsed.weeks && page.q === parsed.q && page.page === parsed.page && page.group === (parsed.group ?? null) && page.itemPage === parsed.itemPage
    const summaries = [...page.rows, ...(page.selected ? [page.selected] : [])]
    const validSummaries = summaries.every(row => row.key === JSON.stringify([row.companyId,row.trade]) && row.confirmedCount <= row.itemCount)
    const validSelection = page.selected ? page.selected.key === parsed.group && !page.selectedUnavailable && page.selected.items.length === Math.min(50, Math.max(0, page.selected.itemCount - (parsed.itemPage - 1) * 50)) && new Set(page.selected.items.map(item => item.scheduleItemId)).size === page.selected.items.length : page.selectedUnavailable === Boolean(parsed.group)
    if (!sameScope || !sameQuery || !validSummaries || !validSelection || page.rows.length !== expectedRows || new Set(page.rows.map(row => row.key)).size !== page.rows.length) throw new Error("Database trade workspace reply differs from the reviewed scope or page")
    return page
  }
  const all = await loadTradeLookahead(parsed, orgId)
  const key = (row: TradeLookaheadRow) => JSON.stringify([row.companyId, row.trade])
  const matching = all.filter(row => `${row.companyName} ${row.trade ?? ""}`.toLowerCase().includes(parsed.q.toLowerCase()))
  const summarize = (row: TradeLookaheadRow): TradeLookaheadSummary => ({
    key: key(row), companyId: row.companyId, companyName: row.companyName, trade: row.trade,
    itemCount: row.items.length, confirmedCount: row.items.filter(item => item.confirmation === "confirmed").length,
    inferredCount: row.items.filter(item => item.assignment === "inferred").length,
    firstDate: row.items[0]?.startDate ?? null,
  })
  const selected = parsed.group ? all.find(row => key(row) === parsed.group) : undefined

  const pageSize = 50, itemPageSize = 50
  return {
    rows: matching.slice((parsed.page - 1) * pageSize, parsed.page * pageSize).map(summarize),
    total: matching.length, page: parsed.page, pageSize,
    selectedUnavailable: Boolean(parsed.group && !selected),
    selected: selected ? { ...summarize(selected), items: selected.items.slice((parsed.itemPage - 1) * itemPageSize, parsed.itemPage * itemPageSize) } : null,
    itemPage: parsed.itemPage, itemPageSize,
  }
}

type NoticeContext = { supabase: SupabaseClient; orgId: string }

async function companyRowsFor(companyId: string, opts: { weeks: 2 | 3 | 4; communityId?: string; divisionId?: string; projectId?: string }, orgId: string) {
  const rows = await loadTradeLookahead({ ...opts, companyId }, orgId)
  // Only work the company was actually given goes in a notice; an item inferred
  // from a purchase order waits for a coordinator to assign it.
  return rows.filter((row) => row.companyId === companyId).flatMap((row) => row.items.filter((item) => item.assignment === "assigned").map((item) => ({ row, item })))
}

async function lookaheadDraft(
  context: NoticeContext, companyId: string, opts: { weeks: 2 | 3 | 4; communityId?: string; divisionId?: string; projectId?: string },
  entries: Awaited<ReturnType<typeof companyRowsFor>>,
): Promise<TradeNoticeDraft> {
  const recipients = await companyRecipients(context.supabase, context.orgId, companyId)
  if (!recipients.length) throw new Error("This trade company has no email contacts.")
  const projectIds = new Set(entries.map(({ item }) => item.projectId))
  const [{ data: org, error: orgError }, link] = await Promise.all([
    context.supabase.from("orgs").select("name,slug,logo_url").eq("id", context.orgId).maybeSingle(),
    resolveTradePortalLink(context.supabase, context.orgId, companyId, projectIds.size === 1 ? entries[0].item.projectId : null),
  ])
  if (orgError) throw new Error(`Failed to load organization for trade notice: ${orgError.message}`)
  const title = `${opts.weeks}-week trade look-ahead`
  return {
    subject: title, recipients,
    snapshot: {
      title, intro: `Upcoming scheduled work for ${entries[0].row.companyName}.`,
      lines: entries.map(({ item }) => ({ label: `${item.lotLabel} · ${item.communityName}`, name: item.name, dates: `${item.startDate} – ${item.endDate}` })),
      buttonText: link ? "Open trade portal" : null, buttonUrl: link,
      org: { name: org?.name ?? null, slug: org?.slug ?? null, logoUrl: org?.logo_url ?? null },
    },
  }
}

/**
 * The trade's look-ahead for the reviewed scope. One look-ahead per company,
 * scope and UTC day: a community-scoped send does not stand in for the full
 * one, and a second click returns the first. `sent: false` is a duplicate.
 */
export async function sendTradeLookahead(
  companyId: string,
  opts: { weeks: 2 | 3 | 4; communityId?: string; divisionId?: string },
  orgId?: string,
) {
  const authorized = await requireOrgContext(orgId)
  await requirePermission("start.write", authorized)
  const context = { supabase: createServiceSupabaseClient(), orgId: authorized.orgId }
  const entries = await companyRowsFor(companyId, opts, context.orgId)
  if (!entries.length) throw new Error("No scheduled work is available for this trade.")
  const outcome = await deliverTradeNotice({
    orgId: context.orgId, actorId: authorized.userId, kind: "lookahead", companyId, projectId: null,
    dedupeKey: lookaheadDedupeKey({
      companyId, weeks: opts.weeks, utcDay: new Date().toISOString().slice(0, 10),
      items: entries.map(({ item }) => ({ id: item.scheduleItemId, startDate: item.startDate, endDate: item.endDate })),
    }),
    scope: { weeks: opts.weeks, communityId: opts.communityId ?? null, divisionId: opts.divisionId ?? null },
    build: () => lookaheadDraft(context, companyId, opts, entries),
  })
  return { sent: outcome === "sent" }
}

/**
 * The notice a trade gets when a house is released: its own work on that house
 * in the next three weeks. A trade with nothing in the window yet is not a
 * failure (the schedule digest tells it when dates arrive), so the job
 * completes as skipped instead of failing forever.
 */
export async function sendReleaseTradeNotice(
  input: { companyId: string; packageId: string; projectId: string; outboxId: number; actorId: string },
  orgId: string,
) {
  const authorized = await requireOrgContext(orgId)
  await requirePermission("start.write", authorized)
  const context = { supabase: createServiceSupabaseClient(), orgId: authorized.orgId }
  const opts = { weeks: 3 as const, projectId: input.projectId }
  const outcome = await deliverTradeNotice({
    orgId: context.orgId, actorId: input.actorId, kind: "release", companyId: input.companyId, projectId: input.projectId,
    outboxId: input.outboxId, dedupeKey: releaseNoticeDedupeKey(input.packageId, input.companyId),
    scope: { weeks: 3, startPackageId: input.packageId },
    build: async () => {
      const entries = await companyRowsFor(input.companyId, opts, context.orgId)
      return entries.length ? lookaheadDraft(context, input.companyId, opts, entries) : null
    },
  })
  return { sent: outcome === "sent", skipped: outcome === "skipped" }
}

/**
 * Add one date change to the company's pending digest for this house. The
 * merge is one database statement (`enqueue_trade_schedule_change`): concurrent
 * moves all land, the trade is told the first date it knew and the latest one,
 * and a move into a digest a worker already claimed opens the next.
 */
export async function enqueueTradeScheduleChange(input: {
  orgId: string
  actorId: string
  companyId: string
  projectId: string
  scheduleItemId: string
  oldStart: string | null
  newStart: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const { data: item, error: itemError } = await supabase.from("schedule_items").select("name")
    .eq("org_id", input.orgId).eq("id", input.scheduleItemId).maybeSingle()
  if (itemError || !item) throw new Error(`Failed to load the schedule item for its trade notice: ${itemError?.message ?? "Schedule item not found"}`)
  const { error } = await supabase.rpc("enqueue_trade_schedule_change", {
    p_org_id: input.orgId, p_actor_id: input.actorId, p_company_id: input.companyId, p_project_id: input.projectId,
    p_item_id: input.scheduleItemId, p_item_name: item.name, p_old_start: input.oldStart, p_new_start: input.newStart,
    p_dedupe_key: scheduleDigestKey(input.companyId, input.projectId, Date.now()), p_delay_seconds: SCHEDULE_DIGEST_WINDOW_MS / 1000,
  })
  if (error) throw new Error(`Failed to queue the trade schedule notice: ${error.message}`)
}

async function homeLabel(supabase: SupabaseClient, orgId: string, projectId: string) {
  const { data, error } = await supabase.from("lots").select("lot_number,block,community:communities(name)")
    .eq("org_id", orgId).eq("project_id", projectId).limit(1).maybeSingle()
  if (error) throw new Error(`Failed to load the home for its trade notice: ${error.message}`)
  if (!data) return "Home"
  const lot = data.block ? `${data.block}-${data.lot_number}` : String(data.lot_number)
  const community = one(data.community)
  return community?.name ? `${String(community.name)} · ${lot}` : lot
}

/** The digest a worker claimed: what moved, as it stood when each change was queued. */
export async function sendScheduleChangeDigestJob(supabase: SupabaseClient, job: { org_id: string; job_id: number; payload: Record<string, unknown> }) {
  const companyId = typeof job.payload.company_id === "string" ? job.payload.company_id : null
  const projectId = typeof job.payload.project_id === "string" ? job.payload.project_id : null
  if (!companyId || !projectId) throw new Error("Schedule digest is missing company or project")
  const changes = scheduleDigestChangesSchema.parse(job.payload.changes ?? [])
  if (!changes.length) return { sent: false, skipped: true }
  const actorId = typeof job.payload.actor_id === "string" ? job.payload.actor_id : null
  const outcome = await deliverTradeNotice({
    orgId: job.org_id, actorId, kind: "schedule_change", companyId, projectId, outboxId: job.job_id,
    dedupeKey: scheduleChangeDedupeKey(job.job_id), scope: { changes: changes.length },
    build: async () => {
      const [recipients, label, orgResult, companyResult, link] = await Promise.all([
        companyRecipients(supabase, job.org_id, companyId),
        homeLabel(supabase, job.org_id, projectId),
        supabase.from("orgs").select("name,slug,logo_url").eq("id", job.org_id).maybeSingle(),
        supabase.from("companies").select("name").eq("org_id", job.org_id).eq("id", companyId).maybeSingle(),
        resolveTradePortalLink(supabase, job.org_id, companyId, projectId),
      ])
      if (!recipients.length) throw new Error("This trade company has no email contacts.")
      if (orgResult.error || companyResult.error) throw new Error(`Failed to load the trade schedule notice: ${(orgResult.error ?? companyResult.error)?.message}`)
      return {
        subject: "Schedule dates changed", recipients,
        snapshot: {
          title: "Schedule dates changed", intro: `${companyResult.data?.name ?? "Trade partner"}, these dates changed:`,
          lines: changes.map((change) => ({ label, name: change.name, dates: `${change.old_start ?? "unscheduled"} → ${change.new_start ?? "unscheduled"}` })),
          buttonText: link ? "Open trade portal" : null, buttonUrl: link,
          org: { name: orgResult.data?.name ?? null, slug: orgResult.data?.slug ?? null, logoUrl: orgResult.data?.logo_url ?? null },
        },
      }
    },
  })
  return { sent: outcome === "sent", skipped: false }
}
