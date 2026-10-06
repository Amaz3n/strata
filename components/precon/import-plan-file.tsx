"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createDrawingSetFromDocument } from "@/app/(app)/drawings/actions";
import { unwrapAction } from "@/lib/action-result";

export function ImportPlanFile({
  prospectId,
  projectId,
  fileId,
  fileName,
}: {
  prospectId?: string;
  projectId: string;
  fileId: string;
  fileName: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const base = prospectId ? `/pipeline/prospects/${prospectId}` : `/projects/${projectId}`;
  return (
    <section className="flex flex-wrap items-center justify-between gap-4 border border-border/60 bg-card p-5">
      <div>
        <h2 className="text-sm font-semibold">Use {fileName} for takeoff</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Prepare drawing sheets from the file already in Documents. Review and
          publish the sheets before measuring.
        </p>
      </div>
      <div className="flex gap-2">
        <Button asChild variant="ghost">
          <Link href={`${base}/documents?fileId=${fileId}`}>
            Back to file
          </Link>
        </Button>
        <Button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              try {
                const result = unwrapAction(
                  await createDrawingSetFromDocument(projectId, fileId),
                );
                router.replace(
                  `${base}/drawings?set=${result.set.id}`,
                );
                router.refresh();
                toast.success(
                  "Drawing file opened. Review processing status in the register.",
                );
              } catch (cause) {
                toast.error(
                  cause instanceof Error
                    ? cause.message
                    : "Unable to prepare drawing sheets",
                );
              }
            })
          }
        >
          {pending ? "Preparing sheets…" : "Use this file"}
        </Button>
      </div>
    </section>
  );
}
