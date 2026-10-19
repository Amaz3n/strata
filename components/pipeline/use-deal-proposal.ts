"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { saveDealProposalAction } from "@/app/(app)/pipeline/[dealId]/proposal-actions";
import { unwrapAction } from "@/lib/action-result";
import type { DealProposal } from "@/lib/precon/proposal-documents";

/**
 * What the builder writes around the price, saved as they type. It has its own
 * version, so it never races the worksheet's autosave.
 */
export function useDealProposal(prospectId: string, initial: DealProposal, initialVersion: number, editable: boolean) {
  const [proposal, setProposal] = useState(initial);
  const current = useRef(proposal);
  current.current = proposal;
  const version = useRef(initialVersion);
  const saved = useRef(JSON.stringify(initial));
  const [savedKey, setSavedKey] = useState(saved.current);
  const inFlight = useRef<Promise<number> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async (): Promise<number> => {
    while (inFlight.current) await inFlight.current;
    const snapshot = current.current;
    const key = JSON.stringify(snapshot);
    if (key === saved.current) return version.current;
    if (!editable) throw new Error("You do not have permission to edit this proposal.");
    setSaving(true);
    setError(null);
    const work = (async () => {
      try {
        const result = unwrapAction(await saveDealProposalAction(prospectId, snapshot, version.current));
        version.current = result.version;
        saved.current = key;
        setSavedKey(key);
        return result.version;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to save the proposal.");
        throw cause;
      } finally {
        inFlight.current = null;
        setSaving(false);
      }
    })();
    inFlight.current = work;
    return work;
  }, [editable, prospectId]);

  const dirty = JSON.stringify(proposal) !== savedKey;
  useEffect(() => {
    // A server refresh after another session's save replaces an idle proposal, never local edits.
    if (initialVersion > version.current && !dirty && !inFlight.current) {
      version.current = initialVersion;
      saved.current = JSON.stringify(initial);
      setSavedKey(saved.current);
      setProposal(initial);
    }
  }, [initial, initialVersion, dirty]);
  useEffect(() => {
    if (!editable || !dirty || error) return;
    const timer = setTimeout(() => void save().catch(() => {}), 800);
    return () => clearTimeout(timer);
  }, [proposal, editable, dirty, error, save]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // The ref moves with the edit, so a save called right after an update sends it.
  const update = useCallback((patch: Partial<DealProposal>) => {
    setError(null);
    const next = { ...current.current, ...patch };
    current.current = next;
    setProposal(next);
  }, []);

  return { proposal, update, save, saving, dirty, error, version };
}
