"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  approveTimeEntriesAction,
  rejectTimeEntriesAction,
} from "@/app/(app)/trade/crew/actions";
import type { ActionResult } from "@/lib/action-result";
import type { TimesheetQueueItem } from "@/lib/services/timesheets";
import { formatLocalDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const BULK_LIMIT = 200;

type BulkData = { done: string[]; failed: Array<{ id: string; error: string }> };

const KIND_LABEL = { regular: "Regular", overtime: "OT", double_time: "Double time" } as const;
const KIND_TONE = {
  regular: "text-muted-foreground",
  overtime: "text-warning",
  double_time: "text-destructive",
} as const;

export function TimeApprovalQueue({ queue }: { queue: TimesheetQueueItem[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const ids = queue.map((item) => item.id);
  const chosen = ids.filter((id) => selected.has(id));
  const allChecked = ids.length > 0 && chosen.length === ids.length;

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // The service takes at most 200 ids per call, so a large selection goes in slices.
  async function decide(
    send: (slice: string[]) => Promise<ActionResult<BulkData>>,
  ): Promise<{ done: number; failed: Array<{ id: string; error: string }>; error: string | null }> {
    let done = 0;
    const failed: Array<{ id: string; error: string }> = [];
    for (let at = 0; at < chosen.length; at += BULK_LIMIT) {
      const result = await send(chosen.slice(at, at + BULK_LIMIT));
      if (!result.success) return { done, failed, error: result.error };
      done += result.data.done.length;
      failed.push(...result.data.failed);
    }
    return { done, failed, error: null };
  }

  function finish(outcome: Awaited<ReturnType<typeof decide>>, verb: string) {
    setFailures(Object.fromEntries(outcome.failed.map((item) => [item.id, item.error])));
    setSelected(new Set(outcome.failed.map((item) => item.id)));
    if (outcome.error) toast.error(outcome.error);
    else if (outcome.failed.length)
      toast.error(`${outcome.done} ${verb}, ${outcome.failed.length} could not be changed`);
    else toast.success(`${outcome.done} ${verb}`);
    router.refresh();
  }

  function approve() {
    startTransition(async () => {
      finish(await decide((slice) => approveTimeEntriesAction({ ids: slice })), "approved");
    });
  }

  function sendBack() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError("Say why the time is going back");
      return;
    }
    startTransition(async () => {
      const outcome = await decide((slice) =>
        rejectTimeEntriesAction({ ids: slice, reason: trimmed }),
      );
      setRejecting(false);
      setReason("");
      finish(outcome, "sent back");
    });
  }

  if (!queue.length) {
    return (
      <div className="py-6">
        <h3 className="text-sm font-semibold">Nothing waiting for approval</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Submitted time for this period shows up here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground tabular-nums">
          {chosen.length ? `${chosen.length} selected` : `${queue.length} waiting`}
        </p>
        <div className="flex gap-2">
          <Button size="sm" disabled={!chosen.length || pending} onClick={approve}>
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!chosen.length || pending}
            onClick={() => {
              setReasonError(null);
              setRejecting(true);
            }}
          >
            Send back
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-y text-left text-xs text-muted-foreground">
            <tr>
              <th className="w-8 py-2.5 pr-2">
                <Checkbox
                  aria-label="Select all"
                  checked={allChecked ? true : chosen.length ? "indeterminate" : false}
                  onCheckedChange={(on) => setSelected(on === true ? new Set(ids) : new Set())}
                />
              </th>
              <th className="px-3 font-medium">Worker</th>
              <th className="px-3 font-medium">Job</th>
              <th className="px-3 font-medium">Cost code</th>
              <th className="px-3 font-medium">Date</th>
              <th className="px-3 text-right font-medium">Hours</th>
              <th className="pl-3 font-medium">Pay type</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {queue.map((item) => (
              <tr
                key={item.id}
                className={selected.has(item.id) ? "bg-muted/40" : "hover:bg-muted/30"}
              >
                <td className="py-2.5 pr-2 align-top">
                  <Checkbox
                    aria-label={`Select ${item.workerName} ${item.workDate}`}
                    checked={selected.has(item.id)}
                    onCheckedChange={(on) => toggle(item.id, on === true)}
                  />
                </td>
                <td className="px-3 align-top font-medium">
                  {item.workerName}
                  {failures[item.id] && (
                    <span role="alert" className="mt-0.5 block text-xs font-normal text-destructive">
                      {failures[item.id]}
                    </span>
                  )}
                </td>
                <td className="px-3 align-top">{item.projectName}</td>
                <td className="px-3 align-top text-muted-foreground">{item.costCode ?? "—"}</td>
                <td className="px-3 align-top tabular-nums">
                  {formatLocalDate(item.workDate, "EEE MMM d")}
                </td>
                <td className="px-3 text-right align-top tabular-nums">{item.hours.toFixed(2)}</td>
                <td className="pl-3 align-top">
                  <span className={`text-xs ${KIND_TONE[item.kind]}`}>{KIND_LABEL[item.kind]}</span>
                  {item.overtimeSource === "manual" && (
                    <Badge variant="outline" className="ml-2">
                      Manual
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog open={rejecting} onOpenChange={(open) => !pending && setRejecting(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send back {chosen.length} {chosen.length === 1 ? "entry" : "entries"}</DialogTitle>
            <DialogDescription>
              The worker sees your reason and can correct and resubmit.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="send-back-reason">Reason</Label>
            <Textarea
              id="send-back-reason"
              value={reason}
              maxLength={500}
              rows={3}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonError(null);
              }}
            />
            {reasonError && (
              <p role="alert" className="text-sm text-destructive">
                {reasonError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={sendBack}>
              {pending ? "Sending back…" : "Send back"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
