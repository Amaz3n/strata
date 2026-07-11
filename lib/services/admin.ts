import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { normalizeProductTier, type ProductTier } from "@/lib/product-tier"

export interface AdminStats {
  totalOrgs: number
  newOrgsThisMonth: number
  activeSubscriptions: number
  trialingSubscriptions: number
}

export async function getAdminStats(): Promise<AdminStats> {
  const supabase = createServiceSupabaseClient()

  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const [{ count: totalOrgs }, { count: newOrgsThisMonth }, { data: subscriptions }] = await Promise.all([
    supabase.from("orgs").select("*", { count: "exact", head: true }),
    supabase.from("orgs").select("*", { count: "exact", head: true }).gte("created_at", startOfMonth.toISOString()),
    supabase.from("subscriptions").select("status"),
  ])

  return {
    totalOrgs: totalOrgs ?? 0,
    newOrgsThisMonth: newOrgsThisMonth ?? 0,
    activeSubscriptions: subscriptions?.filter((s) => s.status === "active").length ?? 0,
    trialingSubscriptions: subscriptions?.filter((s) => s.status === "trialing").length ?? 0,
  }
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map(word => word.charAt(0))
    .join("")
    .toUpperCase()
    .slice(0, 2)
}

export interface CustomerHealth {
  lastActivityAt: string | null
  activeMemberCount: number
  projectCount: number
  eventsLast14d: number
  storageBytes: number
  qboStatus: string | null
  atRisk: boolean
}

export interface Customer {
  id: string
  name: string
  slug: string
  status: string
  billingModel: string
  billingEmail: string | null
  productTier: ProductTier
  memberCount: number
  createdAt: string
  health: CustomerHealth
  subscription?: {
    id: string
    planCode: string | null
    status: string
    planName: string | null
    amountCents: number | null
    currency: string | null
    interval: string | null
    currentPeriodEnd: string | null
    trialEndsAt: string | null
    externalCustomerId: string | null
    externalSubscriptionId: string | null
    checkoutUrl: string | null
    collectionMethod: string | null
    netDays: number | null
  } | null
}

export interface CustomersResult {
  customers: Customer[]
  totalCount: number
  hasNextPage: boolean
  hasPrevPage: boolean
}

export interface Subscription {
  id: string
  orgId: string
  orgName: string
  orgSlug: string
  planCode: string | null
  status: string
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  trialEndsAt: string | null
  createdAt: string
}

export interface SubscriptionsResult {
  subscriptions: Subscription[]
  totalCount: number
  hasNextPage: boolean
  hasPrevPage: boolean
}

export interface AuditLogEntry {
  id: string
  action: string
  entityType: string
  entityId: string | null
  userName: string
  userEmail: string
  userInitials: string
  description: string | null
  createdAt: string
  orgId: string | null
  orgName: string | null
  projectName: string | null
  beforeData: any
  afterData: any
}

export interface AuditLogsResult {
  auditLogs: AuditLogEntry[]
  totalCount: number
  hasNextPage: boolean
  hasPrevPage: boolean
}

