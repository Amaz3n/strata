"use server"

import type { SupabaseClient } from "@supabase/supabase-js"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"

// Search result types
export interface SearchResult {
  id: string
  type: SearchEntityType
  title: string
  subtitle?: string
  description?: string
  href: string
  metadata?: Record<string, any>
  score?: number
  created_at?: string
  updated_at?: string
  project_id?: string
  project_name?: string
}

export type SearchEntityType =
  | 'project'
  | 'task'
  | 'file'
  | 'contact'
  | 'company'
  | 'invoice'
  | 'payment'
  | 'budget'
  | 'estimate'
  | 'commitment'
  | 'change_order'
  | 'contract'
  | 'proposal'
  | 'conversation'
  | 'message'
  | 'rfi'
  | 'submittal'
  | 'drawing_set'
  | 'drawing_sheet'
  | 'daily_log'
  | 'punch_item'
  | 'schedule_item'
  | 'photo'
  | 'portal_access'

export interface SearchFilters {
  entityTypes?: SearchEntityType[]
  projectId?: string
  status?: string[]
  dateFrom?: string
  dateTo?: string
  amountMin?: number
  amountMax?: number
  createdBy?: string
}

export interface SearchOptions {
  limit?: number
  offset?: number
  sortBy?: 'relevance' | 'created_at' | 'updated_at'
  sortOrder?: 'asc' | 'desc'
  preferFast?: boolean
}

type SearchEntityConfig = {
  table: string
  titleField: string
  subtitleFields?: string[]
  descriptionFields?: string[]
  searchableFields: string[]
  hrefTemplate: string
  filters?: Record<string, any>
  joins?: string[]
}

const DEFAULT_SEARCH_LIMIT = 50
const UNIFIED_INDEX_SHORT_CIRCUIT_RATIO = 0.6
const UNIFIED_INDEX_SHORT_CIRCUIT_MIN = 8
const ENTITY_QUERY_MIN_LIMIT = 6
const ENTITY_QUERY_MAX_LIMIT = 20
const SEARCH_DOCUMENT_BACKFILL_TTL_MS = 1000 * 60 * 10
const SEARCH_DOCUMENT_BACKFILL_MAX_BATCH = 12

const searchDocumentBackfillSeenAt = new Map<string, number>()

