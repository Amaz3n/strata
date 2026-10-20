"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  openProjectConnectionPortalAction,
  unlinkProjectConnectionAction,
} from "@/app/(app)/trade/connections/actions";
import type { ProjectConnection } from "@/lib/services/project-connections";
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
import { formatLocalDate } from "@/lib/utils";

const STATUS: Record<
  ProjectConnection["status"],
  { label: string; dot: string; text: string }
> = {
  active: { label: "Active", dot: "bg-success", text: "text-success" },
  paused: { label: "Paused", dot: "bg-warning", text: "text-warning" },
  ended: { label: "Ended", dot: "bg-muted-foreground", text: "text-muted-foreground" },
};

export function BuilderProjectPanel({
  connection,
}: {
  connection: ProjectConnection;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = STATUS[connection.status];
  return (
    <section
      aria-label="Builder project"
      className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4 sm:px-8 lg:px-12"
    >
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Builder project
        </p>
        <p className="mt-1 truncate text-sm font-medium">
          {connection.builderProjectName}
        </p>
        <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{connection.builderName}</span>
          <span className={`inline-flex items-center gap-1.5 ${status.text}`}>
            <span className={`size-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </span>
          {connection.endedAt && (
            <span>since {formatLocalDate(connection.endedAt, "MMM d")}</span>
          )}
        </p>
        {error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      {connection.canManage && connection.status !== "ended" && (
        <div className="flex items-center gap-2">
          {connection.status === "active" && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await openProjectConnectionPortalAction(
                    connection.id,
                  );
                  if (!result.success) {
                    setError(result.error);
                    return;
                  }
                  window.location.assign(result.data.href);
                });
              }}
            >
              Open builder portal
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            Unlink
          </Button>
        </div>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink this builder project?</AlertDialogTitle>
            <AlertDialogDescription>
              New invoices from {connection.builderName} stop appearing on this
              job. The job, its customer and receivables already created stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await unlinkProjectConnectionAction(
                    connection.id,
                  );
                  if (!result.success) {
                    setError(result.error);
                    return;
                  }
                  router.refresh();
                });
              }}
            >
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
