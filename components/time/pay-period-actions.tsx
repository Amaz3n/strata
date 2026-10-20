"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  closePayPeriodAction,
  exportPayPeriodAction,
} from "@/app/(app)/trade/crew/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type Layout = "generic" | "gusto";

function download(csv: string, filename: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function PayPeriodActions({
  startsOn,
  closed,
  blocker,
}: {
  startsOn: string;
  closed: boolean;
  // Why the period cannot be closed yet, or null when it can.
  blocker: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function close() {
    startTransition(async () => {
      const result = await closePayPeriodAction({ startsOn });
      setConfirming(false);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(`Period closed, ${result.data.locked} entries locked`);
      router.refresh();
    });
  }

  function exportCsv(layout: Layout) {
    startTransition(async () => {
      const result = await exportPayPeriodAction({ startsOn, layout });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      download(result.data.csv, result.data.filename);
    });
  }

  if (closed) {
    return (
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => exportCsv("generic")}>
          Export CSV
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => exportCsv("gusto")}>
          Export for Gusto
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {blocker && <span className="text-xs text-muted-foreground">{blocker}</span>}
      <Button size="sm" disabled={Boolean(blocker) || pending} onClick={() => setConfirming(true)}>
        Close period
      </Button>
      <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close this pay period?</AlertDialogTitle>
            <AlertDialogDescription>
              Every approved entry in the period will lock. Changes after that go through a
              correction that keeps the original on record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                close();
              }}
            >
              {pending ? "Closing…" : "Close and lock"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
