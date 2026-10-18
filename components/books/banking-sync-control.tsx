"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { refreshBankingFeedsAction } from "@/app/(app)/books/banking-actions";
import { cn } from "@/lib/utils";

type SyncState = "idle" | "running" | "success" | "partial" | "error";

export function latestBankSync(current: string | null, incoming: string | null) {
  if (!incoming || !Number.isFinite(Date.parse(incoming))) return current;
  return !current || !Number.isFinite(Date.parse(current)) || Date.parse(incoming) > Date.parse(current)
    ? incoming
    : current;
}

export function formatLastBankSync(value: string | null, now = Date.now()) {
  if (!value) return "Never synced";
  const syncedAt = new Date(value).getTime();
  if (!Number.isFinite(syncedAt)) return "Never synced";
  const seconds = Math.max(0, Math.floor((now - syncedAt) / 1000));
  if (seconds < 60) return "Synced just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Synced ${days}d ago`;
}

export function BankingSyncControl({
  initialLastSyncedAt,
  canEdit,
  onRefresh,
}: {
  initialLastSyncedAt: string | null;
  canEdit: boolean;
  onRefresh: () => void;
}) {
  const [state, setState] = useState<SyncState>("idle");
  const [lastSyncedAt, setLastSyncedAt] = useState(initialLastSyncedAt);
  const [elapsed, setElapsed] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (state !== "running") return;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!initialLastSyncedAt) return;
    setLastSyncedAt((current) =>
      latestBankSync(current, initialLastSyncedAt),
    );
  }, [initialLastSyncedAt]);

  const settle = (next: Exclude<SyncState, "idle" | "running">) => {
    setState(next);
    resetTimer.current = setTimeout(() => setState("idle"), 1800);
  };

  const sync = async () => {
    if (!canEdit || inFlight.current || !mounted.current) return;
    inFlight.current = true;
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setState("running");
    try {
      const result = await refreshBankingFeedsAction();
      if (!mounted.current) return;
      if (!result.success) {
        toast.error(result.error);
        settle("error");
        return;
      }
      const { connectionCount, refreshed, errors, lastSyncedAt: completedAt } = result.data;
      setLastSyncedAt(current => latestBankSync(current, completedAt));
      onRefresh();
      if (connectionCount === 0) {
        toast.error("No connected bank feeds to sync");
        settle("error");
      } else if (errors.length > 0 && refreshed > 0) {
        toast.error(`${refreshed} of ${connectionCount} feeds synced. ${errors.join("; ")}`);
        settle("partial");
      } else if (errors.length > 0 || refreshed === 0) {
        toast.error(errors.join("; ") || "Bank feeds could not be synced");
        settle("error");
      } else {
        toast.success(`${refreshed} ${refreshed === 1 ? "connection" : "connections"} refreshed`);
        settle("success");
      }
    } catch (error) {
      if (!mounted.current) return;
      toast.error(error instanceof Error ? error.message : "Bank feeds could not be synced");
      settle("error");
    } finally {
      inFlight.current = false;
    }
  };

  const running = state === "running";
  const validLastSyncedAt = lastSyncedAt && Number.isFinite(new Date(lastSyncedAt).getTime());
  const exactTime = validLastSyncedAt
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }).format(
        new Date(lastSyncedAt),
      )
    : null;
  const statusLabel =
    state === "success"
      ? "Sync complete"
      : state === "partial"
        ? "Partially synced"
        : state === "error"
          ? "Sync failed"
          : null;

  return (
    <motion.button
      type="button"
      layout={!reducedMotion}
      transition={{ type: "spring", bounce: 0, duration: 0.32 }}
      disabled={!canEdit || running}
      onClick={() => void sync()}
      title={
        exactTime
          ? `Last successful feed refresh across all connected accounts: ${exactTime}`
          : "No connected bank feed has completed a successful refresh yet"
      }
      aria-label={running ? "Syncing banking" : `Sync all bank feeds. ${formatLastBankSync(lastSyncedAt, now)}`}
      className={cn(
        "relative flex h-10 min-w-[132px] items-center gap-2 overflow-hidden border bg-background px-3 text-left shadow-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !canEdit && "cursor-not-allowed opacity-60",
        running && "min-w-[190px] cursor-wait opacity-100",
        state === "success" && "border-success/40 bg-success/5",
        (state === "partial" || state === "error") && "border-destructive/40 bg-destructive/5",
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
        {running ? (
          <Loader2 className={cn("size-4", !reducedMotion && "animate-spin")} />
        ) : state === "success" ? (
          <Check className="size-4 text-success" />
        ) : state === "partial" || state === "error" ? (
          <AlertTriangle className="size-4 text-destructive" />
        ) : (
          <RefreshCw className="size-4" />
        )}
      </span>
      <span className="min-w-0 leading-none">
        <span className="block whitespace-nowrap text-xs font-semibold">
          {running
            ? "Syncing banking"
            : statusLabel ?? formatLastBankSync(lastSyncedAt, now)}
        </span>
        {running ? (
          <span className="mt-1 block whitespace-nowrap text-[10px] tabular-nums text-muted-foreground" aria-hidden="true">
            {elapsed}s elapsed
          </span>
        ) : null}
      </span>
      <AnimatePresence>
        {running ? (
          <motion.span
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-x-0 bottom-0 h-px overflow-hidden bg-muted"
          >
            <motion.span
              className="block h-full w-2/5 bg-foreground"
              animate={reducedMotion ? { opacity: 0.7 } : { x: ["-100%", "250%"] }}
              transition={reducedMotion ? undefined : { duration: 1.25, ease: "easeInOut", repeat: Infinity }}
            />
          </motion.span>
        ) : null}
      </AnimatePresence>
      <span className="sr-only" aria-live="polite">
        {running ? "Syncing banking" : statusLabel ?? ""}
      </span>
    </motion.button>
  );
}
