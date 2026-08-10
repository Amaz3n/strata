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
  recordFigure,
  recordToolSummary,
  resultRef,
  setArtifact,
  type AssistantToolState,
} from "@/lib/services/ai-assistant/state"
import type { OrgServiceContext } from "@/lib/services/context"
import { hasAnyPermission } from "@/lib/services/permissions"
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

/**
 * What a caller must hold to run each metric.
 *
 * These tools query the financial tables directly rather than through search, so
 * the retrieval-layer clearance check never sees them. Without this, a member
 * with no `invoice.read` could not find a single invoice in search and could
 * still ask for the org's open AR and be given the number.
 *
 * A metric drawing on two domains requires either — matching how the UI works,
 * where budget-versus-commitment is visible to anyone who can see one side.
 */
const FINANCE_PERMISSIONS: Record<CanonicalMetricKey | "ar_snapshot", string[]> = {
  ar_snapshot: ["invoice.read"],
  revenue_billed: ["invoice.read"],
  cash_collected: ["invoice.read"],
  open_ar: ["invoice.read"],
  overdue_ar: ["invoice.read"],
  budget_commitment_gap: ["budget.read", "commitment.read"],
}

function financeDenied(state: AssistantToolState, metric: string): AiAssistantToolOutput {
  // Worded as clearance, not as absence. "You have no overdue AR" and "you
  // cannot see AR" are different answers and only one of them is true.
  const summary = `Your role cannot view the records behind ${
    isCanonicalMetricKey(metric) ? FINANCE_LABELS[metric].toLowerCase() : metric
  }.`
  addMissingData(state, [summary])
  recordToolSummary(state, "finance_metric", summary)
  return { narrative_summary: summary, rows: 0, result_refs: [], missing_data: [summary] }
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
        const required = FINANCE_PERMISSIONS[input.metric as CanonicalMetricKey | "ar_snapshot"]
        if (required && !(await hasAnyPermission(required, context))) {
          return financeDenied(state, input.metric)
        }

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
          recordFigure(state, "AR snapshot rows", execution.rows)
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
        // Declared so the answer can quote them; cents are converted here
        // because the model writes dollars, never cents.
        recordFigure(state, FINANCE_LABELS[input.metric], execution.metricValue)
        if (execution.metricValueCents != null) {
          recordFigure(state, FINANCE_LABELS[input.metric], execution.metricValueCents / 100)
        }
        recordFigure(state, `${FINANCE_LABELS[input.metric]} rows`, execution.rowCount)
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
