"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  clockInAction,
  clockOutAction,
  endBreakAction,
  getClockCostCodesAction,
  startBreakAction,
  switchClockAction,
} from "@/app/(app)/trade/crew/actions";
import type { ClockSession } from "@/lib/services/time-clock";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type Job = { id: string; name: string };
type CostCode = { id: string; label: string };

const selectClass = "h-9 w-full border border-input bg-background px-3 text-sm";

// Hours worked so far: elapsed less finished breaks and any break in progress.
function workedMinutes(session: ClockSession, now: number) {
  const started = Date.parse(session.startedAt);
  const onBreak = session.onBreakSince ? now - Date.parse(session.onBreakSince) : 0;
  const worked = now - started - session.breakMinutes * 60_000 - onBreak;
  return Math.max(0, Math.floor(worked / 60_000));
}

function formatElapsed(minutes: number) {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatStarted(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Job + cost code picker shared by clock in and switch job. Cost codes load when
// the job changes and are required when the org's policy says so.
function JobPicker({
  jobs,
  initialJobId,
  submitLabel,
  pendingLabel,
  onSubmit,
  onCancel,
  disabled,
}: {
  jobs: Job[];
  initialJobId: string;
  submitLabel: string;
  pendingLabel: string;
  onSubmit: (input: { projectId: string; costCodeId: string | null }) => void;
  onCancel?: () => void;
  disabled: boolean;
}) {
  const [projectId, setProjectId] = useState(initialJobId);
  const [costCodeId, setCostCodeId] = useState("");
  const [codes, setCodes] = useState<{ projectId: string; required: boolean; costCodes: CostCode[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void getClockCostCodesAction(projectId).then((result) => {
      if (cancelled) return;
      if (!result.success) {
        setError(result.error);
        return;
      }
      setError(null);
      setCodes({ projectId, ...result.data });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const ready = codes?.projectId === projectId;
  const required = ready && codes.required;
  const canSubmit = Boolean(projectId) && ready && (!required || Boolean(costCodeId)) && !disabled;

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit({ projectId, costCodeId: costCodeId || null });
      }}
    >
      <div className="w-full max-w-60 space-y-1.5">
        <Label htmlFor="clock-job">Job</Label>
        <select
          id="clock-job"
          className={selectClass}
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value);
            setCostCodeId("");
          }}
        >
          <option value="" disabled>
            Choose a job
          </option>
          {jobs.map((job) => (
            <option key={job.id} value={job.id}>
              {job.name}
            </option>
          ))}
        </select>
      </div>
      {ready && codes.costCodes.length > 0 && (
        <div className="w-full max-w-60 space-y-1.5">
          <Label htmlFor="clock-cost-code">Cost code{required ? "" : " (optional)"}</Label>
          <select
            id="clock-cost-code"
            className={selectClass}
            value={costCodeId}
            onChange={(event) => setCostCodeId(event.target.value)}
          >
            <option value="">{required ? "Choose a cost code" : "None"}</option>
            {codes.costCodes.map((code) => (
              <option key={code.id} value={code.id}>
                {code.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <Button type="submit" size="sm" disabled={!canSubmit}>
        {disabled ? pendingLabel : submitLabel}
      </Button>
      {onCancel && (
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      )}
      {error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

export function ClockCard({
  open,
  jobs,
  jobsTotal,
}: {
  open: ClockSession | null;
  jobs: Job[];
  jobsTotal: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [switching, setSwitching] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  function run(
    work: () => Promise<{ success: true } | { success: false; error: string }>,
    done?: string,
  ) {
    startTransition(async () => {
      const result = await work();
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setSwitching(false);
      if (done) toast.success(done);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <section className="space-y-3" aria-labelledby="clock-title">
        <div>
          <p className="microlabel" id="clock-title">
            Clock
          </p>
          <p className="mt-1 text-sm text-muted-foreground">You are not clocked in.</p>
        </div>
        {jobs.length ? (
          <JobPicker
            jobs={jobs}
            initialJobId={jobs.length === 1 ? jobs[0].id : ""}
            submitLabel="Clock in"
            pendingLabel="Clocking in…"
            disabled={pending}
            onSubmit={(input) => run(() => clockInAction(input), "Clocked in")}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No active jobs to clock in to.</p>
        )}
        {jobsTotal > jobs.length && (
          <p className="text-xs text-warning">
            Showing {jobs.length} of {jobsTotal} active jobs.
          </p>
        )}
      </section>
    );
  }

  const onBreak = Boolean(open.onBreakSince);
  return (
    <section className="space-y-3" aria-labelledby="clock-title">
      <p className="microlabel" id="clock-title">
        Clock
      </p>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{open.projectName}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {open.costCodeLabel ? `${open.costCodeLabel} · ` : ""}
            Started {formatStarted(open.startedAt)}
            {onBreak && open.onBreakSince ? (
              <span className="font-medium text-warning">
                {" "}
                · On break since {formatStarted(open.onBreakSince)}
              </span>
            ) : null}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold tabular-nums tracking-tight">
            {formatElapsed(workedMinutes(open, now))}
          </p>
          <p className="text-xs text-muted-foreground">worked today</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {onBreak ? (
          <Button size="sm" disabled={pending} onClick={() => run(() => endBreakAction())}>
            End break
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => run(() => startBreakAction())}
          >
            Start break
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={pending || onBreak || jobs.length < 2}
          onClick={() => setSwitching((value) => !value)}
        >
          Switch job
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run(() => clockOutAction(), "Clocked out")}
        >
          Clock out
        </Button>
      </div>
      {switching && (
        <JobPicker
          jobs={jobs.filter((job) => job.id !== open.projectId)}
          initialJobId=""
          submitLabel="Switch"
          pendingLabel="Switching…"
          disabled={pending}
          onCancel={() => setSwitching(false)}
          onSubmit={(input) => run(() => switchClockAction(input), "Switched job")}
        />
      )}
    </section>
  );
}
