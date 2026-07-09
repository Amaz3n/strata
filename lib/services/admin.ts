import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"

export interface AdminStats {
  totalOrgs: number
  newOrgsThisMonth: number
  activeSubscriptions: number
  trialingSubscriptions: number
  monthlyRevenue: number
  revenueGrowth: number
  pendingIssues: number
  criticalIssues: number
}

export interface AdminActivity {
  id: string
  type: string
  description: string
  userName: string
  userInitials: string
  details?: string
  createdAt: string
}

export async function getAdminStats(): Promise<AdminStats> {
  const supabase = createServiceSupabaseClient()

  // Get total organizations
  const { count: totalOrgs } = await supabase
    .from("orgs")
    .select("*", { count: "exact", head: true })

  // Get new orgs this month
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const { count: newOrgsThisMonth } = await supabase
    .from("orgs")
    .select("*", { count: "exact", head: true })
    .gte("created_at", startOfMonth.toISOString())

  // Get subscription stats
  const { data: subscriptions } = await supabase
    .from("subscriptions")
    .select("status")

  const activeSubscriptions = subscriptions?.filter(s => s.status === "active").length ?? 0
  const trialingSubscriptions = subscriptions?.filter(s => s.status === "trialing").length ?? 0

  // Get revenue (simplified - would need actual billing integration)
  const monthlyRevenue = 0 // TODO: Calculate from actual subscription data
  const revenueGrowth = 0 // TODO: Compare with previous month

  // Get pending issues (simplified)
  const pendingIssues = 0 // TODO: Count failed payments, expired trials, etc.
  const criticalIssues = 0 // TODO: Count critical issues

  return {
    totalOrgs: totalOrgs ?? 0,
    newOrgsThisMonth: newOrgsThisMonth ?? 0,
    activeSubscriptions,
    trialingSubscriptions,
    monthlyRevenue,
    revenueGrowth,
    pendingIssues,
    criticalIssues,
  }
}

export async function getRecentAdminActivity(): Promise<AdminActivity[]> {
  const supabase = createServiceSupabaseClient()

  // Get recent audit log entries with user info
  const { data: auditEntries } = await supabase
    .from("audit_log")
    .select(`
      id,
      action,
      entity_type,
      created_at,
      actor_user:actor_user_id (
        full_name,
        email
      )
    `)
    .order("created_at", { ascending: false })
    .limit(10)

  if (!auditEntries) return []

  return auditEntries.map(entry => {
    const actor = Array.isArray(entry.actor_user) ? entry.actor_user[0] : entry.actor_user
    return {
      id: entry.id,
      type: getActivityType(entry.action, entry.entity_type),
      description: formatActivityDescription(entry.action, entry.entity_type),
      userName: actor?.full_name || actor?.email || "System",
      userInitials: getInitials(actor?.full_name || actor?.email || "System"),
      createdAt: entry.created_at,
    }
  })
}

function getActivityType(action: string, entityType: string): string {
  if (entityType === "org" && action === "insert") return "provision"
  if (entityType === "subscription") return "subscription"
  if (entityType === "payment" || entityType === "invoice") return "billing"
  if (entityType === "user" && action === "update") return "security"
  return "system"
}

function formatActivityDescription(action: string, entityType: string): string {
  const actionText = action === "insert" ? "created" :
                    action === "update" ? "updated" :
                    action === "delete" ? "deleted" : action

  return `${actionText} ${entityType.replace("_", " ")}`
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map(word => word.charAt(0))
    .join("")
    .toUpperCase()
    .slice(0, 2)
}

export interface Customer {
  id: string
  name: string
  slug: string
  status: string
  billingModel: string
  billingEmail: string | null
  memberCount: number
  createdAt: string
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

