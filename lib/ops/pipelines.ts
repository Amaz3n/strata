/**
 * The production pipelines the watchdog alerts on beyond payments: what each
 * one's failed units are, which scheduled jobs carry its work, who is told, and
 * what fixes it. One table, read by the watchdog (alert routing), the event
 * copy (what the email says) and the Ops pipelines page (where the operator
 * finds the unit and its recovery), so the three cannot drift.
 */
export const PIPELINE_KEYS = ["starts", "imports", "warranty"] as const
export type PipelineKey = (typeof PIPELINE_KEYS)[number]

/** Codes returned by `operations_pipeline_findings()` that name failed or stuck units. */
type PipelineFailureCode =
  | "starts_release_attention"
  | "starts_jobs_failed"
  | "import_failed"
  | "import_stalled"
  | "warranty_jobs_failed"

interface PipelineDefinition {
  label: string
  /**
   * Scheduled jobs whose death leaves this pipeline's work undone (CRON_JOBS
   * names), each with the `operations_pipeline_findings()` code naming the orgs
   * whose work is waiting on that job.
   */
  jobs: ReadonlyArray<{ name: string; backlogCode: string }>
  failures: readonly PipelineFailureCode[]
  /** Who hears about it, by permission (org admins always do). */
  audience: readonly string[]
}

export const PIPELINES: Record<PipelineKey, PipelineDefinition> = {
  starts: {
    label: "Starts",
    jobs: [{ name: "starts-pipeline", backlogCode: "starts_backlog" }],
    failures: ["starts_release_attention", "starts_jobs_failed"],
    audience: ["start.release"],
  },
  imports: {
    label: "Imports",
    // Builder-run imports commit inline; only the Open-WIP cutover resumes from a
    // scheduled job, and Open-WIP is platform work (OPEN_WIP_ATTENTION_DETAIL).
    jobs: [],
    failures: ["import_failed", "import_stalled"],
    audience: ["import.manage"],
  },
  warranty: {
    label: "Warranty",
    jobs: [
      // Coverage enrollment is an outbox job; the sweeps read open requests.
      { name: "process-outbox", backlogCode: "warranty_jobs_backlog" },
      { name: "warranty-sla-sweep", backlogCode: "warranty_requests_open" },
      { name: "warranty-courtesy-inspections", backlogCode: "warranty_requests_open" },
    ],
    failures: ["warranty_jobs_failed"],
    audience: ["warranty.manage"],
  },
}

/** The alert sentence for an incident: what is wrong and what fixes it. */
export const PIPELINE_FAILURE_DETAIL: Record<PipelineFailureCode, string> = {
  starts_release_attention: "A start release stopped partway and needs attention. Open the start package: Retry release requeues it, Cancel release keeps what already landed and returns the rest.",
  starts_jobs_failed: "A starts job (a release or a trade notice) exhausted its retries in the last day. Open the start package to retry the release or the notice.",
  import_failed: "An import failed in the last day. Open it in Settings, Imports to see which rows failed and run it again.",
  import_stalled: "An import has been committing for over 30 minutes without progress. Open it in Settings, Imports and review the batch.",
  warranty_jobs_failed: "A warranty coverage enrollment exhausted its retries in the last day; the home has no coverage until it is requeued.",
}


/**
 * Open-WIP cutovers are run by Arc's onboarding team from the platform admin,
 * so a failed or stalled one is a platform finding for operators, never an
 * alert to the builder (`open_wip_attention` from `operations_pipeline_findings()`).
 */
export const OPEN_WIP_ATTENTION_DETAIL = "An Open-WIP cutover failed or stopped making progress. Open Ops, Pipelines: Commit again resumes from the homes already built with their receipts; a stalled cutover resumes on the next outbox run once its claim lapses."
