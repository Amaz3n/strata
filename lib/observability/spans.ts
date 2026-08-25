import "server-only"

import * as Sentry from "@sentry/nextjs"

import { logger } from "@/lib/logging/logger"

/**
 * Coarse server spans for the latency budgets Arc commits to.
 *
 * Attributes are deliberately LOW CARDINALITY — posture, band name, a row count.
 * Never pass a project id, org id, user id, or any customer string: these land in
 * Sentry's span index and in the structured log line, and high-cardinality tags
 * there are both a cost problem and a privacy problem.
 */
export type SpanAttributes = Record<string, string | number | boolean>

/**
 * The p95 targets each named span is measured against. Kept here rather than in a
 * doc so the names in code and the names in the SLO cannot drift apart.
 */
export const LATENCY_BUDGETS_MS: Record<string, number> = {
  "project.identity": 300,
  "project.operations": 700,
  "project.financials": 1500,
  "projects.index": 1000,
}

/**
 * Open a span only from inside a dynamic scope — after a cookie or header read.
 * A span records a start time, and reading the clock during a static prerender
 * aborts the shell Next.js would otherwise serve instantly.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now()
  try {
    return await Sentry.startSpan({ name, op: "arc.read", attributes }, work)
  } finally {
    const durationMs = Math.round(performance.now() - startedAt)
    const budgetMs = LATENCY_BUDGETS_MS[name]
    const context = { span: name, durationMs, budgetMs, ...attributes }
    // Budgets are production numbers. A dev timing carries Turbopack compilation
    // and an uncached session, so warning on it would train people to ignore the
    // warning that matters.
    if (process.env.NODE_ENV === "production" && budgetMs !== undefined && durationMs > budgetMs) {
      logger.warn("perf.span.over_budget", context)
    } else {
      logger.debug("perf.span", context)
    }
  }
}