function sanitizeSearchTerm(query: string) {
  return query
    .replace(/[,%()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function shouldForceEntityFanout(filters: SearchFilters) {
  return Boolean(
    filters.projectId ||
      (filters.status && filters.status.length > 0) ||
      filters.dateFrom ||
      filters.dateTo ||
      filters.amountMin !== undefined ||
      filters.amountMax !== undefined ||
      filters.createdBy,
  )
}

function shouldShortCircuitUnifiedIndex(indexedCount: number, limit: number, filters: SearchFilters, preferFast = false) {
  if (shouldForceEntityFanout(filters)) return false
  if (preferFast) {
    const fastTarget = Math.min(limit, Math.max(1, Math.ceil(limit * 0.25)))
    return indexedCount >= fastTarget
  }
  const target = Math.min(limit, Math.max(UNIFIED_INDEX_SHORT_CIRCUIT_MIN, Math.ceil(limit * UNIFIED_INDEX_SHORT_CIRCUIT_RATIO)))
  return indexedCount >= target
}

function pruneSearchDocumentBackfillCache(now = Date.now()) {
  if (searchDocumentBackfillSeenAt.size === 0) return
  for (const [key, seenAt] of searchDocumentBackfillSeenAt.entries()) {
    if (now - seenAt > SEARCH_DOCUMENT_BACKFILL_TTL_MS) {
      searchDocumentBackfillSeenAt.delete(key)
    }
  }
}

function buildSearchDocumentBackfillKey(orgId: string, result: SearchResult) {
  return `${orgId}:${result.type}:${result.id}:${result.updated_at ?? result.created_at ?? ""}`
}

function buildEntitySelectClause(entityType: SearchEntityType, config: SearchEntityConfig, includeProject: boolean) {
  const fields = new Set<string>(["id", "created_at", "updated_at", config.titleField])
  if (entityType !== "project") fields.add("project_id")
  for (const field of config.subtitleFields ?? []) fields.add(field)
  for (const field of config.descriptionFields ?? []) fields.add(field)

  const baseSelect = Array.from(fields).join(",")
  return includeProject && entityType !== "project" ? `${baseSelect},projects(name)` : baseSelect
}

function isSearchEntityType(value: unknown): value is SearchEntityType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SEARCH_CONFIGS, value)
}

async function searchViaUnifiedIndex(
  supabase: SupabaseClient,
  orgId: string,
  query: string,
  entityTypes: SearchEntityType[],
  limit: number,
): Promise<SearchResult[]> {
  const cleaned = sanitizeSearchTerm(query)
  if (!cleaned) return []

  const { data, error } = await supabase
    .from("search_documents")
    .select("entity_type,entity_id,title,project_id,metadata,updated_at,created_at")
    .eq("org_id", orgId)
    .textSearch("search_vector", cleaned, {
      type: "websearch",
      config: "english",
    })
    .limit(Math.max(limit, 50))

  if (error || !Array.isArray(data)) {
    return []
  }

  const allowedTypes = new Set<SearchEntityType>(entityTypes)
  const rows = data
    .map((entry) => {
      const row = entry as Record<string, unknown>
      const type = isSearchEntityType(row.entity_type) ? row.entity_type : null
      if (!type) return null
      if (allowedTypes.size > 0 && !allowedTypes.has(type)) return null

      const id = typeof row.entity_id === "string" ? row.entity_id : null
      if (!id) return null

      const metadata = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {}
      const config = SEARCH_CONFIGS[type]
      const href =
        typeof metadata.href === "string" && metadata.href.length > 0
          ? metadata.href
          : config.hrefTemplate.replace("{id}", id)

      const normalized: SearchResult = {
        id,
        type,
        title:
          typeof row.title === "string" && row.title.trim().length > 0
            ? row.title
            : (typeof metadata.title === "string" ? metadata.title : `Untitled ${type}`),
        href,
      }

      if (typeof metadata.subtitle === "string") normalized.subtitle = metadata.subtitle
      if (typeof metadata.description === "string") normalized.description = metadata.description
      if (typeof row.project_id === "string") {
        normalized.project_id = row.project_id
      } else if (typeof metadata.project_id === "string") {
        normalized.project_id = metadata.project_id
      }
      if (typeof metadata.project_name === "string") normalized.project_name = metadata.project_name
      if (typeof row.created_at === "string") normalized.created_at = row.created_at
      if (typeof row.updated_at === "string") normalized.updated_at = row.updated_at

      return normalized
    })
    .filter((item): item is SearchResult => item !== null)

  return rows.slice(0, limit)
}

async function upsertSearchDocumentsFromResults(
  supabase: SupabaseClient,
  orgId: string,
  results: SearchResult[],
) {
  if (results.length === 0) return

  const now = Date.now()
  pruneSearchDocumentBackfillCache(now)

  const candidates = results.filter((item) => {
    const key = buildSearchDocumentBackfillKey(orgId, item)
    const seenAt = searchDocumentBackfillSeenAt.get(key)
    if (seenAt && now - seenAt < SEARCH_DOCUMENT_BACKFILL_TTL_MS) {
      return false
    }
    searchDocumentBackfillSeenAt.set(key, now)
    return true
  })

  if (candidates.length === 0) return

  const payload = candidates.slice(0, SEARCH_DOCUMENT_BACKFILL_MAX_BATCH).map((item) => ({
    org_id: orgId,
    entity_type: item.type,
    entity_id: item.id,
    project_id: item.project_id ?? null,
    title: item.title ?? "",
    body: [item.subtitle, item.description].filter((part): part is string => Boolean(part && part.length > 0)).join(" "),
    metadata: {
      href: item.href,
      subtitle: item.subtitle ?? null,
      description: item.description ?? null,
      project_id: item.project_id ?? null,
      project_name: item.project_name ?? null,
      title: item.title ?? null,
    },
    updated_at: item.updated_at ?? item.created_at ?? new Date().toISOString(),
  }))

  const { error } = await supabase.from("search_documents").upsert(payload, {
    onConflict: "org_id,entity_type,entity_id",
  })

  if (error) {
    // Keep search serving resilient if search_documents is unavailable.
    return
  }
}

// Entity search configurations
const SEARCH_CONFIGS: Record<SearchEntityType, SearchEntityConfig> = {
  project: {
    table: 'projects',
    titleField: 'name',
    subtitleFields: ['status'],
    descriptionFields: ['description'],
    searchableFields: ['name', 'description'],
    hrefTemplate: '/projects/{id}',
  },
  task: {
    table: 'tasks',
    titleField: 'title',
    subtitleFields: ['status', 'priority'],
    descriptionFields: ['description'],
    searchableFields: ['title', 'description'],
    hrefTemplate: '/tasks/{id}',
    joins: ['LEFT JOIN projects p ON t.project_id = p.id'],
  },
  file: {
    table: 'files',
    titleField: 'file_name',
    subtitleFields: ['category', 'size_bytes'],
    descriptionFields: ['description'],
    searchableFields: ['file_name', 'description'],
    hrefTemplate: '/files/{id}',
    joins: ['LEFT JOIN projects p ON f.project_id = p.id'],
  },
  contact: {
    table: 'contacts',
    titleField: 'full_name',
    subtitleFields: ['email', 'role'],
    searchableFields: ['full_name', 'email', 'phone', 'role'],
    hrefTemplate: '/contacts/{id}',
    joins: ['LEFT JOIN companies c ON contacts.primary_company_id = c.id'],
  },
  company: {
    table: 'companies',
    titleField: 'name',
    subtitleFields: ['company_type', 'email'],
    searchableFields: ['name', 'email', 'phone', 'website'],
    hrefTemplate: '/companies/{id}',
  },
  invoice: {
    table: 'invoices',
    titleField: 'title',
    subtitleFields: ['invoice_number', 'status', 'total_cents'],
    searchableFields: ['title', 'invoice_number', 'notes'],
    hrefTemplate: '/invoices/{id}',
    joins: ['LEFT JOIN projects p ON i.project_id = p.id'],
  },
  payment: {
    table: 'payments',
    titleField: 'reference',
    subtitleFields: ['amount_cents', 'method', 'status'],
    searchableFields: ['reference', 'method'],
    hrefTemplate: '/payments/{id}',
    joins: ['LEFT JOIN projects p ON pay.project_id = p.id'],
  },
  budget: {
    table: 'budgets',
    titleField: 'id',
    subtitleFields: ['status', 'total_cents'],
    searchableFields: ['status'],
    hrefTemplate: '/budgets/{id}',
    joins: ['LEFT JOIN projects p ON b.project_id = p.id'],
  },
  estimate: {
    table: 'estimates',
    titleField: 'title',
    subtitleFields: ['status', 'total_cents'],
    searchableFields: ['title', 'status'],
    hrefTemplate: '/estimates/{id}',
    joins: ['LEFT JOIN projects p ON e.project_id = p.id'],
  },
  commitment: {
    table: 'commitments',
    titleField: 'title',
    subtitleFields: ['status', 'total_cents'],
    searchableFields: ['title', 'external_reference'],
    hrefTemplate: '/commitments/{id}',
    joins: ['LEFT JOIN projects p ON c.project_id = p.id'],
  },
  change_order: {
    table: 'change_orders',
    titleField: 'title',
    subtitleFields: ['status', 'total_cents'],
    descriptionFields: ['description', 'reason'],
    searchableFields: ['title', 'description', 'reason', 'summary'],
    hrefTemplate: '/change-orders/{id}',
    joins: ['LEFT JOIN projects p ON co.project_id = p.id'],
  },
  contract: {
    table: 'contracts',
    titleField: 'title',
    subtitleFields: ['status', 'number', 'total_cents'],
    searchableFields: ['title', 'number', 'terms'],
    hrefTemplate: '/contracts/{id}',
    joins: ['LEFT JOIN projects p ON con.project_id = p.id'],
  },
  proposal: {
    table: 'proposals',
    titleField: 'title',
    subtitleFields: ['status', 'number', 'total_cents'],
    descriptionFields: ['summary', 'terms'],
    searchableFields: ['title', 'number', 'summary', 'terms'],
    hrefTemplate: '/proposals/{id}',
    joins: ['LEFT JOIN projects p ON prop.project_id = p.id'],
  },
  conversation: {
    table: 'conversations',
    titleField: 'subject',
    subtitleFields: ['channel'],
    searchableFields: ['subject'],
    hrefTemplate: '/conversations/{id}',
    joins: ['LEFT JOIN projects p ON conv.project_id = p.id'],
  },
  message: {
    table: 'messages',
    titleField: 'body',
    subtitleFields: ['message_type'],
    searchableFields: ['body'],
    hrefTemplate: '/messages/{id}',
    joins: ['LEFT JOIN conversations conv ON m.conversation_id = conv.id', 'LEFT JOIN projects p ON conv.project_id = p.id'],
  },
  rfi: {
    table: 'rfis',
    titleField: 'subject',
    subtitleFields: ['rfi_number', 'status'],
    descriptionFields: ['question'],
    searchableFields: ['subject', 'question', 'drawing_reference', 'spec_reference', 'location'],
    hrefTemplate: '/rfis/{id}',
    joins: ['LEFT JOIN projects p ON r.project_id = p.id'],
  },
  submittal: {
    table: 'submittals',
    titleField: 'title',
    subtitleFields: ['submittal_number', 'status'],
    descriptionFields: ['description'],
    searchableFields: ['title', 'description', 'spec_section'],
    hrefTemplate: '/submittals/{id}',
    joins: ['LEFT JOIN projects p ON s.project_id = p.id'],
  },
  drawing_set: {
    table: 'drawing_sets',
    titleField: 'title',
    subtitleFields: ['status'],
    descriptionFields: ['description'],
    searchableFields: ['title', 'description'],
    hrefTemplate: '/drawings/sets/{id}',
    joins: ['LEFT JOIN projects p ON ds.project_id = p.id'],
  },
  drawing_sheet: {
    table: 'drawing_sheets',
    titleField: 'sheet_title',
    subtitleFields: ['sheet_number', 'discipline'],
    searchableFields: ['sheet_title', 'sheet_number', 'discipline'],
    hrefTemplate: '/drawings/sheets/{id}',
    joins: ['LEFT JOIN drawing_sets ds ON ds_sheet.drawing_set_id = ds.id', 'LEFT JOIN projects p ON ds.project_id = p.id'],
  },
  daily_log: {
    table: 'daily_logs',
    titleField: 'summary',
    subtitleFields: ['log_date'],
    searchableFields: ['summary'],
    hrefTemplate: '/daily-logs/{id}',
    joins: ['LEFT JOIN projects p ON dl.project_id = p.id'],
  },
  punch_item: {
    table: 'punch_items',
    titleField: 'title',
    subtitleFields: ['status', 'severity'],
    descriptionFields: ['description', 'location'],
    searchableFields: ['title', 'description', 'location'],
    hrefTemplate: '/punch-items/{id}',
    joins: ['LEFT JOIN projects p ON pi.project_id = p.id'],
  },
  schedule_item: {
    table: 'schedule_items',
    titleField: 'name',
    subtitleFields: ['status', 'phase'],
    searchableFields: ['name', 'phase', 'trade', 'location'],
    hrefTemplate: '/schedule/{id}',
    joins: ['LEFT JOIN projects p ON si.project_id = p.id'],
  },
  photo: {
    table: 'photos',
    titleField: 'id',
    subtitleFields: ['taken_at'],
    searchableFields: ['tags'],
    hrefTemplate: '/photos/{id}',
    joins: ['LEFT JOIN projects p ON ph.project_id = p.id'],
  },
  portal_access: {
    table: 'portal_access_tokens',
    titleField: 'id',
    subtitleFields: ['portal_type'],
    searchableFields: [],
    hrefTemplate: '/portal-access/{id}',
    joins: ['LEFT JOIN projects p ON pat.project_id = p.id'],
  },
}

// Helper function to build search query
function buildSearchQuery(
  entityType: SearchEntityType,
  query: string,
  filters: SearchFilters = {},
  options: SearchOptions = {}
): { sql: string; params: any[] } {
  const config = SEARCH_CONFIGS[entityType]
  const { limit = 50, offset = 0, sortBy = 'relevance', sortOrder = 'desc' } = options

  // Build table alias
  const tableAlias = entityType.replace('_', '')
  const mainTable = `${config.table} ${tableAlias}`

  // Build joins
  const joins = config.joins?.join(' ') || ''

  // Build WHERE conditions
  const conditions: string[] = [`${tableAlias}.org_id = ?`]
  const params: any[] = []

  // Add query search condition
  if (query.trim()) {
    const searchFields = config.searchableFields
    if (searchFields.length > 0) {
      const searchConditions = searchFields.map(field => {
        const fullField = field.includes('.') ? field : `${tableAlias}.${field}`
        return `COALESCE(${fullField}::text, '') ILIKE ?`
      })
      conditions.push(`(${searchConditions.join(' OR ')})`)
      params.push(...searchFields.map(() => `%${query}%`))
    }
  }

  // Add filters
  if (filters.projectId) {
    if (entityType === 'project') {
      conditions.push(`${tableAlias}.id = ?`)
    } else {
      conditions.push(`${tableAlias}.project_id = ?`)
    }
    params.push(filters.projectId)
  }

  if (filters.status && filters.status.length > 0) {
    conditions.push(`${tableAlias}.status = ANY(?)`)
    params.push(filters.status)
  }

  if (filters.dateFrom) {
    conditions.push(`${tableAlias}.created_at >= ?`)
    params.push(filters.dateFrom)
  }

  if (filters.dateTo) {
    conditions.push(`${tableAlias}.created_at <= ?`)
    params.push(filters.dateTo)
  }

  if (filters.amountMin !== undefined) {
    const amountField = config.searchableFields.find(f => f.includes('_cents')) || 'total_cents'
    conditions.push(`${tableAlias}.${amountField} >= ?`)
    params.push(filters.amountMin)
  }

  if (filters.amountMax !== undefined) {
    const amountField = config.searchableFields.find(f => f.includes('_cents')) || 'total_cents'
    conditions.push(`${tableAlias}.${amountField} <= ?`)
    params.push(filters.amountMax)
  }

  if (filters.createdBy) {
    conditions.push(`${tableAlias}.created_by = ?`)
    params.push(filters.createdBy)
  }

  // Build SELECT
  const selectFields = [
    `${tableAlias}.id`,
    `${tableAlias}.${config.titleField} as title`,
    `${tableAlias}.created_at`,
    `${tableAlias}.updated_at`,
  ]

  if (config.subtitleFields) {
    selectFields.push(...config.subtitleFields.map(f => `${tableAlias}.${f} as ${f}`))
  }

  if (config.descriptionFields) {
    selectFields.push(...config.descriptionFields.map(f => `${tableAlias}.${f} as ${f}`))
  }

  // Add project info for entities that have project_id
  if (entityType !== 'project' && config.joins?.some(j => j.includes('projects'))) {
    selectFields.push('p.id as project_id', 'p.name as project_name')
  }

  const selectClause = selectFields.join(', ')

  // Build ORDER BY
  let orderBy = `${tableAlias}.created_at DESC`
  if (sortBy === 'updated_at') {
    orderBy = `${tableAlias}.updated_at ${sortOrder}`
  } else if (sortBy === 'created_at') {
    orderBy = `${tableAlias}.created_at ${sortOrder}`
  }

  // Build final SQL
  const sql = `
    SELECT ${selectClause}
    FROM ${mainTable}
    ${joins}
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `

  params.push(limit, offset)

  return { sql, params }
}

// Main search function
export async function searchEntities(
  query: string,
  entityTypes: SearchEntityType[] = [],
  filters: SearchFilters = {},
  options: SearchOptions = {},
  orgId?: string,
  context?: OrgServiceContext
): Promise<SearchResult[]> {
  const { supabase, orgId: resolvedOrgId } = context || await requireOrgContext(orgId)
  const targetLimit = Math.max(1, options.limit || DEFAULT_SEARCH_LIMIT)
  const preferFast = options.preferFast === true
  const trimmedQuery = query.trim()

  if (preferFast && trimmedQuery.length < 2) {
    return []
  }

  // Default to key entity types if none specified
  const typesToSearch = entityTypes.length > 0 ? entityTypes : [
    ...(preferFast ? ['project', 'task', 'file'] : ['project', 'task', 'file', 'contact', 'company'])
  ] as SearchEntityType[]

  const results: SearchResult[] = []
  const promises: Promise<void>[] = []
  const canUseUnifiedIndex = !shouldForceEntityFanout(filters)

  if (trimmedQuery && canUseUnifiedIndex) {
    const indexed = await searchViaUnifiedIndex(
      supabase,
      resolvedOrgId,
      trimmedQuery,
      typesToSearch,
      targetLimit,
    )
    if (indexed.length > 0) {
      results.push(...indexed)
      if (shouldShortCircuitUnifiedIndex(indexed.length, targetLimit, filters, preferFast)) {
        return indexed.slice(0, targetLimit)
      }
    }
  }

  const perEntityLimit = preferFast
    ? Math.max(
        ENTITY_QUERY_MIN_LIMIT,
        Math.min(10, Math.ceil((targetLimit * 1.1) / Math.max(1, typesToSearch.length))),
      )
    : Math.max(
        ENTITY_QUERY_MIN_LIMIT,
        Math.min(ENTITY_QUERY_MAX_LIMIT, Math.ceil((targetLimit * 1.4) / Math.max(1, typesToSearch.length))),
      )

  // Search each entity type in parallel
  for (const entityType of typesToSearch) {
    promises.push(
      (async () => {
        try {
          const result = await searchSingleEntity(supabase, resolvedOrgId, entityType, query, filters, {
            ...options,
            limit: perEntityLimit,
          })
          results.push(...result)
        } catch (error) {
          console.error(`Failed to search ${entityType}:`, error)
        }
      })()
    )
  }

  await Promise.all(promises)

  const deduped: SearchResult[] = []
  const seen = new Set<string>()
  for (const item of results) {
    const key = `${item.type}:${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }

  const normalizedQuery = query.trim().toLowerCase()
  const queryTokens = normalizedQuery
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)

  const relevanceScore = (item: SearchResult) => {
    if (!normalizedQuery) return 0
    const title = (item.title ?? "").toLowerCase()
    const subtitle = (item.subtitle ?? "").toLowerCase()
    const description = (item.description ?? "").toLowerCase()

    let score = 0
    if (title === normalizedQuery) score += 240
    if (title.includes(normalizedQuery)) score += 130
    if (subtitle.includes(normalizedQuery)) score += 60
    if (description.includes(normalizedQuery)) score += 40

    for (const token of queryTokens) {
      if (title.includes(token)) score += 25
      if (subtitle.includes(token)) score += 10
      if (description.includes(token)) score += 8
    }

    return score
  }

  // Sort results by relevance, with recency as tiebreaker.
  deduped.sort((a, b) => {
    const scoreDelta = relevanceScore(b) - relevanceScore(a)
    if (scoreDelta !== 0) return scoreDelta

    const aTime = new Date(a.updated_at || a.created_at || 0).getTime()
    const bTime = new Date(b.updated_at || b.created_at || 0).getTime()
    return bTime - aTime
  })

  return deduped.slice(0, targetLimit)
}

// Search a single entity type
async function searchSingleEntity(
  supabase: SupabaseClient,
  orgId: string,
  entityType: SearchEntityType,
  query: string,
  filters: SearchFilters,
  options: SearchOptions
): Promise<SearchResult[]> {
  const config = SEARCH_CONFIGS[entityType]
  const { limit = 10 } = options

  // Determine if this entity has projects
  const hasProject = ['project', 'task', 'file', 'invoice', 'payment', 'budget', 'estimate', 'commitment', 'change_order', 'contract', 'proposal', 'conversation', 'message', 'rfi', 'submittal', 'drawing_set', 'drawing_sheet', 'daily_log', 'punch_item', 'schedule_item', 'photo', 'portal_access'].includes(entityType)
  const includeProject = hasProject && entityType !== 'project'
  const selectClause = buildEntitySelectClause(entityType, config, includeProject)

  // Build query builder with only fields needed for search rendering.
  let queryBuilder = supabase
    .from(config.table)
    .select(selectClause)
    .eq('org_id', orgId)
    .limit(limit)

  // Add search filter
  if (query.trim()) {
    const searchTerm = sanitizeSearchTerm(query)
    if (searchTerm && config.searchableFields.length > 0) {
      const searchConditions = config.searchableFields.map(field => `${field}.ilike.%${searchTerm}%`)
      const orCondition = searchConditions.join(',')
      queryBuilder = queryBuilder.or(orCondition)
    }
  }

  // Add filters
  if (filters.projectId && hasProject && entityType !== 'project') {
    queryBuilder = queryBuilder.eq('project_id', filters.projectId)
  }

  if (filters.status && filters.status.length > 0) {
    queryBuilder = queryBuilder.in('status', filters.status)
  }

  if (filters.dateFrom) {
    queryBuilder = queryBuilder.gte('created_at', filters.dateFrom)
  }

  if (filters.dateTo) {
    queryBuilder = queryBuilder.lte('created_at', filters.dateTo)
  }

  if (filters.createdBy) {
    queryBuilder = queryBuilder.eq('created_by', filters.createdBy)
  }

  const { data, error } = await queryBuilder

  if (error) {
    console.error(`Search error for ${entityType}:`, error)
    return []
  }

  if (!Array.isArray(data) || data.length === 0) return []
  const normalizedRows = data as Array<Record<string, any>>

  // Transform results
  const mappedResults = normalizedRows.map((row) => {
    const projectRelation = row.projects
    const projectName =
      typeof projectRelation?.name === "string"
        ? projectRelation.name
        : Array.isArray(projectRelation) && typeof projectRelation[0]?.name === "string"
          ? projectRelation[0].name
          : undefined

    const result: SearchResult = {
      id: row.id,
      type: entityType,
      title: row[config.titleField] || `Untitled ${entityType}`,
      href: config.hrefTemplate.replace('{id}', row.id),
      created_at: row.created_at,
      updated_at: row.updated_at,
      project_id: row.project_id,
      project_name: projectName,
    }

    // Build subtitle from subtitle fields
    if (config.subtitleFields) {
      const subtitleParts = config.subtitleFields
        .map(field => {
          const val = row[field]
          if (val === null || val === undefined) return null

          // Format specific fields
          if (field === 'total_cents' || field === 'amount_cents') {
            return `$${(val / 100).toLocaleString()}`
          }
          if (field === 'size_bytes') {
            return `${(val / (1024 * 1024)).toFixed(1)} MB`
          }
          if (field === 'status') {
            return val.charAt(0).toUpperCase() + val.slice(1)
          }
          return val
        })
        .filter(val => val !== null)

      if (subtitleParts.length > 0) {
        result.subtitle = subtitleParts.join(' • ')
      }
    }

    // Build description from description fields
    if (config.descriptionFields) {
      const descParts = config.descriptionFields
        .map(field => row[field])
        .filter(val => val !== null && val !== undefined)
      if (descParts.length > 0) {
        result.description = descParts.join(' ')
      }
    }

    return result
  })

  if (query.trim().length > 0) {
    void upsertSearchDocumentsFromResults(supabase, orgId, mappedResults)
  }
  return mappedResults
}

// Simple search function for backward compatibility
export async function searchAll(
  query: string,
  filters: SearchFilters = {},
  options: SearchOptions = {},
  orgId?: string,
  context?: OrgServiceContext
): Promise<SearchResult[]> {
  return searchEntities(query, [], filters, options, orgId, context)
}

// Get search suggestions
export async function getSearchSuggestions(
  query: string,
  orgId?: string,
  context?: OrgServiceContext
): Promise<string[]> {
  const { supabase, orgId: resolvedOrgId } = context || await requireOrgContext(orgId)

  if (!query.trim()) return []

  // Get recent search terms from projects, tasks, and files
  const { data, error } = await supabase
    .from('projects')
    .select('name')
    .eq('org_id', resolvedOrgId)
    .ilike('name', `%${query}%`)
    .limit(5)
    .order('updated_at', { ascending: false })

  if (error) return []

  return (data || []).map(row => row.name).filter(name => name.toLowerCase().includes(query.toLowerCase()))
}