export async function getCustomers({
  search,
  status,
  plan,
  page = 1,
  limit = 20,
}: {
  search?: string
  status?: string
  plan?: string
  page?: number
  limit?: number
}): Promise<CustomersResult> {
  const supabase = createServiceSupabaseClient()
  const offset = (page - 1) * limit

  let query = supabase
    .from("orgs")
    .select(`
      id,
      name,
      slug,
      status,
      billing_model,
      billing_email,
      product_tier,
      created_at
    `, { count: "exact" })

  // Apply filters
  if (search) {
    query = query.or(`name.ilike.%${search}%,slug.ilike.%${search}%`)
  }

  if (status) {
    query = query.eq("status", status)
  }

  if (plan) {
    query = query.eq("billing_model", plan)
  }

  // Get paginated results
  const { data: orgs, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw error

  const orgIds = (orgs ?? []).map((org) => org.id)

  if (orgIds.length === 0) {
    return {
      customers: [],
      totalCount: count || 0,
      hasNextPage: false,
      hasPrevPage: page > 1,
    }
  }

  const fourteenDaysAgoIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

  // Batched per-page lookups: memberships/subscriptions/QBO by org id, and
  // Postgres-side aggregates for events and storage (client selects cap at
  // 1000 rows, so summing/grouping in JS under-reports).
  const [membershipsRes, subscriptionsRes, qboRes, eventsRes, storageRes, projectCounts] =
    await Promise.all([
      supabase
        .from("memberships")
        .select("org_id, status, last_active_at")
        .in("org_id", orgIds),
      supabase
        .from("subscriptions")
        .select(`
          id,
          org_id,
          plan_code,
          status,
          created_at,
          current_period_end,
          trial_ends_at,
          external_customer_id,
          external_subscription_id,
          checkout_url,
          collection_method,
          net_days,
          plans (
            name,
            amount_cents,
            currency,
            interval
          )
        `)
        .in("org_id", orgIds)
        .order("created_at", { ascending: false }),
      supabase
        .from("qbo_connections")
        .select("org_id, status")
        .in("org_id", orgIds)
        .is("disconnected_at", null),
      supabase.rpc("platform_events_by_org", { p_org_ids: orgIds, p_since: fourteenDaysAgoIso }),
      supabase.rpc("platform_storage_by_org", { p_org_ids: orgIds }),
      Promise.all(
        orgIds.map((id) =>
          supabase.from("projects").select("*", { count: "exact", head: true }).eq("org_id", id),
        ),
      ),
    ])

  const membershipsByOrg = new Map<string, { status: string; last_active_at: string | null }[]>()
  for (const row of membershipsRes.data ?? []) {
    const list = membershipsByOrg.get(row.org_id) ?? []
    list.push({ status: row.status, last_active_at: row.last_active_at ?? null })
    membershipsByOrg.set(row.org_id, list)
  }

  const subscriptionByOrg = new Map<string, NonNullable<Customer["subscription"]>>()
  for (const sub of subscriptionsRes.data ?? []) {
    if (subscriptionByOrg.has(sub.org_id)) continue // rows ordered newest-first
    const plan = Array.isArray(sub.plans) ? sub.plans[0] : sub.plans
    subscriptionByOrg.set(sub.org_id, {
      id: sub.id,
      planCode: sub.plan_code ?? null,
      status: sub.status,
      planName: plan?.name ?? sub.plan_code ?? null,
      amountCents: plan?.amount_cents ?? null,
      currency: plan?.currency ?? null,
      interval: plan?.interval ?? null,
      currentPeriodEnd: sub.current_period_end ?? null,
      trialEndsAt: sub.trial_ends_at ?? null,
      externalCustomerId: sub.external_customer_id ?? null,
      externalSubscriptionId: sub.external_subscription_id ?? null,
      checkoutUrl: sub.checkout_url ?? null,
      collectionMethod: sub.collection_method ?? null,
      netDays: sub.net_days ?? null,
    })
  }

  const qboStatusByOrg = new Map<string, string>(
    (qboRes.data ?? []).map((row: { org_id: string; status: string }) => [row.org_id, row.status]),
  )
  const eventsByOrg = new Map<string, { event_count: number; last_event_at: string | null }>(
    ((eventsRes.data ?? []) as { org_id: string; event_count: number; last_event_at: string | null }[]).map(
      (row) => [row.org_id, { event_count: Number(row.event_count), last_event_at: row.last_event_at }],
    ),
  )
  const storageByOrg = new Map<string, number>(
    ((storageRes.data ?? []) as { org_id: string; total_bytes: number }[]).map((row) => [
      row.org_id,
      Number(row.total_bytes),
    ]),
  )
  const projectCountByOrg = new Map<string, number>(
    orgIds.map((id, index) => [id, projectCounts[index]?.count ?? 0]),
  )

  const customers: Customer[] = (orgs ?? []).map((org) => {
    const memberships = membershipsByOrg.get(org.id) ?? []
    const subscription = subscriptionByOrg.get(org.id) ?? null
    const events = eventsByOrg.get(org.id)

    const lastMemberActiveAt = memberships.reduce<string | null>(
      (latest, membership) =>
        membership.last_active_at && (!latest || membership.last_active_at > latest)
          ? membership.last_active_at
          : latest,
      null,
    )
    const lastActivityAt =
      [lastMemberActiveAt, events?.last_event_at ?? null]
        .filter((value): value is string => Boolean(value))
        .sort()
        .pop() ?? null

    const paying = subscription?.status === "active" || subscription?.status === "past_due"
    const inactive14d =
      !lastActivityAt || Date.now() - new Date(lastActivityAt).getTime() > 14 * 24 * 60 * 60 * 1000

    return {
      id: org.id,
      name: org.name,
      slug: org.slug || "",
      status: org.status,
      billingModel: org.billing_model,
      billingEmail: org.billing_email ?? null,
      productTier: normalizeProductTier(org.product_tier),
      memberCount: memberships.length,
      createdAt: org.created_at,
      subscription,
      health: {
        lastActivityAt,
        activeMemberCount: memberships.filter((membership) => membership.status === "active").length,
        projectCount: projectCountByOrg.get(org.id) ?? 0,
        eventsLast14d: events?.event_count ?? 0,
        storageBytes: storageByOrg.get(org.id) ?? 0,
        qboStatus: qboStatusByOrg.get(org.id) ?? null,
        atRisk: paying && org.status === "active" && inactive14d,
      },
    }
  })

  const totalCount = count || 0
  const hasNextPage = offset + limit < totalCount
  const hasPrevPage = page > 1

  return {
    customers,
    totalCount,
    hasNextPage,
    hasPrevPage,
  }
}

export async function getSubscriptions({
  search,
  status,
  plan,
  page = 1,
  limit = 20,
}: {
  search?: string
  status?: string
  plan?: string
  page?: number
  limit?: number
}): Promise<SubscriptionsResult> {
  const supabase = createServiceSupabaseClient()
  const offset = (page - 1) * limit

  let query = supabase
    .from("subscriptions")
    .select(`
      id,
      org_id,
      plan_code,
      status,
      current_period_start,
      current_period_end,
      trial_ends_at,
      created_at,
      org:orgs (
        name,
        slug
      )
    `, { count: "exact" })

  // Apply filters
  if (status) {
    query = query.eq("status", status)
  }

  if (plan) {
    query = query.eq("plan_code", plan)
  }

  // Apply search filter on org name
  if (search) {
    query = query.ilike("org.name", `%${search}%`)
  }

  // Get paginated results
  const { data: subscriptionData, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw error

  const subscriptions: Subscription[] = (subscriptionData || []).map(sub => ({
    id: sub.id,
    orgId: sub.org_id,
    orgName: (sub.org as any)?.name || 'Unknown',
    orgSlug: (sub.org as any)?.slug || '',
    planCode: sub.plan_code,
    status: sub.status,
    currentPeriodStart: sub.current_period_start,
    currentPeriodEnd: sub.current_period_end,
    trialEndsAt: sub.trial_ends_at,
    createdAt: sub.created_at,
  }))

  const totalCount = count || 0
  const hasNextPage = offset + limit < totalCount
  const hasPrevPage = page > 1

  return {
    subscriptions,
    totalCount,
    hasNextPage,
    hasPrevPage,
  }
}

export async function getAuditLogs({
  search,
  action,
  entityType,
  user,
  orgId,
  startDate,
  endDate,
  page = 1,
  limit = 50,
}: {
  search?: string
  action?: string
  entityType?: string
  user?: string
  orgId?: string
  startDate?: string
  endDate?: string
  page?: number
  limit?: number
}): Promise<AuditLogsResult> {
  const supabase = createServiceSupabaseClient()
  const offset = (page - 1) * limit

  let query = supabase
    .from("audit_log")
    .select(`
      id,
      action,
      entity_type,
      entity_id,
      before_data,
      after_data,
      created_at,
      actor_user:actor_user_id (
        full_name,
        email
      ),
      org:org_id (
        id,
        name
      )
    `, { count: "exact" })

  // Apply filters
  if (action) {
    query = query.eq("action", action)
  }

  if (entityType) {
    query = query.eq("entity_type", entityType)
  }

  if (orgId && orgId !== 'all') {
    query = query.eq("org_id", orgId)
  }

  if (user && user !== 'all') {
    if (user === 'system') {
      query = query.is("actor_user_id", null)
    } else {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.trim())
      if (isUuid) {
        query = query.eq("actor_user_id", user)
      }
    }
  }

  if (startDate) {
    query = query.gte("created_at", startDate)
  }

  if (endDate) {
    query = query.lte("created_at", endDate)
  }

  if (search) {
    const trimmed = search.trim()
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
    if (isUuid) {
      query = query.or(`entity_id.eq.${trimmed},actor_user_id.eq.${trimmed},org_id.eq.${trimmed}`)
    } else {
      query = query.or(`action.ilike.%${trimmed}%,entity_type.ilike.%${trimmed}%`)
    }
  }

  // Get paginated results
  const { data: auditData, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw error

  const projectIds = new Set<string>()
  auditData?.forEach(log => {
    if (log.entity_type === "project" && log.entity_id) {
      projectIds.add(log.entity_id)
    }
    if (log.after_data?.project_id) {
      projectIds.add(log.after_data.project_id)
    }
    if (log.before_data?.project_id) {
      projectIds.add(log.before_data.project_id)
    }
  })

  const projectNames: Record<string, string> = {}
  if (projectIds.size > 0) {
    const { data: projects } = await supabase
      .from("projects")
      .select("id, name")
      .in("id", Array.from(projectIds))

    projects?.forEach(p => {
      projectNames[p.id] = p.name
    })
  }

  const auditLogs: AuditLogEntry[] = (auditData || []).map(log => ({
    id: log.id.toString(),
    action: log.action,
    entityType: log.entity_type,
    entityId: log.entity_id,
    userName: (log.actor_user as any)?.full_name || 'System',
    userEmail: (log.actor_user as any)?.email || 'system',
    userInitials: getInitials((log.actor_user as any)?.full_name || (log.actor_user as any)?.email || 'System'),
    description: generateAuditDescription(log),
    createdAt: log.created_at,
    orgId: (log.org as any)?.id || null,
    orgName: (log.org as any)?.name || null,
    projectName: (log.entity_type === "project" ? projectNames[log.entity_id as string] : null) 
      || (log.after_data?.project_id ? projectNames[log.after_data.project_id] : null)
      || (log.before_data?.project_id ? projectNames[log.before_data.project_id] : null)
      || null,
    beforeData: log.before_data,
    afterData: log.after_data,
  }))

  const totalCount = count || 0
  const hasNextPage = offset + limit < totalCount
  const hasPrevPage = page > 1

  return {
    auditLogs,
    totalCount,
    hasNextPage,
    hasPrevPage,
  }
}

function generateAuditDescription(log: any): string {
  const action = log.action
  const entityType = log.entity_type

  switch (action) {
    case 'insert':
      return `Created new ${entityType}`
    case 'update':
      return `Updated ${entityType}`
    case 'delete':
      return `Deleted ${entityType}`
    default:
      return `${action} ${entityType}`
  }
}

export interface FeatureFlag {
  id: string
  orgId: string
  flagKey: string
  enabled: boolean
  config: Record<string, any>
  expiresAt: string | null
  orgName: string
}

export interface FeatureFlagOrganization {
  id: string
  name: string
  slug: string | null
  status: string
}

export async function getFeatureFlagOrganizations(): Promise<FeatureFlagOrganization[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("orgs")
    .select("id, name, slug, status")
    .order("name", { ascending: true })

  if (error) throw error
  return (data ?? []).map((org) => ({
    id: org.id,
    name: org.name,
    slug: org.slug ?? null,
    status: org.status,
  }))
}

export async function getFeatureFlags(): Promise<FeatureFlag[]> {
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("feature_flags")
    .select(`
      id,
      org_id,
      flag_key,
      enabled,
      config,
      expires_at,
      org:orgs (
        name
      )
    `)
    .order("flag_key", { ascending: true })

  if (error) throw error

  return (data || [])
    .map(flag => ({
      id: flag.id,
      orgId: flag.org_id,
      flagKey: flag.flag_key,
      enabled: flag.enabled,
      config: flag.config || {},
      expiresAt: flag.expires_at,
      orgName: (flag.org as any)?.name || "Unknown",
    }))
    .sort((a, b) => a.orgName.localeCompare(b.orgName) || a.flagKey.localeCompare(b.flagKey))
}

export async function toggleFeatureFlag(
  flagId: string,
  orgId: string,
  enabled: boolean,
  actorId?: string,
): Promise<void> {
  const supabase = createServiceSupabaseClient()
  const { data: existing, error: existingError } = await supabase
    .from("feature_flags")
    .select("id, flag_key, enabled")
    .eq("id", flagId)
    .eq("org_id", orgId)
    .maybeSingle()
  if (existingError || !existing) throw new Error("Feature flag not found")

  const { error } = await supabase
    .from("feature_flags")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", flagId)
    .eq("org_id", orgId)

  if (error) throw error

  await recordAudit({
    orgId,
    actorId,
    action: "update",
    entityType: "feature_flag",
    entityId: flagId,
    before: existing,
    after: { ...existing, enabled },
  })
}

export async function createFeatureFlag(input: {
  orgId: string
  flagKey: string
  enabled: boolean
  config: Record<string, unknown>
  expiresAt: string | null
  actorId?: string
}): Promise<FeatureFlag> {
  const supabase = createServiceSupabaseClient()
  const { data: org, error: orgError } = await supabase
    .from("orgs")
    .select("id, name")
    .eq("id", input.orgId)
    .maybeSingle()
  if (orgError || !org) throw new Error("Organization not found")

  const payload = {
    org_id: input.orgId,
    flag_key: input.flagKey,
    enabled: input.enabled,
    config: input.config,
    expires_at: input.expiresAt,
  }
  const { data, error } = await supabase
    .from("feature_flags")
    .insert(payload)
    .select("id, org_id, flag_key, enabled, config, expires_at")
    .single()

  if (error || !data) {
    if (error?.code === "23505") throw new Error("This feature flag already exists for the organization")
    throw new Error(error?.message ?? "Failed to create feature flag")
  }

  await recordAudit({
    orgId: input.orgId,
    actorId: input.actorId,
    action: "insert",
    entityType: "feature_flag",
    entityId: data.id,
    after: payload,
  })

  return {
    id: data.id,
    orgId: data.org_id,
    flagKey: data.flag_key,
    enabled: data.enabled,
    config: data.config ?? {},
    expiresAt: data.expires_at,
    orgName: org.name,
  }
}

export async function updateFeatureFlag(input: {
  flagId: string
  orgId: string
  flagKey: string
  enabled: boolean
  config: Record<string, unknown>
  expiresAt: string | null
  actorId?: string
}): Promise<void> {
  const supabase = createServiceSupabaseClient()
  const { data: existing, error: existingError } = await supabase
    .from("feature_flags")
    .select("id, org_id, flag_key, enabled, config, expires_at")
    .eq("id", input.flagId)
    .eq("org_id", input.orgId)
    .maybeSingle()
  if (existingError || !existing) throw new Error("Feature flag not found")

  const after = {
    flag_key: input.flagKey,
    enabled: input.enabled,
    config: input.config,
    expires_at: input.expiresAt,
  }
  const { error } = await supabase
    .from("feature_flags")
    .update(after)
    .eq("id", input.flagId)
    .eq("org_id", input.orgId)
  if (error) {
    if (error.code === "23505") throw new Error("This feature flag already exists for the organization")
    throw error
  }

  await recordAudit({
    orgId: input.orgId,
    actorId: input.actorId,
    action: "update",
    entityType: "feature_flag",
    entityId: input.flagId,
    before: existing,
    after,
  })
}

export async function deleteFeatureFlag(input: {
  flagId: string
  orgId: string
  actorId?: string
}): Promise<void> {
  const supabase = createServiceSupabaseClient()
  const { data: existing, error: existingError } = await supabase
    .from("feature_flags")
    .select("id, org_id, flag_key, enabled, config, expires_at")
    .eq("id", input.flagId)
    .eq("org_id", input.orgId)
    .maybeSingle()
  if (existingError || !existing) throw new Error("Feature flag not found")

  const { error } = await supabase
    .from("feature_flags")
    .delete()
    .eq("id", input.flagId)
    .eq("org_id", input.orgId)
  if (error) throw error

  await recordAudit({
    orgId: input.orgId,
    actorId: input.actorId,
    action: "delete",
    entityType: "feature_flag",
    entityId: input.flagId,
    before: existing,
  })
}

export interface SystemMetrics {
  dailyActiveUsers: number
  weeklyActiveUsers: number
  totalOrganizations: number
  newOrgsThisMonth: number
  activeSubscriptions: number
  trialingSubscriptions: number
  pastDueSubscriptions: number
  mrrCents: number
  pastDueMrrCents: number
  eventsLast24h: number
  outboxFailuresLast24h: number
  paidPaymentsLast30d: number
  overdueInvoices: number
  fileStorageBytes: number
  uploadBytes30d: number
}

export interface UsageTrend {
  month: string
  count: number
  change: number
}

export interface FeatureUsage {
  name: string
  usage: number
  change: number
}

export interface UsageTrends {
  userGrowth: UsageTrend[]
  featureUsage: FeatureUsage[]
}

export interface SupportContract {
  id: string
  orgId: string
  orgName: string
  status: string
  tier: string
  startsAt: string
  endsAt: string | null
  createdAt: string
}

export interface Plan {
  code: string
  name: string
  publicName: string | null
  packageType: string | null
  featureKeys: string[]
  internalNotes: string | null
  pricingModel: string
  interval: string | null
  amountCents: number | null
  currency: string | null
  stripePriceId: string | null
  isActive: boolean
  createdAt: string
}

// A subscription contributes its plan price normalized to a monthly amount.
function monthlyAmountCents(plan: { amount_cents: number | null; interval: string | null } | null): number {
  if (!plan?.amount_cents) return 0
  return plan.interval === "year" ? Math.round(plan.amount_cents / 12) : plan.amount_cents
}

export async function getSystemMetrics(): Promise<SystemMetrics> {
  const supabase = createServiceSupabaseClient()
  const now = new Date()
  const dayAgoIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const weekAgoIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const thirtyDaysAgoIso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const [
    { count: totalOrgs },
    { count: newOrgsThisMonth },
    { data: activeMembershipsData },
    { data: subscriptionsData },
    { count: eventsLast24h },
    { count: outboxFailuresLast24h },
    { count: paidPaymentsLast30d },
    { count: overdueInvoices },
    storageRes,
    uploadsRes,
  ] = await Promise.all([
    supabase.from("orgs").select("*", { count: "exact", head: true }),
    supabase.from("orgs").select("*", { count: "exact", head: true }).gte("created_at", startOfMonth.toISOString()),
    supabase.from("memberships").select("user_id, last_active_at").eq("status", "active").gte("last_active_at", weekAgoIso),
    supabase.from("subscriptions").select("status, plans (amount_cents, interval)"),
    supabase.from("events").select("*", { count: "exact", head: true }).gte("created_at", dayAgoIso),
    supabase
      .from("outbox")
      .select("*", { count: "exact", head: true })
      .eq("status", "failed")
      .gte("updated_at", dayAgoIso),
    supabase
      .from("payments")
      .select("*", { count: "exact", head: true })
      .eq("status", "paid")
      .gte("created_at", thirtyDaysAgoIso),
    supabase
      .from("invoices")
      .select("*", { count: "exact", head: true })
      .neq("status", "paid")
      .lt("due_date", now.toISOString().slice(0, 10)),
    supabase.rpc("platform_storage_by_org", { p_org_ids: null }),
    supabase.rpc("platform_upload_bytes_since", { p_since: thirtyDaysAgoIso }),
  ])

  const dailyActive = new Set<string>()
  const weeklyActive = new Set<string>()
  for (const row of activeMembershipsData ?? []) {
    if (!row.user_id || !row.last_active_at) continue
    weeklyActive.add(row.user_id)
    if (row.last_active_at >= dayAgoIso) dailyActive.add(row.user_id)
  }

  const subscriptions = (subscriptionsData ?? []).map((sub) => ({
    status: sub.status as string,
    plan: (Array.isArray(sub.plans) ? sub.plans[0] : sub.plans) as {
      amount_cents: number | null
      interval: string | null
    } | null,
  }))
  const activeSubs = subscriptions.filter((sub) => sub.status === "active")
  const pastDueSubs = subscriptions.filter((sub) => sub.status === "past_due")

  const fileStorageBytes = ((storageRes.data ?? []) as { total_bytes: number }[]).reduce(
    (sum, row) => sum + Number(row.total_bytes),
    0,
  )

  return {
    dailyActiveUsers: dailyActive.size,
    weeklyActiveUsers: weeklyActive.size,
    totalOrganizations: totalOrgs || 0,
    newOrgsThisMonth: newOrgsThisMonth || 0,
    activeSubscriptions: activeSubs.length,
    trialingSubscriptions: subscriptions.filter((sub) => sub.status === "trialing").length,
    pastDueSubscriptions: pastDueSubs.length,
    mrrCents: activeSubs.reduce((sum, sub) => sum + monthlyAmountCents(sub.plan), 0),
    pastDueMrrCents: pastDueSubs.reduce((sum, sub) => sum + monthlyAmountCents(sub.plan), 0),
    eventsLast24h: eventsLast24h || 0,
    outboxFailuresLast24h: outboxFailuresLast24h || 0,
    paidPaymentsLast30d: paidPaymentsLast30d || 0,
    overdueInvoices: overdueInvoices || 0,
    fileStorageBytes,
    uploadBytes30d: Number(uploadsRes.data ?? 0),
  }
}

export async function getUsageTrends(): Promise<UsageTrends> {
  const supabase = createServiceSupabaseClient()
  const now = new Date()
  const monthStarts = Array.from({ length: 6 }).map(
    (_, idx) => new Date(now.getFullYear(), now.getMonth() - (5 - idx), 1),
  )

  const signupsRes = await supabase.rpc("platform_monthly_signups", { p_months: 7 })
  const signupsByMonth = new Map<string, number>(
    ((signupsRes.data ?? []) as { month_start: string; signup_count: number }[]).map((row) => [
      row.month_start.slice(0, 7),
      Number(row.signup_count),
    ]),
  )

  const monthKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`

  const userGrowth = monthStarts.map((monthStart) => {
    const prevMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1)
    const current = signupsByMonth.get(monthKey(monthStart)) ?? 0
    const previous = signupsByMonth.get(monthKey(prevMonthStart)) ?? 0
    const change = previous === 0 ? (current > 0 ? 100 : 0) : Math.round(((current - previous) / previous) * 100)

    return {
      month: monthStart.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
      count: current,
      change,
    }
  })

  const currentWindowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const previousWindowStart = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const previousWindowEnd = currentWindowStart

  const featureDefinitions = [
    { name: "Project Management", entityTypes: ["project", "task", "schedule_item"] },
    { name: "Documents", entityTypes: ["file", "document", "drawing_set", "drawing_sheet"] },
    { name: "Financials", entityTypes: ["invoice", "payment", "vendor_bill", "subscription"] },
    { name: "Collaboration", entityTypes: ["daily_log"] },
    { name: "Operations", entityTypes: ["rfi", "submittal", "change_order", "punch_item"] },
  ]

  const featureUsage = await Promise.all(
    featureDefinitions.map(async (feature) => {
      const [{ count: currentCount }, { count: previousCount }] = await Promise.all([
        supabase
          .from("events")
          .select("*", { count: "exact", head: true })
          .in("entity_type", feature.entityTypes)
          .gte("created_at", currentWindowStart),
        supabase
          .from("events")
          .select("*", { count: "exact", head: true })
          .in("entity_type", feature.entityTypes)
          .gte("created_at", previousWindowStart)
          .lt("created_at", previousWindowEnd),
      ])

      const previous = previousCount ?? 0
      const change =
        previous === 0 ? ((currentCount ?? 0) > 0 ? 100 : 0) : Math.round((((currentCount ?? 0) - previous) / previous) * 100)

      return {
        name: feature.name,
        usage: currentCount ?? 0,
        change,
      }
    }),
  )

  return {
    userGrowth,
    featureUsage,
  }
}

export async function getPlans(): Promise<Plan[]> {
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("plans")
    .select("*")
    .order("created_at", { ascending: false })

  if (error) throw error

  const planCodes = (data || []).map((plan) => plan.code).filter(Boolean)
  const featureKeysByPlan = new Map<string, string[]>()
  if (planCodes.length > 0) {
    const { data: limits } = await supabase
      .from("plan_feature_limits")
      .select("plan_code, feature_key")
      .in("plan_code", planCodes)

    for (const limit of limits ?? []) {
      const planCode = String(limit.plan_code)
      const current = featureKeysByPlan.get(planCode) ?? []
      current.push(String(limit.feature_key))
      featureKeysByPlan.set(planCode, current)
    }
  }

  return (data || []).map(plan => ({
    code: plan.code,
    name: plan.name,
    publicName: (plan.metadata as any)?.public_name ?? null,
    packageType: (plan.metadata as any)?.package_type ?? null,
    featureKeys: featureKeysByPlan.get(plan.code) ?? [],
    internalNotes: (plan.metadata as any)?.internal_notes ?? null,
    pricingModel: plan.pricing_model,
    interval: plan.interval,
    amountCents: plan.amount_cents,
    currency: plan.currency,
    stripePriceId: plan.stripe_price_id ?? null,
    isActive: plan.is_active,
    createdAt: plan.created_at,
  }))
}

export async function getSupportContracts(): Promise<SupportContract[]> {
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("support_contracts")
    .select(`
      id,
      org_id,
      status,
      starts_at,
      ends_at,
      created_at,
      details,
      org:orgs (
        name
      )
    `)
    .order("created_at", { ascending: false })

  if (error) throw error

  return (data || []).map(contract => ({
    id: contract.id,
    orgId: contract.org_id,
    orgName: (contract.org as any)?.name || 'Unknown',
    status: contract.status,
    tier: (contract.details as any)?.tier || 'standard',
    startsAt: contract.starts_at,
    endsAt: contract.ends_at,
    createdAt: contract.created_at,
  }))
}


export interface PlatformUserMembership {
  orgId: string
  orgName: string
  roleKey: string | null
  status: string
  lastActiveAt: string | null
}

export interface PlatformUserActivity {
  id: string
  fullName: string | null
  email: string | null
  createdAt: string
  lastActiveAt: string | null
  memberships: PlatformUserMembership[]
}

export interface PlatformUsersResult {
  users: PlatformUserActivity[]
  totalCount: number
  activeToday: number
  active7d: number
  active30d: number
}

const PLATFORM_USERS_CAP = 500

// Who's actually using Arc: every user with their org memberships and the
// freshest membership.last_active_at (touched on activity with a 15-min
// throttle by requireOrgContext). Sorted most-recently-active first.
export async function getPlatformUsers(): Promise<PlatformUsersResult> {
  const supabase = createServiceSupabaseClient()

  const { data, error, count } = await supabase
    .from("app_users")
    .select(
      `
      id,
      full_name,
      email,
      created_at,
      memberships (
        org_id,
        status,
        last_active_at,
        org:orgs (name),
        role:roles (key)
      )
    `,
      { count: "exact" },
    )
    .limit(PLATFORM_USERS_CAP)

  if (error) throw error

  const users: PlatformUserActivity[] = (data ?? []).map((user) => {
    const memberships: PlatformUserMembership[] = (user.memberships ?? []).map((membership: {
      org_id: string
      status: string
      last_active_at: string | null
      org: { name: string } | { name: string }[] | null
      role: { key: string } | { key: string }[] | null
    }) => {
      const org = Array.isArray(membership.org) ? membership.org[0] : membership.org
      const role = Array.isArray(membership.role) ? membership.role[0] : membership.role
      return {
        orgId: membership.org_id,
        orgName: org?.name ?? "Unknown",
        roleKey: role?.key ?? null,
        status: membership.status,
        lastActiveAt: membership.last_active_at ?? null,
      }
    })

    const lastActiveAt = memberships.reduce<string | null>(
      (latest, membership) =>
        membership.lastActiveAt && (!latest || membership.lastActiveAt > latest)
          ? membership.lastActiveAt
          : latest,
      null,
    )

    return {
      id: user.id,
      fullName: user.full_name ?? null,
      email: user.email ?? null,
      createdAt: user.created_at,
      lastActiveAt,
      memberships,
    }
  })

  users.sort((a, b) => {
    if (a.lastActiveAt && b.lastActiveAt) return b.lastActiveAt.localeCompare(a.lastActiveAt)
    if (a.lastActiveAt) return -1
    if (b.lastActiveAt) return 1
    return b.createdAt.localeCompare(a.createdAt)
  })

  const now = Date.now()
  const withinDays = (value: string | null, days: number) =>
    Boolean(value && now - new Date(value).getTime() <= days * 24 * 60 * 60 * 1000)

  return {
    users,
    totalCount: count ?? users.length,
    activeToday: users.filter((user) => withinDays(user.lastActiveAt, 1)).length,
    active7d: users.filter((user) => withinDays(user.lastActiveAt, 7)).length,
    active30d: users.filter((user) => withinDays(user.lastActiveAt, 30)).length,
  }
}

export async function getAuditUsers() {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("app_users")
    .select("id, full_name, email")
    .order("full_name", { ascending: true })

  if (error) throw error
  return (data || []).map(user => ({
    id: user.id,
    fullName: user.full_name,
    email: user.email,
  }))
}
