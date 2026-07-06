import "server-only"

import { tool, zodSchema } from "ai"

import {
  executeAnalyticsToolLayer,
  type AnalyticsGroupBy,
  type AnalyticsMetric,
} from "@/lib/services/ai-search/analytics"
import { buildArtifactForAnalyticsIntent } from "@/lib/services/ai-search/artifacts"
import {
  addRelatedResults,
  recordToolSummary,
  resultRef,
  setArtifact,
  type AssistantToolState,
} from "@/lib/services/ai-assistant/state"
import type { OrgServiceContext } from "@/lib/services/context"
import type { SearchEntityType } from "@/lib/services/search"
import {
  aiAssistantToolOutputSchema,
  analyticsInputSchema,
  type AiAssistantToolOutput,
  type AnalyticsInput,
} from "@/lib/validation/ai-assistant"

function clampLimit(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(50, Math.floor(value ?? fallback)))
}

export function createAnalyticsTools({
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
    run_analytics: tool<AnalyticsInput, AiAssistantToolOutput>({
      description:
        "Run grouped or time-bucketed analytics over organization records. Use this for counts, sums, averages, status breakdowns, monthly charts, project breakdowns, and AR aging-style bucketed invoice analytics.",
      inputSchema: zodSchema(analyticsInputSchema),
      outputSchema: zodSchema(aiAssistantToolOutputSchema),
      strict: true,
      execute: async (input) => {
        const execution = await executeAnalyticsToolLayer(
          {
            kind: "analytics",
            operation: "aggregate",
            entityType: input.entityType as SearchEntityType,
            metric: (input.metric ?? "count") as AnalyticsMetric,
            groupBy: (input.groupBy ?? "none") as AnalyticsGroupBy,
            statuses: input.statuses ?? [],
            textQuery: input.textQuery ?? "",
            projectName: input.projectName,
            dateRangeDays: input.dateRangeDays,
            limit: clampLimit(input.limit, defaultLimit),
          },
          context,
          {
            enableHybridRetrieval,
          },
        )

        const artifactData = buildArtifactForAnalyticsIntent({
          orgId: context.orgId,
          execution,
          chartType: input.chartType,
        })

        addRelatedResults(state, execution.relatedResults)
        setArtifact(state, artifactData)
        recordToolSummary(state, "run_analytics", execution.answer)

        return {
          narrative_summary: execution.answer,
          rows: execution.rowCount,
          result_refs: execution.relatedResults.slice(0, 12).map(resultRef),
          artifact: artifactData.artifact
            ? {
                kind: artifactData.artifact.kind,
                title: artifactData.artifact.title,
              }
            : undefined,
          missing_data:
            execution.rowCount > 0
              ? []
              : ["No records matched the requested analytics scope."],
        }
      },
    }),
  }
}
