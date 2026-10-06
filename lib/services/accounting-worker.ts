import type { NextRequest } from "next/server"

import {
  accountingDeliveryDeadline,
  withAccountingDeadline,
} from "@/lib/services/accounting-delivery"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { createAccountingWorkerSupabaseClient } from "@/lib/supabase/server"
import { runWithServiceSupabaseClient } from "@/lib/supabase/service-client-context"
import {
  runWithWorkerDatabaseScope,
  withWorkerDatabaseNormal,
  withWorkerDatabasePersistence,
} from "@/lib/supabase/worker-request-context"

/** Main provider/claim budget: 85s. SQL-only completion and telemetry cutoff: 90s total. */
export function withAccountingWorkerCron(
  jobName: string,
  handler: (request: NextRequest) => Promise<Response>,
) {
  return async (request: NextRequest): Promise<Response> => {
    // Preserve unauthorized probes even when the service environment is absent.
    if (!isAuthorizedCronRequest(request)) return handler(request)
    const started = Date.now()
    const mainDeadline = Math.min(
      started + 85_000,
      accountingDeliveryDeadline() ?? Infinity,
    )
    const finalDeadline =
      mainDeadline <= started
        ? mainDeadline
        : Math.min(started + 90_000, mainDeadline + 5_000)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const cutoff = new Promise<Response>((resolve) => {
      timer = setTimeout(
        () => {
          controller.abort(
            new Error("Accounting worker final deadline reached"),
          )
          resolve(
            Response.json(
              {
                error: "Accounting worker final deadline reached",
                budgetExhausted: true,
              },
              { status: 503 },
            ),
          )
        },
        Math.max(0, finalDeadline - Date.now()),
      )
    })
    const work = Promise.resolve().then(() =>
      runWithWorkerDatabaseScope(
        {
          deadline: () => accountingDeliveryDeadline() ?? mainDeadline,
          finalDeadline,
          signal: controller.signal,
        },
        () =>
          withAccountingDeadline(mainDeadline, () =>
            runWithServiceSupabaseClient(
              createAccountingWorkerSupabaseClient(),
              () =>
                // Only the wrapper's final telemetry uses this allowance. Handler SQL
                // resolves the earlier worker/tenant deadline through the normal scope.
                withWorkerDatabasePersistence(finalDeadline, () =>
                  withCronRun(jobName, (request) =>
                    withWorkerDatabaseNormal(() => handler(request)),
                  )(request),
                ),
            ),
          ),
      ),
    )
    // Auth may finish SDK-local retry sleeps later. The race observes its late
    // rejection; aborted/expired fetch scopes prevent any later HTTP dispatch.
    try {
      return await Promise.race([work, cutoff])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
