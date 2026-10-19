"use client";

import { useMemo, useRef, useState, useTransition, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Files, Loader2, Upload } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DrawingPreviewImage } from "@/components/drawings/drawing-preview-image";
import { RevisionReviewDialog } from "@/components/drawings/revision-review-dialog";
import { createDrawingSetFromDocument } from "@/app/(app)/drawings/actions";
import type { DrawingSheet } from "@/app/(app)/drawings/types";
import { unwrapAction } from "@/lib/action-result";
import { useDrawingUploadOperation } from "@/lib/hooks/use-drawing-upload-operation";
import { OptimisticLink } from "@/lib/navigation/optimistic-pathname";
import type { DealPlansData } from "@/lib/services/precon-deals";
import { DISCIPLINE_LABELS, type DrawingDiscipline } from "@/lib/validation/drawings";
import { cn } from "@/lib/utils";
import { useDealRoom } from "./deal-room";

const DISCIPLINE_ORDER: DrawingDiscipline[] = ["G", "T", "A", "S", "M", "E", "P", "FP", "C", "L", "I", "SP", "D", "X"];

const day = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * The deal's plans: the set as it stands, what the latest issue changed, and
 * every sheet. A sheet opens full screen over the deal. Measuring starts from a
 * line on Pricing, so it always measures into that line.
 */
