"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { markDealLostAction } from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction } from "@/lib/action-result";
import { DEAL_LOST_REASONS } from "@/lib/validation/deals";

export function MarkDealLostDialog({
  open,
  onOpenChange,
  dealId,
  dealName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  dealName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open={open} onOpenChange={(value) => !pending && onOpenChange(value)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Why didn&apos;t {dealName} go ahead?</DialogTitle>
          <DialogDescription>One choice. It shows where deals slip.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          {DEAL_LOST_REASONS.map((reason) => (
            <Button
              key={reason}
              variant="outline"
              className="h-10 justify-start"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    unwrapAction(await markDealLostAction(dealId, reason));
                    toast.success(`${dealName} moved to Lost`);
                    onOpenChange(false);
                    router.push("/pipeline");
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : "Unable to mark the deal lost");
                  }
                })
              }
            >
              {reason}
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
