import "server-only"

import { tool, zodSchema } from "ai"

import {
  executeCanonicalMetricIntent,
  type CanonicalMetricKey,
} from "@/lib/services/ai-search/financial"
import { executeAiToolInvocation } from "@/lib/services/ai-search/tools"
import {
  addMissingData,
  addRelatedResults,
  recordToolSummary,
  resultRef,
  setArtifact,
  type AssistantToolState,
} from "@/lib/services/ai-assistant/state"
import type { OrgServiceContext } from "@/lib/services/context"
import {
  aiAssistantToolOutputSchema,
  financeMetricInputSchema,
  type AiAssistantToolOutput,
  type FinanceMetricInput,
} from "@/lib/validation/ai-assistant"

const FINANCE_LABELS: Record<CanonicalMetricKey, string> = {
  revenue_billed: "Revenue billed",
  cash_collected: "Cash collected",
  open_ar: "Open AR",
  overdue_ar: "Overdue AR",
  budget_commitment_gap: "Budget commitment gap",
}

function isCanonicalMetricKey(value: string): value is CanonicalMetricKey {
  return Object.prototype.hasOwnProperty.call(FINANCE_LABELS, value)
}

function clampLimit(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(50, Math.floor(value ?? fallback)))
}

export function createFinanceTools({
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
    finance_metric: tool<FinanceMetricInput, AiAssistantToolOutput>({
      description:
        "Run canonical financial metrics. Use this for AR, overdue AR, revenue billed, cash collected, and budget-vs-commitment questions. Do not compute these numbers yourself.",
      inputSchema: zodSchema(financeMetricInputSchema),
      outputSchema: zodSchema(aiAssistantToolOutputSchema),
      strict: true,
      execute: async (input) => {
        if (input.metric === "ar_snapshot") {
          const execution = await executeAiToolInvocation(context, {
            toolKey: "finance.ar_snapshot",
            reason: "Canonical AR snapshot requested through tool calling.",
            confidence: 1,
            args: {},
          })
          if (!execution) {
            const summary = "AR snapshot is unavailable right now."
            addMissingData(state, [summary])
            recordToolSummary(state, "finance_metric", summary)
            return {
              narrative_summary: summary,
              rows: 0,
              result_refs: [],
              missing_data: [summary],
            }
          }

          addRelatedResults(state, execution.relatedResults)
          const summary = execution.summary
          recordToolSummary(state, "finance_metric", summary)
          return {
            narrative_summary: summary,
            rows: execution.rows,
            result_refs: execution.relatedResults.slice(0, 12).map(resultRef),
            missing_data: [],
          }
        }

        if (!isCanonicalMetricKey(input.metric)) {
          const summary = `Unsupported finance metric: ${input.metric}.`
          addMissingData(state, [summary])
          recordToolSummary(state, "finance_metric", summary)
          return {
            narrative_summary: summary,
            rows: 0,
            result_refs: [],
            missing_data: [summary],
          }
        }

        const execution = await executeCanonicalMetricIntent(
          {
            key: input.metric,
            label: FINANCE_LABELS[input.metric],
            projectName: input.projectName,
            dateRangeDays: input.dateRangeDays,
            groupBy: input.groupBy ?? "none",
            limit: clampLimit(input.limit, defaultLimit),
          },
          context,
          {
            enableHybridRetrieval,
          },
        )

        addRelatedResults(state, execution.relatedResults)
        addMissingData(state, execution.missingData)
        setArtifact(state, execution.artifactData)
        recordToolSummary(state, "finance_metric", execution.summary)

        return {
          narrative_summary: execution.summary,
          rows: execution.rowCount,
          result_refs: execution.relatedResults.slice(0, 12).map(resultRef),
          artifact: execution.artifactData.artifact
            ? {
                kind: execution.artifactData.artifact.kind,
                title: execution.artifactData.artifact.title,
              }
            : undefined,
          missing_data: execution.missingData,
        }
      },
    }),
  }
}
