"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { savePricingWorksheetAction, getLatestPricingWorksheetAction } from "@/app/(app)/pipeline/[dealId]/pricing-actions";
import { unwrapAction } from "@/lib/action-result";
import { mergePricingWorksheet, type PricingConflict } from "@/lib/precon/pricing-recovery";
import { EMPTY_PRICING_WORKSHEET, pricingWorksheetSchema } from "@/lib/precon/pricing-worksheet";
import type { PricingWorksheet } from "@/lib/precon/pricing-worksheet";

export function usePricingWorksheet(
  prospectId: string,
  initial: PricingWorksheet,
  initialVersion: number,
  editable: boolean,
  persisted: boolean,
  recoveryKey?: string,
) {
  const router = useRouter();
  const [worksheet, setWorksheet] = useState(initial);
  const current = useRef(worksheet);
  current.current = worksheet;
  const version = useRef(initialVersion);
  const saved = useRef(persisted ? JSON.stringify(initial) : "");
  const inFlight = useRef<Promise<number> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseline = useRef(initial);
  const [conflicts, setConflicts] = useState<PricingConflict[]>([]);
  const [recovery, setRecovery] = useState<{ worksheet: PricingWorksheet; base: PricingWorksheet } | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [savedKey, setSavedKey] = useState(saved.current);

  const accept = useCallback(
    (result: { worksheet: PricingWorksheet; version: number }) => {
      const merged = mergePricingWorksheet(baseline.current, current.current, result.worksheet);
      baseline.current = result.worksheet;
      setConflicts(merged.conflicts);
      version.current = result.version;
      saved.current = JSON.stringify(result.worksheet);
      setSavedKey(saved.current);
      current.current = merged.worksheet;
      setWorksheet(merged.worksheet);
      setError(merged.conflicts.length ? "Pricing changed in another session. Review the conflicting fields below before saving." : null);
    },
    [],
  );

  const save = useCallback(async (): Promise<number> => {
    while (inFlight.current) await inFlight.current;
    const snapshot = current.current;
    const key = JSON.stringify(snapshot);
    if (key === saved.current) return version.current;
    if (conflicts.length || recovery) throw new Error("Review recovered or conflicting pricing before saving.");
    if (!editable)
      throw new Error("You do not have permission to edit pricing.");
    setSaving(true);
    setError(null);
    const work = (async () => {
      try {
        const result = unwrapAction(
          await savePricingWorksheetAction(
            prospectId,
            snapshot,
            version.current,
          ),
        );
        baseline.current = result.worksheet;
        version.current = result.version;
        saved.current = JSON.stringify(result.worksheet);
        setSavedKey(saved.current);
        // Do not replace keystrokes entered while the save was in flight.
        if (JSON.stringify(current.current) === key) {
          current.current = result.worksheet;
          setWorksheet(result.worksheet);
        }
        return result.version;
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Unable to save pricing.";
        setError(message);
        throw cause;
      } finally {
        inFlight.current = null;
        setSaving(false);
      }
    })();
    inFlight.current = work;
    return work;
  }, [editable, prospectId, conflicts.length, recovery]);

  useEffect(() => {
    if (recoveryKey) {
      try {
        const stored = JSON.parse(sessionStorage.getItem(recoveryKey) ?? "null");
        if (stored) {
          const worksheet = pricingWorksheetSchema.parse(stored.worksheet);
          const base = pricingWorksheetSchema.parse(stored.base);
          if (JSON.stringify(worksheet) !== JSON.stringify(initial)) setRecovery({ worksheet, base });
        }
      } catch { /* An invalid browser copy never replaces server data. */ }
    }
    setRecoveryReady(true);
    // Read once per mounted, user-scoped workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryKey]);
  useEffect(() => {
    if (!recoveryReady || !recoveryKey || recovery) return;
    try {
      if (JSON.stringify(worksheet) === savedKey) sessionStorage.removeItem(recoveryKey);
      else sessionStorage.setItem(recoveryKey, JSON.stringify({ worksheet, base: baseline.current }));
    } catch { /* Storage can be disabled; existing unload protection still applies. */ }
  }, [worksheet, savedKey, recoveryKey, recoveryReady, recovery]);
  const reviewLatest = useCallback(async () => {
    const latest = unwrapAction(await getLatestPricingWorksheetAction(prospectId));
    accept({ worksheet: latest.worksheet ?? EMPTY_PRICING_WORKSHEET, version: latest.version });
  }, [prospectId, accept]);
  const restoreRecovery = () => {
    if (!recovery) return;
    const merged = mergePricingWorksheet(recovery.base, recovery.worksheet, baseline.current);
    current.current = merged.worksheet;
    setWorksheet(merged.worksheet);
    setConflicts(merged.conflicts);
    setError(merged.conflicts.length ? "Review recovered pricing conflicts before saving." : null);
    setRecovery(null);
  };
  const resolveConflicts = (keepLocal: boolean) => {
    if (!keepLocal) {
      current.current = baseline.current;
      setWorksheet(baseline.current);
    }
    setConflicts([]);
    setError(null);
  };
  const dirty = JSON.stringify(worksheet) !== savedKey;
  useEffect(() => {
    // Refreshes from takeoff or another saved form can update an idle worksheet;
    // they must never replace local edits which have not been saved yet.
    if (
      initialVersion > version.current &&
      !dirty &&
      !inFlight.current &&
      persisted
    ) {
      accept({ worksheet: initial, version: initialVersion });
    }
  }, [initialVersion, initial, dirty, persisted, accept]);
  useEffect(() => {
    if (
      !editable ||
      !recoveryReady ||
      recovery ||
      !dirty ||
      error ||
      (!worksheet.rows.length && !persisted && !savedKey)
    )
      return;
    const timer = setTimeout(() => {
      void save().catch(() => {});
    }, 900);
    return () => clearTimeout(timer);
  }, [worksheet, editable, dirty, error, save, persisted, savedKey, recoveryReady, recovery]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    const navigate = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      )
        return;
      const destination = new URL(anchor.href);
      if (
        destination.origin !== location.origin ||
        destination.pathname === location.pathname
      )
        return;
      if (
        JSON.stringify(current.current) === saved.current ||
        (!persisted && !current.current.rows.length)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void save()
        .then(() =>
          router.push(
            destination.pathname + destination.search + destination.hash,
          ),
        )
        .catch(() => {});
    };
    document.addEventListener("click", navigate, true);
    return () => document.removeEventListener("click", navigate, true);
  }, [save, router, persisted]);
  return {
    worksheet,
    setWorksheet,
    conflicts,
    recovery,
    restoreRecovery,
    discardRecovery: () => setRecovery(null),
    reviewLatest,
    resolveConflicts,
    save,
    accept,
    saving,
    error,
    dirty,
    version,
  };
}
