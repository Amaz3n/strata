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
  memberCount: number
  createdAt: string
  subscription?: {
    status: string
    planName: string
    amountCents: number
    currency: string
    interval: string
    currentPeriodEnd: string
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
        status,
        current_period_end,
        plans!inner (
          name,
          amount_cents,
          currency,
          interval
        )
      `)
      .eq("org_id", org.id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    let subscription = null
    if (subscriptionData) {
      const plan = Array.isArray(subscriptionData.plans) ? subscriptionData.plans[0] : subscriptionData.plans
      subscription = {
        status: subscriptionData.status,
        planName: plan?.name,
        amountCents: plan?.amount_cents,
        currency: plan?.currency,
        interval: plan?.interval,
        currentPeriodEnd: subscriptionData.current_period_end,
      }
    }

    customers.push({
      id: org.id,
      name: org.name,
      slug: org.slug || '',
      status: org.status,
      billingModel: org.billing_model,
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
  page = 1,
  limit = 50,
}: {
  search?: string
  action?: string
  entityType?: string
  user?: string
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
      )
    `, { count: "exact" })

  // Apply filters
  if (action) {
    query = query.eq("action", action)
  }

  if (entityType) {
    query = query.eq("entity_type", entityType)
  }

  if (user && user !== 'system') {
    // For user filter, we'd need to match against actor_user_id
    // This is simplified - in practice you'd need to join with users table
  }

  // Get paginated results
  const { data: auditData, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw error

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
    .order("org.name", { ascending: true })
    .order("flag_key", { ascending: true })

  if (error) throw error

  return (data || []).map(flag => ({
    id: flag.id,
    orgId: flag.org_id,
    flagKey: flag.flag_key,
    enabled: flag.enabled,
    config: flag.config || {},
    expiresAt: flag.expires_at,
    orgName: (flag.org as any)?.name || 'Unknown',
  }))
}

export async function toggleFeatureFlag(
  flagId: string,
  orgId: string,
  flagKey: string,
  enabled: boolean
): Promise<void> {
  const supabase = createServiceSupabaseClient()

  const { error } = await supabase
    .from("feature_flags")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", flagId)

  if (error) throw error

  // Record audit log
  await recordAudit({
    orgId,
    actorId: undefined, // System action
    action: "update",
    entityType: "feature_flag",
    entityId: flagId,
    before: { enabled: !enabled },
    after: { enabled },
  })
}

export interface SystemMetrics {
  dailyActiveUsers: number
  userGrowth: number
  totalOrganizations: number
  newOrgsThisMonth: number
  databaseUsage: number
  databaseSize: number
  apiRequests: number
  avgResponseTime: number
  uptime: string
  errorRate: number
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
  pricingModel: string
  interval: string | null
  amountCents: number | null
  currency: string | null
  isActive: boolean
  createdAt: string
}

export async function getSystemMetrics(): Promise<SystemMetrics> {
  const supabase = createServiceSupabaseClient()

  // Get basic counts
  const { count: totalOrgs } = await supabase.from("orgs").select("*", { count: "exact", head: true })
  const { count: totalUsers } = await supabase.from("app_users").select("*", { count: "exact", head: true })

  // Get new orgs this month
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const { count: newOrgsThisMonth } = await supabase
    .from("orgs")
    .select("*", { count: "exact", head: true })
    .gte("created_at", startOfMonth.toISOString())

  // Mock data for other metrics (in a real system these would come from monitoring services)
  return {
    dailyActiveUsers: Math.floor(totalUsers! * 0.3), // Estimate 30% daily active
    userGrowth: 12, // Mock growth percentage
    totalOrganizations: totalOrgs || 0,
    newOrgsThisMonth: newOrgsThisMonth || 0,
    databaseUsage: 65, // Mock percentage
    databaseSize: 2.4, // Mock GB
    apiRequests: 125000, // Mock requests
    avgResponseTime: 145, // Mock ms
    uptime: "99.9%", // Mock uptime
    errorRate: 0.1, // Mock error rate
    fileStorageUsed: 45, // Mock GB
    fileStorageLimit: 100, // Mock GB limit
    bandwidthUsed: 120, // Mock GB
    bandwidthLimit: 500, // Mock GB limit
  }
}

export async function getUsageTrends(): Promise<UsageTrends> {
  // Mock usage trend data
  const userGrowth: UsageTrend[] = [
    { month: "Dec 2024", count: 45, change: 15 },
    { month: "Jan 2025", count: 52, change: 16 },
    { month: "Feb 2025", count: 61, change: 17 },
    { month: "Mar 2025", count: 68, change: 11 },
    { month: "Apr 2025", count: 74, change: 9 },
    { month: "May 2025", count: 82, change: 11 },
  ]

  const featureUsage: FeatureUsage[] = [
    { name: "Project Management", usage: 1250, change: 8 },
    { name: "Document Upload", usage: 890, change: -3 },
    { name: "Reporting", usage: 650, change: 22 },
    { name: "Team Collaboration", usage: 580, change: 15 },
    { name: "Invoice Generation", usage: 420, change: 5 },
  ]

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

  return (data || []).map(plan => ({
    code: plan.code,
    name: plan.name,
    pricingModel: plan.pricing_model,
    interval: plan.interval,
    amountCents: plan.amount_cents,
    currency: plan.currency,
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