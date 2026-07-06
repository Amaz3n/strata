import "server-only"

import { tool, zodSchema } from "ai"

import { buildArtifactForFallback } from "@/lib/services/ai-search/artifacts"
import { retrieveHybridResults } from "@/lib/services/ai-search/retrieval"
import {
  addMissingData,
  addRelatedResults,
  recordToolSummary,
  resultRef,
  setArtifact,
  type AssistantToolState,
} from "@/lib/services/ai-assistant/state"
import type { OrgServiceContext } from "@/lib/services/context"
import { getEntityPreview } from "@/lib/services/search-preview"
import { searchEntities, type SearchEntityType, type SearchResult } from "@/lib/services/search"
import {
  aiAssistantToolOutputSchema,
  getRecordInputSchema,
  searchRecordsInputSchema,
  type AiAssistantToolOutput,
  type GetRecordInput,
  type SearchRecordsInput,
} from "@/lib/validation/ai-assistant"

function clampLimit(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(50, Math.floor(value ?? fallback)))
}

function formatEntityType(type: string) {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function createSearchTools({
  context,
  state,
  defaultLimit,
  enableHybridRetrieval,
}: {
  context: OrgServiceContext
  state: AssistantToolState
  defaultLimit: number
  enableHybridRetrieval: boolean
}) {
  return {
    search_records: tool<SearchRecordsInput, AiAssistantToolOutput>({
      description:
        "Search organization records using typed filters. Use this for finding projects, invoices, files, tasks, people, RFIs, submittals, payables, expenses, and other records.",
      inputSchema: zodSchema(searchRecordsInputSchema),
      outputSchema: zodSchema(aiAssistantToolOutputSchema),
      strict: true,
      execute: async (input) => {
        const limit = clampLimit(input.limit, defaultLimit)
        const entityTypes = (input.types ?? []) as SearchEntityType[]
        const filters = {
          projectId: input.projectId,
          status: input.statuses,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          amountMin: input.amountMinCents,
          amountMax: input.amountMaxCents,
        }
        const hasAdvancedFilters = Boolean(
          filters.dateFrom ||
            filters.dateTo ||
            filters.amountMin !== undefined ||
            filters.amountMax !== undefined,
        )

        const results = hasAdvancedFilters
          ? await searchEntities(
              input.query,
              entityTypes,
              filters,
              { limit, sortBy: "updated_at" },
              context.orgId,
              context,
            )
          : await retrieveHybridResults({
              context,
              query: input.query,
              entityTypes,
              filters,
              limit,
              enableHybrid: enableHybridRetrieval,
            })

        addRelatedResults(state, results)
        setArtifact(state, buildArtifactForFallback(context.orgId, results))

        const scope = entityTypes.length > 0 ? ` across ${entityTypes.map(formatEntityType).join(", ")}` : ""
        const summary =
          results.length > 0
            ? `Found ${results.length.toLocaleString()} matching record${results.length === 1 ? "" : "s"}${scope}.`
            : `No strong records matched "${input.query}".`
        if (results.length === 0) {
          addMissingData(state, ["No matching organization records were found for the requested filters."])
        }
        recordToolSummary(state, "search_records", summary)

        return {
          narrative_summary: summary,
          rows: results.length,
          result_refs: results.slice(0, 12).map(resultRef),
          artifact: state.artifact
            ? {
                kind: state.artifact.kind,
                title: state.artifact.title,
              }
            : undefined,
          missing_data: results.length === 0 ? ["No matching records found."] : [],
        }
      },
    }),
    get_record: tool<GetRecordInput, AiAssistantToolOutput>({
      description:
        "Load a compact preview for one organization record when you already know its entity type and id.",
      inputSchema: zodSchema(getRecordInputSchema),
      outputSchema: zodSchema(aiAssistantToolOutputSchema),
      strict: true,
      execute: async (input) => {
        const preview = await getEntityPreview({ type: input.type, id: input.id }, context.orgId, context)
        if (!preview) {
          const summary = `No ${formatEntityType(input.type)} record was found for that id.`
          addMissingData(state, [summary])
          recordToolSummary(state, "get_record", summary)
          return {
            narrative_summary: summary,
            rows: 0,
            result_refs: [],
            missing_data: [summary],
          }
        }

        const details = preview.rows
          .slice(0, 8)
          .map((row) => `${row.label}: ${row.value}`)
          .join("; ")
        const summary = `${formatEntityType(preview.type)} "${preview.title}"${details ? ` (${details})` : ""}.`
        const result: SearchResult = {
          id: preview.id,
          type: preview.type,
          title: preview.title,
          href: preview.href,
          subtitle: preview.status,
          description: preview.description,
          project_id: preview.projectId,
          project_name: preview.projectName,
        }
        addRelatedResults(state, [result])
        recordToolSummary(state, "get_record", summary)

        return {
          narrative_summary: summary,
          rows: 1,
          result_refs: [resultRef(result)],
          missing_data: [],
        }
      },
    }),
  }
}
