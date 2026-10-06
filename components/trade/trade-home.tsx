import Link from "next/link";
import { PageLayout } from "@/components/layout/page-layout";
import { Button } from "@/components/ui/button";
import { NewTradeJob } from "@/components/trade/new-job";
import { getTradeWorkspace } from "@/lib/services/trade-workspace";
import { formatLocalDate } from "@/lib/utils";

export async function TradeHome() {
  const data = await getTradeWorkspace();
  const names = new Map(data.jobs.map((job) => [job.id, job.name]));
  const people = new Map(
    data.members.map((member) => [
      member.user_id,
      member.user?.full_name ?? member.user?.email ?? "Crew member",
    ]),
  );
  return (
    <PageLayout title="Today">
      <div className="space-y-9 desk-rise">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Arc Trade · {data.profile.specialty}
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">
              Your work, in one place
            </h1>
          </div>
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/trade/connections">Builder connections</Link>
            </Button>
            {data.canManage && (
              <NewTradeJob
                contacts={data.contacts}
                contactsTotal={data.contactsTotal}
                defaultJobType={data.defaultJobType}
              />
            )}
          </div>
        </div>
        {data.jobsTotal === 0 ? (
          <section className="max-w-xl space-y-3 py-8">
            <h2 className="text-base font-semibold">
              Start with your first job
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Add a job for any customer, or open an invitation from a builder.
              Your estimates, crew costs, and internal records stay in your
              company workspace.
            </p>
            <div className="flex flex-wrap gap-3">
              {data.canPipeline && (
                <Button asChild variant="outline" size="sm">
                  <Link href="/pipeline">Price an opportunity</Link>
                </Button>
              )}
              {data.canSetup && (
                <Button asChild variant="ghost" size="sm">
                  <Link href="/trade/setup">Set up your company →</Link>
                </Button>
              )}
            </div>
          </section>
        ) : (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                Active jobs{" "}
                <span className="ml-1 text-muted-foreground">
                  {data.jobsTotal}
                </span>
              </h2>
              <Link
                className="text-xs text-muted-foreground hover:text-foreground"
                href="/projects"
              >
                All jobs →
              </Link>
            </div>
            <div className="divide-y border-y">
              {data.jobs.slice(0, 12).map((job) => (
                <div
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <Link
                    className="min-w-0 flex-1 hover:underline"
                    href={`/projects/${job.id}`}
                  >
                    <span className="block truncate text-sm font-medium">
                      {job.name}
                    </span>
                    <span className="text-xs capitalize text-muted-foreground">
                      {job.status.replaceAll("_", " ")}
                    </span>
                  </Link>
                  <div className="flex gap-4 text-xs">
                    {data.canTime && (
                      <Link
                        href={`/projects/${job.id}/time`}
                        className="hover:underline"
                      >
                        Log time
                      </Link>
                    )}
                    {data.canChanges && (
                      <Link
                        href={`/projects/${job.id}/change-orders`}
                        className="hover:underline"
                      >
                        Changes
                      </Link>
                    )}
                    {data.canBill && (
                      <Link
                        href={`/projects/${job.id}/financials/billing`}
                        className="hover:underline"
                      >
                        Billing →
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {data.jobsTotal > 12 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing {Math.min(12, data.jobs.length)} of {data.jobsTotal}{" "}
                jobs.{" "}
                <Link href="/projects" className="underline">
                  View all
                </Link>
                .
              </p>
            )}
          </section>
        )}
        <div className="grid gap-9 xl:grid-cols-2">
          {data.canSchedule && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">On the schedule</h2>
                <Link
                  href="/trade/crew"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Schedule & crew →
                </Link>
              </div>
              {data.work.length ? (
                <div className="divide-y border-y">
                  {data.work.slice(0, 8).map((item) => (
                    <Link
                      key={item.id}
                      href={`/projects/${item.project_id}/schedule?item=${item.id}`}
                      className="flex justify-between gap-4 py-3 hover:bg-muted/30"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {item.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {names.get(item.project_id)} ·{" "}
                          {item.assigned_to
                            ? (people.get(item.assigned_to) ?? "Assigned crew")
                            : "Unassigned"}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {item.start_date
                          ? formatLocalDate(item.start_date, "MMM d")
                          : "Unscheduled"}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="py-4 text-sm text-muted-foreground">
                  No work scheduled yet. Assign your first work block in
                  Schedule & crew.
                </p>
              )}
              {data.workTotal > 8 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing 8 of {data.workTotal} open work blocks
                  {data.jobsTotal > data.jobs.length
                    ? ` across the first ${data.jobs.length} jobs`
                    : ""}
                  .
                </p>
              )}
            </section>
          )}
          {data.canBill && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Waiting on payment</h2>
                <Link
                  href="/billing"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  All billing →
                </Link>
              </div>
              {data.invoices.length ? (
                <div className="divide-y border-y">
                  {data.invoices.slice(0, 8).map((invoice) => (
                    <Link
                      key={invoice.id}
                      href={
                        invoice.project_id
                          ? `/projects/${invoice.project_id}/financials/billing?invoice=${invoice.id}`
                          : `/billing?invoice=${invoice.id}`
                      }
                      className="flex justify-between gap-4 py-3 hover:bg-muted/30"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {invoice.invoice_number ?? "Invoice"}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {invoice.due_date
                            ? `Due ${formatLocalDate(invoice.due_date, "MMM d")}`
                            : "No due date"}
                        </span>
                      </span>
                      <span className="text-sm font-medium tabular-nums">
                        {new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: invoice.currency,
                        }).format(invoice.balance_due_cents / 100)}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="py-4 text-sm text-muted-foreground">
                  No issued invoices have an outstanding balance.
                </p>
              )}
              {data.invoicesTotal > 8 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing 8 of {data.invoicesTotal} open invoices.
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </PageLayout>
  );
}
