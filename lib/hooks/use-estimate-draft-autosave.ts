"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EstimateInput } from "@/lib/validation/estimates";
import { createDraftSaveQueue } from "@/lib/financials/draft-save-queue";
import { useDraftSaveScheduler } from "./use-draft-save-scheduler";

export type SavedEstimateDraft = { id: string; updated_at: string };

export function useEstimateDraftAutosave({
  input,
  snapshot,
  recoveryKey,
  initial,
  save,
  restore,
}: {
  input: EstimateInput | null;
  snapshot: string;
  recoveryKey?: string;
  initial?: SavedEstimateDraft;
  save?: (
    input: EstimateInput,
    previous?: SavedEstimateDraft,
  ) => Promise<SavedEstimateDraft>;
  restore: (snapshot: string) => boolean;
}) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    initial ? "saved" : "idle",
  );
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [error, setError] = useState<string>();
  const { schedule, cancel } = useDraftSaveScheduler();
  const latest = useRef({ save, snapshot });
  const completed = useRef(false);
  const originKey = useRef(recoveryKey);
  const skipRestoreWrite = useRef(false);
  const initialSnapshot = useRef(snapshot);
  useLayoutEffect(() => {
    latest.current = { save, snapshot };
  }, [save, snapshot]);
  const writeRecovery = () => {
    if (!recoveryKey || completed.current) return;
    try {
      const saved = queue.getSaved();
      const recovery = JSON.stringify({
        version: 1,
        originKey: originKey.current,
        snapshot: latest.current.snapshot,
        saved,
      });
      sessionStorage.setItem(recoveryKey, recovery);
      if (originKey.current)
        sessionStorage.setItem(originKey.current, recovery);
      if (saved)
        sessionStorage.setItem(
          `${recoveryKey.slice(0, recoveryKey.lastIndexOf(":"))}:${saved.id}`,
          recovery,
        );
      setRecoverySaved(true);
    } catch {
      setRecoverySaved(false);
    }
  };
  const [queue] = useState(() =>
    createDraftSaveQueue<EstimateInput, SavedEstimateDraft>({
      initial,
      save: (value, saved) => latest.current.save!(value, saved),
      onState: setState,
      onSaved: () => writeRecovery(),
    }),
  );
  useLayoutEffect(() => {
    if (!save || !recoveryKey) return;
    try {
      const stored = JSON.parse(sessionStorage.getItem(recoveryKey) ?? "null");
      if (stored?.version !== 1 || typeof stored.snapshot !== "string") return;
      if (
        initial &&
        (stored.saved?.id !== initial.id ||
          stored.saved?.updated_at !== initial.updated_at)
      )
        return;
      if (
        stored.saved &&
        (typeof stored.saved.id !== "string" ||
          typeof stored.saved.updated_at !== "string")
      )
        return;
      if (!restore(stored.snapshot)) return;
      const prefix = recoveryKey.slice(0, recoveryKey.lastIndexOf(":") + 1);
      if (
        typeof stored.originKey === "string" &&
        stored.originKey.startsWith(prefix)
      )
        originKey.current = stored.originKey;
      if (stored.saved) queue.restore(stored.saved);
      skipRestoreWrite.current = true;
      setRecoverySaved(true);
    } catch {
      /* Invalid or unavailable recovery never blocks editing. */
    }
    // Restore once for this document, before writing any browser recovery copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const flush = async (explicitInput?: EstimateInput) => {
    cancel();
    if (!save || completed.current) return;
    if (explicitInput) queue.update(explicitInput);
    try {
      const saved = await queue.flush();
      setError(undefined);
      return saved;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save draft");
      throw cause;
    }
  };
  const flushRef = useRef(flush);
  useLayoutEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => {
    if (!save || completed.current) return;
    if (skipRestoreWrite.current) {
      skipRestoreWrite.current = false;
      return;
    }
    if (snapshot === initialSnapshot.current && !recoverySaved) return;
    queue.update(input);
    writeRecovery();
    cancel();
    if (input)
      schedule(() => {
        void flushRef.current().catch(() => {});
      });
    // JSON snapshot represents all editable fields; status changes must not restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);
  useEffect(
    () => () => {
      cancel();
      if (!completed.current) void flushRef.current().catch(() => {});
    },
    [cancel],
  );
  return {
    state,
    error,
    recoverySaved,
    flush,
    complete() {
      completed.current = true;
      cancel();
      if (recoveryKey) {
        try {
          sessionStorage.removeItem(recoveryKey);
          if (originKey.current) sessionStorage.removeItem(originKey.current);
          const saved = queue.getSaved();
          if (saved)
            sessionStorage.removeItem(
              `${recoveryKey.slice(0, recoveryKey.lastIndexOf(":"))}:${saved.id}`,
            );
        } catch {}
      }
    },
  };
}