  // Get member counts and subscription data for each org
  const customers: Customer[] = []
  for (const org of orgs || []) {
    // Get member count
    const { count: memberCount } = await supabase
      .from("memberships")
      .select("*", { count: "exact", head: true })
      .eq("org_id", org.id)

    // Get active subscription with plan details
    const { data: subscriptionData } = await supabase
      .from("subscriptions")
      .select(`
        id,
        plan_code,
        status,
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
      .eq("org_id", org.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    let subscription = null
    if (subscriptionData) {
      const plan = Array.isArray(subscriptionData.plans) ? subscriptionData.plans[0] : subscriptionData.plans
      subscription = {
        id: subscriptionData.id,
        planCode: subscriptionData.plan_code ?? null,
        status: subscriptionData.status,
        planName: plan?.name ?? subscriptionData.plan_code ?? null,
        amountCents: plan?.amount_cents ?? null,
        currency: plan?.currency ?? null,
        interval: plan?.interval ?? null,
        currentPeriodEnd: subscriptionData.current_period_end ?? null,
        trialEndsAt: subscriptionData.trial_ends_at ?? null,
        externalCustomerId: subscriptionData.external_customer_id ?? null,
        externalSubscriptionId: subscriptionData.external_subscription_id ?? null,
        checkoutUrl: subscriptionData.checkout_url ?? null,
        collectionMethod: subscriptionData.collection_method ?? null,
        netDays: subscriptionData.net_days ?? null,
      }
    }

    customers.push({
      id: org.id,
      name: org.name,
      slug: org.slug || '',
      status: org.status,
      billingModel: org.billing_model,
      billingEmail: org.billing_email ?? null,
      memberCount: memberCount || 0,
      createdAt: org.created_at,
      subscription,
    })
  }

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
  userGrowth: number
  totalOrganizations: number
  newOrgsThisMonth: number
  activeSubscriptions: number
  trialingSubscriptions: number
  pastDueSubscriptions: number
  eventsLast24h: number
  outboxFailuresLast24h: number
  paidPaymentsLast30d: number
  overdueInvoices: number
  fileStorageUsed: number
  fileStorageLimit: number
  bandwidthUsed: number
  bandwidthLimit: number
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

export async function getSystemMetrics(): Promise<SystemMetrics> {
  const supabase = createServiceSupabaseClient()
  const now = new Date()
  const dayAgoIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const thirtyDaysAgoIso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)
  const startOfPrevMonth = new Date(startOfMonth)
  startOfPrevMonth.setMonth(startOfPrevMonth.getMonth() - 1)

  const [
    { count: totalOrgs },
    { count: newOrgsThisMonth },
    { count: usersThisMonth },
    { count: usersPrevMonth },
    { data: dauData },
    { data: subscriptionsData },
    { count: eventsLast24h },
    { count: outboxFailuresLast24h },
    { count: paidPaymentsLast30d },
    { count: overdueInvoices },
    { data: filesData },
    { data: uploadedFiles30dData },
  ] = await Promise.all([
    supabase.from("orgs").select("*", { count: "exact", head: true }),
    supabase.from("orgs").select("*", { count: "exact", head: true }).gte("created_at", startOfMonth.toISOString()),
    supabase.from("app_users").select("*", { count: "exact", head: true }).gte("created_at", startOfMonth.toISOString()),
    supabase
      .from("app_users")
      .select("*", { count: "exact", head: true })
      .gte("created_at", startOfPrevMonth.toISOString())
      .lt("created_at", startOfMonth.toISOString()),
    supabase.from("memberships").select("user_id").eq("status", "active").gte("last_active_at", dayAgoIso),
    supabase.from("subscriptions").select("status"),
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
    supabase.from("files").select("size_bytes").is("archived_at", null),
    supabase.from("files").select("size_bytes").gte("created_at", thirtyDaysAgoIso),
  ])

  const activeUsers = new Set((dauData ?? []).map((row: any) => row.user_id).filter(Boolean))
  const activeSubscriptions = (subscriptionsData ?? []).filter((s: any) => s.status === "active").length
  const trialingSubscriptions = (subscriptionsData ?? []).filter((s: any) => s.status === "trialing").length
  const pastDueSubscriptions = (subscriptionsData ?? []).filter((s: any) => s.status === "past_due").length

  const fileStorageBytes = (filesData ?? []).reduce((sum: number, row: any) => sum + Number(row.size_bytes ?? 0), 0)
  const uploadBytes30d = (uploadedFiles30dData ?? []).reduce((sum: number, row: any) => sum + Number(row.size_bytes ?? 0), 0)
  const userGrowth =
    !usersPrevMonth || usersPrevMonth === 0
      ? (usersThisMonth ?? 0) > 0
        ? 100
        : 0
      : Math.round((((usersThisMonth ?? 0) - usersPrevMonth) / usersPrevMonth) * 100)

  const bytesPerGb = 1024 * 1024 * 1024
  const storageLimitGb = 200
  const bandwidthLimitGb = 500

  return {
    dailyActiveUsers: activeUsers.size,
    userGrowth,
    totalOrganizations: totalOrgs || 0,
    newOrgsThisMonth: newOrgsThisMonth || 0,
    activeSubscriptions,
    trialingSubscriptions,
    pastDueSubscriptions,
    eventsLast24h: eventsLast24h || 0,
    outboxFailuresLast24h: outboxFailuresLast24h || 0,
    paidPaymentsLast30d: paidPaymentsLast30d || 0,
    overdueInvoices: overdueInvoices || 0,
    fileStorageUsed: Number((fileStorageBytes / bytesPerGb).toFixed(2)),
    fileStorageLimit: storageLimitGb,
    bandwidthUsed: Number((uploadBytes30d / bytesPerGb).toFixed(2)),
    bandwidthLimit: bandwidthLimitGb,
  }
}

export async function getUsageTrends(): Promise<UsageTrends> {
  const supabase = createServiceSupabaseClient()
  const now = new Date()
  const monthStarts = Array.from({ length: 6 }).map((_, idx) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - idx), 1)
    return d
  })

  const userGrowth = await Promise.all(
    monthStarts.map(async (monthStart) => {
      const nextMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1)
      const prevMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1)

      const [{ count: currentCount }, { count: prevCount }] = await Promise.all([
        supabase
          .from("app_users")
          .select("*", { count: "exact", head: true })
          .gte("created_at", monthStart.toISOString())
          .lt("created_at", nextMonthStart.toISOString()),
        supabase
          .from("app_users")
          .select("*", { count: "exact", head: true })
          .gte("created_at", prevMonthStart.toISOString())
          .lt("created_at", monthStart.toISOString()),
      ])

      const base = prevCount ?? 0
      const change = base === 0 ? ((currentCount ?? 0) > 0 ? 100 : 0) : Math.round((((currentCount ?? 0) - base) / base) * 100)

      return {
        month: monthStart.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        count: currentCount ?? 0,
        change,
      }
    }),
  )

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


// Additional admin functions will be added here as we implement more features

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
