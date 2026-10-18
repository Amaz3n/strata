"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { scheduleTradeWorkAction } from "@/app/(app)/trade/actions";
import type { TradeWorkspace } from "@/lib/services/trade-workspace";
import { crewConflicts, ELECTRICAL_WORK } from "@/lib/trade/workspace";
import { formatLocalDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export function CrewWorkspace({
  data,
}: {
  data: Pick<
    TradeWorkspace,
    | "jobs"
    | "jobsTotal"
    | "work"
    | "workTotal"
    | "members"
    | "membersTotal"
    | "profile"
    | "canEditSchedule"
    | "canTime"
  >;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [crew, setCrew] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const conflicts = useMemo(() => crewConflicts(data.work), [data.work]);
  const visible = data.work.filter(
    (work) =>
      crew === "all" ||
      (crew === "unassigned" ? !work.assigned_to : work.assigned_to === crew),
  );
  const jobs = new Map(data.jobs.map((job) => [job.id, job.name]));
  const members = new Map(
    data.members.map((member) => [
      member.user_id,
      member.user?.full_name ?? member.user?.email ?? "Crew member",
    ]),
  );
  const selectClass =
    "h-9 w-full border border-input bg-background px-3 text-sm";
  return (
    <div className="space-y-5 desk-rise">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Schedule & crew
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Assign a crew lead, plan hours, and spot overlaps across jobs.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/schedule">Timeline</Link>
          </Button>
          {data.canEditSchedule && (
            <Button
              size="sm"
              disabled={!data.jobs.length}
              onClick={() => setOpen(true)}
            >
              Schedule work
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor="crew-filter">Crew lead</Label>
        <select
          id="crew-filter"
          className={`${selectClass} max-w-xs`}
          value={crew}
          onChange={(e) => setCrew(e.target.value)}
        >
          <option value="all">Everyone</option>
          <option value="unassigned">Unassigned</option>
          {data.members.map((member) => (
            <option key={member.user_id} value={member.user_id}>
              {members.get(member.user_id)}
            </option>
          ))}
        </select>
        {conflicts.size > 0 && (
          <span className="text-xs font-medium text-warning">
            {conflicts.size} work blocks overlap across jobs
          </span>
        )}
      </div>
      {visible.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="border-y text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-3 pr-4 font-medium">Work / job</th>
                <th className="px-3 font-medium">Dates</th>
                <th className="px-3 font-medium">Crew lead</th>
                <th className="px-3 text-right font-medium">Planned hours</th>
                <th className="pl-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((work) => (
                <tr key={work.id} className="hover:bg-muted/30">
                  <td className="py-3 pr-4">
                    <Link
                      href={`/projects/${work.project_id}/schedule?item=${work.id}`}
                      className="font-medium hover:underline"
                    >
                      {work.name}
                    </Link>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {jobs.get(work.project_id)}
                    </p>
                  </td>
                  <td className="px-3 text-xs tabular-nums">
                    {work.start_date
                      ? formatLocalDate(work.start_date, "MMM d")
                      : "Unscheduled"}
                    {work.end_date && work.end_date !== work.start_date
                      ? ` – ${formatLocalDate(work.end_date, "MMM d")}`
                      : ""}
                  </td>
                  <td className="px-3">
                    <span>
                      {work.assigned_to
                        ? (members.get(work.assigned_to) ?? "Assigned member")
                        : "Unassigned"}
                    </span>
                    {conflicts.has(work.id) && (
                      <span className="mt-1 block text-xs text-warning">
                        Overlapping assignment
                      </span>
                    )}
                  </td>
                  <td className="px-3 text-right tabular-nums">
                    {work.planned_hours ?? "—"}
                  </td>
                  <td className="pl-3 text-xs capitalize">
                    {work.status.replaceAll("_", " ")}
                    {data.canTime && (
                      <Link
                        href={`/projects/${work.project_id}/time`}
                        className="mt-1 block text-muted-foreground hover:underline"
                      >
                        Log time →
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="py-12">
          <h2 className="text-sm font-semibold">
            {data.jobs.length
              ? "No work in this view"
              : "Add a job to start scheduling"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {data.jobs.length
              ? "Schedule a work block, or choose a different crew lead."
              : "Create your first job from Today. Then plan rough-in, inspections, and trim-out here."}
          </p>
          <Link href="/" className="mt-3 inline-block text-sm underline">
            Go to Today
          </Link>
        </div>
      )}
      {(data.workTotal > data.work.length ||
        data.jobsTotal > data.jobs.length) && (
        <p className="text-xs text-warning">
          Showing up to {data.work.length} of {data.workTotal} open work blocks
          across {data.jobs.length} of {data.jobsTotal} active jobs. Conflict
          checks cover this loaded set. Use a job’s schedule for its complete
          plan.
        </p>
      )}
      {data.membersTotal > data.members.length && (
        <p className="text-xs text-muted-foreground">
          Showing the first {data.members.length} crew members. Manage the full
          team in Settings.
        </p>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          aria-labelledby="trade-schedule-title"
          className="overflow-y-auto p-6 sm:max-w-lg"
          mobileFullscreen
        >
          <SheetHeader>
            <SheetTitle id="trade-schedule-title">Schedule work</SheetTitle>
            <SheetDescription>
              Dates are inclusive. A crew lead assigned to two jobs on the same
              day will be flagged.
            </SheetDescription>
          </SheetHeader>
          <form
            className="mt-6 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              setError(null);
              startTransition(async () => {
                const result = await scheduleTradeWorkAction({
                  project_id: form.get("project_id"),
                  name: form.get("name"),
                  assigned_to: form.get("assigned_to") || undefined,
                  start_date: form.get("start_date"),
                  end_date: form.get("end_date"),
                  planned_hours: form.get("hours")
                    ? Number(form.get("hours"))
                    : undefined,
                });
                if (!result.success) {
                  setError(result.error);
                  return;
                }
                setOpen(false);
                router.refresh();
              });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="crew-job">Job</Label>
              <select
                id="crew-job"
                name="project_id"
                required
                className={selectClass}
              >
                {data.jobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="crew-work">Work</Label>
              <Input
                id="crew-work"
                name="name"
                required
                maxLength={200}
                list="electrical-work"
                placeholder="Rough-in"
              />
              {data.profile.specialty.toLowerCase() === "electrical" && (
                <datalist id="electrical-work">
                  {ELECTRICAL_WORK.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="crew-start">Start</Label>
                <Input id="crew-start" name="start_date" type="date" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="crew-end">Finish</Label>
                <Input id="crew-end" name="end_date" type="date" required />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="crew-lead">Crew lead</Label>
              <select id="crew-lead" name="assigned_to" className={selectClass}>
                <option value="">Unassigned</option>
                {data.members.map((member) => (
                  <option key={member.user_id} value={member.user_id}>
                    {members.get(member.user_id)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="crew-hours">Planned labor hours</Label>
              <Input
                id="crew-hours"
                name="hours"
                type="number"
                min="0.25"
                step="0.25"
                max="10000"
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={pending}>
              {pending ? "Scheduling…" : "Schedule work"}
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