export function DealPlans({ data, projectId }: { data: DealPlansData; projectId: string }) {
  const room = useDealRoom();
  const router = useRouter();
  const upload = useDrawingUploadOperation(projectId);
  const input = useRef<HTMLInputElement>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [importing, startImport] = useTransition();
  const { sheets, latest } = data;
  const uploading = ["transferring", "reconciling", "completion-unknown"].includes(upload.state);
  const changed = useMemo(() => new Set(data.changedSheetIds), [data.changedSheetIds]);
  const changedMeasured = data.changedSheetIds.filter((id) => data.measuredLines[id]).length;
  const planWork = room.planChanges.review.length + room.planChanges.changed.length;

  const groups = useMemo(() => {
    const byDiscipline = new Map<DrawingDiscipline, DrawingSheet[]>();
    for (const sheet of sheets) {
      const discipline = sheet.discipline ?? "X";
      byDiscipline.set(discipline, [...(byDiscipline.get(discipline) ?? []), sheet]);
    }
    return DISCIPLINE_ORDER.flatMap((code) => {
      const list = byDiscipline.get(code);
      return list ? [{ code, sheets: list }] : [];
    });
  }, [sheets]);

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf") return void toast.error("Upload the plans as a PDF.");
    try {
      const { draftRevisionId } = await upload.run(file, {
        projectId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: "application/pdf",
        issuanceType: sheets.length ? "revision" : "bid_set",
      });
      setReviewId(draftRevisionId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to upload the plans");
    }
  };

  const importFile = (fileId: string) =>
    startImport(async () => {
      try {
        const { draftRevisionId } = unwrapAction(await createDrawingSetFromDocument(projectId, fileId));
        router.replace(room.href("plans"));
        setReviewId(draftRevisionId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to use that file");
      }
    });

  const uploadButton = data.canUpload && (
    <>
      <input ref={input} type="file" accept="application/pdf" className="sr-only" tabIndex={-1} onChange={(event) => void choose(event)} />
      <Button size="sm" variant={sheets.length ? "outline" : "default"} disabled={uploading} onClick={() => input.current?.click()}>
        {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
        {uploading ? upload.stage || "Uploading…" : sheets.length ? "Upload a revision" : "Upload plans"}
      </Button>
    </>
  );
  const filesLink = (
    <Button asChild size="sm" variant="ghost">
      <OptimisticLink href={room.href("files")}>
        <Files className="size-3.5" />
        Use a file from Files
      </OptimisticLink>
    </Button>
  );

  return (
    <div className="space-y-4">
      {data.sourceFile && (
        <section className="flex flex-wrap items-center gap-x-6 gap-y-3 border bg-card px-4 py-3 shadow-xs">
          <div className="min-w-0 flex-[1_1_18rem]">
            <p className="text-sm font-semibold">Use {data.sourceFile.name} as the plans</p>
            <p className="text-xs text-muted-foreground">Arc splits it into sheets. Review them before they publish.</p>
          </div>
          <Button size="sm" disabled={importing} onClick={() => data.sourceFile && importFile(data.sourceFile.id)}>
            {importing && <Loader2 className="size-3.5 animate-spin" />}
            Use this file
          </Button>
        </section>
      )}

      {data.draftRevisionId && !reviewId && (
        <section className="flex flex-wrap items-center gap-x-6 gap-y-3 border border-l-2 border-l-warning bg-card px-4 py-3 shadow-xs">
          <p className="min-w-0 flex-[1_1_18rem] text-sm">An upload is waiting for review. Its sheets publish once you check them.</p>
          <Button size="sm" variant="outline" onClick={() => setReviewId(data.draftRevisionId)}>
            Review the upload
          </Button>
        </section>
      )}

      {sheets.length === 0 ? (
        <section className="grid justify-items-center gap-2 border border-dashed bg-card px-6 py-14 text-center">
          <span className="grid size-10 place-items-center bg-primary/10 text-primary">
            <Upload className="size-5" />
          </span>
          <h2 className="text-base font-semibold">No plans yet</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Upload the plan set as a PDF. Every line you measure takes its quantity from these sheets, and a measured line counts as firm.
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {uploadButton}
            {filesLink}
          </div>
          {!data.canUpload && <p className="text-xs text-muted-foreground">Ask someone who can upload drawings to add them.</p>}
        </section>
      ) : (
        <>
          <section className="flex flex-wrap items-center gap-x-4 gap-y-2 border bg-card px-4 py-3 shadow-xs">
            <div className="min-w-0 flex-[1_1_18rem]">
              <p className="truncate text-sm font-semibold">
                {latest?.receivedFrom || "Plans"}
                {latest?.label ? ` · Rev ${latest.label}` : ""}
              </p>
              <p className="text-xs tabular-nums text-muted-foreground">
                {data.total} {data.total === 1 ? "sheet" : "sheets"}
                {latest ? ` · issued ${day(latest.issuedDate)}` : ""}
              </p>
            </div>
            {filesLink}
            {uploadButton}
          </section>

          {(planWork > 0 || changedMeasured > 0) && (
            <section className="flex flex-wrap items-center gap-x-6 gap-y-3 border border-l-2 border-l-warning bg-card px-4 py-3 shadow-xs">
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              <div className="min-w-0 flex-[1_1_18rem]">
                <p className="text-sm font-semibold">
                  {latest?.label ? `Rev ${latest.label}` : "The latest issue"} changed {changedMeasured || data.changedSheetIds.length}{" "}
                  {(changedMeasured || data.changedSheetIds.length) === 1 ? "sheet" : "sheets"} with measured lines.
                </p>
                <p className="text-xs text-muted-foreground">
                  {room.planChanges.review.length
                    ? "Confirm the carried measurements on the new sheets. Until then they don't count."
                    : room.planChanges.changed.length
                      ? "Some measured quantities moved. Nothing on the price changes until you choose."
                      : "Every measured line still matches."}
                </p>
              </div>
              {room.planChanges.review.length > 0 ? (
                <Button size="sm" onClick={() => room.act({ kind: "review_plan_measurements" })}>
                  Review measurements
                </Button>
              ) : room.planChanges.changed.length > 0 ? (
                <Button size="sm" onClick={() => room.act({ kind: "review_plan_quantities" })}>
                  Review quantities
                </Button>
              ) : null}
            </section>
          )}

          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.code} className="space-y-2">
                <h3 className="microlabel flex items-baseline gap-2 text-muted-foreground">
                  {DISCIPLINE_LABELS[group.code]}
                  <span className="tabular-nums">{group.sheets.length}</span>
                </h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {group.sheets.map((sheet) => (
                    <SheetCard
                      key={sheet.id}
                      sheet={sheet}
                      lines={data.measuredLines[sheet.id] ?? 0}
                      changedIn={changed.has(sheet.id) ? latest?.label ?? "" : null}
                      onOpen={() => room.plans.open(sheet, sheets)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
          {data.truncated && (
            <p className="text-xs text-muted-foreground">
              Showing the first {sheets.length} of {data.total} sheets. Open the rest from a sheet's navigator.
            </p>
          )}
        </>
      )}

      {reviewId && (
        <RevisionReviewDialog
          preconstruction
          open
          onOpenChange={(open) => !open && setReviewId(null)}
          revisionId={reviewId}
          onPublished={() => {
            setReviewId(null);
            router.refresh();
          }}
          onDiscarded={() => {
            setReviewId(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function SheetCard({ sheet, lines, changedIn, onOpen }: { sheet: DrawingSheet; lines: number; changedIn: string | null; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group grid min-w-0 grid-cols-[minmax(0,1fr)] content-start border bg-card text-left shadow-xs transition-colors duration-150 hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="relative block aspect-[4/3] overflow-hidden border-b bg-muted">
        <DrawingPreviewImage url={sheet.image_thumbnail_url} alt={`${sheet.sheet_number} preview`} className="size-full object-contain" />
        {changedIn !== null && (
          <span className="absolute left-2 top-2 bg-warning/15 px-1.5 py-0.5 text-[11px] font-semibold text-warning backdrop-blur-sm">
            {changedIn ? `Changed in Rev ${changedIn}` : "Changed"}
          </span>
        )}
      </span>
      <span className="grid gap-0.5 px-3 py-2">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-xs font-semibold">{sheet.sheet_number}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{sheet.sheet_title ?? ""}</span>
        </span>
        <span className={cn("text-[11px] tabular-nums", lines ? "text-success" : "text-muted-foreground")}>
          {lines ? `${lines} ${lines === 1 ? "line" : "lines"} measured` : "Nothing measured"}
          {(sheet.version_count ?? 1) > 1 ? ` · v${sheet.version_count}` : ""}
        </span>
      </span>
    </button>
  );
}
