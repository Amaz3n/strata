"use server"

import type { SupabaseClient } from "@supabase/supabase-js"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

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
}

// Entity search configurations
const SEARCH_CONFIGS: Record<SearchEntityType, {
  table: string
  titleField: string
  subtitleFields?: string[]
  descriptionFields?: string[]
  searchableFields: string[]
  hrefTemplate: string
  filters?: Record<string, any>
  joins?: string[]
}> = {
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
  let joins = config.joins?.join(' ') || ''

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
  console.log('🔍 searchEntities called with:', { query, entityTypes, filters, options })

  const { supabase, orgId: resolvedOrgId } = context || await requireOrgContext(orgId)
  console.log('🔍 Using orgId:', resolvedOrgId)

  // Default to key entity types if none specified
  const typesToSearch = entityTypes.length > 0 ? entityTypes : [
    'project', 'task', 'file', 'contact', 'company'
  ]
  console.log('🔍 Searching entity types:', typesToSearch)

  const results: SearchResult[] = []
  const promises: Promise<void>[] = []

  // Search each entity type in parallel
  for (const entityType of typesToSearch) {
    promises.push(
      (async () => {
        try {
          console.log(`🔍 Searching ${entityType}...`)
          const config = SEARCH_CONFIGS[entityType]
          const result = await searchSingleEntity(supabase, resolvedOrgId, entityType, query, filters, options)
          console.log(`🔍 ${entityType} returned ${result.length} results`)
          results.push(...result)
        } catch (error) {
          console.error(`❌ Failed to search ${entityType}:`, error)
        }
      })()
    )
  }

  await Promise.all(promises)

  // Sort results by relevance (simple implementation - could be enhanced)
  results.sort((a, b) => {
    // Projects first, then by creation date
    if (a.type === 'project' && b.type !== 'project') return -1
    if (b.type === 'project' && a.type !== 'project') return 1

    // Sort by updated_at desc
    const aTime = new Date(a.updated_at || a.created_at || 0).getTime()
    const bTime = new Date(b.updated_at || b.created_at || 0).getTime()
    return bTime - aTime
  })

  return results.slice(0, options.limit || 50)
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

  // Build query builder with simple select first
  let queryBuilder = supabase
    .from(config.table)
    .select('*')
    .eq('org_id', orgId)
    .limit(limit)

  // Add project join if needed
  if (hasProject && entityType !== 'project') {
    queryBuilder = supabase
      .from(config.table)
      .select('*, projects!inner(name)')
      .eq('org_id', orgId)
      .limit(limit)
  }

  // Add search filter
  if (query.trim()) {
    // Use ILIKE for simple text search (we'll enhance this with FTS later)
    const searchConditions = config.searchableFields.map(field => `${field}.ilike.%${query}%`)
    const orCondition = searchConditions.join(',')
    console.log(`🔍 ${entityType} search condition:`, orCondition)
    queryBuilder = queryBuilder.or(orCondition)
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

  // Execute query
  console.log(`🔍 ${entityType} executing query...`)
  const { data, error } = await queryBuilder
  console.log(`🔍 ${entityType} query result:`, { dataLength: data?.length || 0, error })

  if (error) {
    console.error(`❌ Search error for ${entityType}:`, error)
    return []
  }

  if (!data) return []

  // Transform results
  return data.map(row => {
    const result: SearchResult = {
      id: row.id,
      type: entityType,
      title: row[config.titleField] || `Untitled ${entityType}`,
      href: config.hrefTemplate.replace('{id}', row.id),
      created_at: row.created_at,
      updated_at: row.updated_at,
      project_id: row.project_id,
      project_name: row.projects?.name,
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