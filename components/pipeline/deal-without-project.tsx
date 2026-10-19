"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Files, Upload } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { startDealPriceAction } from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction } from "@/lib/action-result";
import { useDealRoom } from "./deal-room";

const COPY = {
  plans: {
    icon: Upload,
    title: "Upload the drawings",
    body: "Plan sets stack into one set per deal. Measure areas, lengths and counts straight into pricing lines; a measured line counts as firm.",
    button: "Start the price from the plans",
  },
  files: {
    icon: Files,
    title: "Files come with the price",
    body: "Surveys, photos and drawings are kept with the pricing workspace, and follow the deal into the job when it starts.",
    button: "Start the price",
  },
} as const;

/** Plans and files live in the pricing workspace, which the deal gets when its price starts. */
export function DealWithoutProject({ tab }: { tab: keyof typeof COPY }) {
  const room = useDealRoom();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const copy = COPY[tab];
  const Icon = copy.icon;
  return (
    <div className="grid justify-items-center gap-2 border bg-card px-6 py-12 text-center shadow-xs">
      <span className="grid size-10 place-items-center bg-primary/10 text-primary">
        <Icon className="size-5" />
      </span>
      <h2 className="text-base font-semibold">{copy.title}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{copy.body}</p>
      <Button
        size="sm"
        className="mt-2"
        disabled={!room.editable || pending}
        onClick={() =>
          startTransition(async () => {
            try {
              unwrapAction(await startDealPriceAction(room.deal.id, { kind: tab === "plans" ? "plans" : "blank" }));
              router.refresh();
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "Unable to start the price");
            }
          })
        }
      >
        {pending ? "Starting…" : copy.button}
      </Button>
    </div>
  );
}
