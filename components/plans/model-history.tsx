"use client";
import { useState } from "react";
import {
  loadFloorplanRevisionsAction,
  restoreFloorplanRevisionAction,
} from "@/app/(app)/floorplan/actions";
import { unwrapAction } from "@/lib/action-result";
import type {
  FloorplanModelDto,
  FloorplanTarget,
} from "@/lib/services/floorplan-models";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function ModelHistory({
  target,
  expectedUpdatedAt,
  planId,
  disabled,
  onRestore,
}: {
  target: FloorplanTarget;
  expectedUpdatedAt: string;
  planId?: string;
  disabled: boolean;
  onRestore: (record: FloorplanModelDto) => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [rows, setRows] = useState<Array<{ id: string; saved_at: string }>>([]),
    [selected, setSelected] = useState("");
  const load = async () => {
    setOpen(true);
    setBusy(true);
    setError(null);
    setRows([]);
    setSelected("");
    try {
      setRows(unwrapAction(await loadFloorplanRevisionsAction(target)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load history");
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      onRestore(
        unwrapAction(
          await restoreFloorplanRevisionAction(
            target,
            selected,
            expectedUpdatedAt,
            planId,
          ),
        ),
      );
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not restore revision");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => void load()}
      >
        History
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Model history</DialogTitle>
            <DialogDescription>
              Restore a previous saved draft. Your current draft is archived
              automatically, and the published model stays available to clients.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {busy && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!busy && !error && !rows.length && (
            <p className="text-sm text-muted-foreground">
              Previous drafts will appear after your first saved correction.
            </p>
          )}
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {rows.map((row) => (
              <label
                key={row.id}
                className="flex items-center gap-3 rounded-md border p-3 text-sm"
              >
                <input
                  type="radio"
                  name="revision"
                  checked={selected === row.id}
                  disabled={busy}
                  onChange={() => setSelected(row.id)}
                />
                <span>
                  {new Date(row.saved_at).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "medium",
                  })}
                </span>
              </label>
            ))}
          </div>
          <Button
            disabled={!selected || busy || disabled}
            onClick={() => void restore()}
          >
            Restore selected draft
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
