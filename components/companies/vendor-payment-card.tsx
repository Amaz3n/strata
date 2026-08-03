"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { inviteCompanyToPaymentSetupAction } from "@/app/(app)/companies/actions";
import { unwrapAction } from "@/lib/action-result";
import type { CompanyPaymentReadiness } from "@/lib/services/vendor-payment-invitations";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

const COPY: Record<
  CompanyPaymentReadiness["status"],
  { label: string; detail: string; action: string | null }
> = {
  ready: {
    label: "Set up for direct deposit",
    detail: "You can pay this vendor electronically from a payment run.",
    action: null,
  },
  verifying: {
    label: "Verifying with Stripe",
    detail: "They started setup. Stripe still needs something from them before you can pay them.",
    action: "Send a reminder",
  },
  invited: {
    label: "Invited",
    detail: "They have been asked to set up direct deposit and have not finished yet.",
    action: "Send it again",
  },
  not_started: {
    label: "Paid by check",
    detail:
      "Invite them to set up direct deposit. If they already did this for another Arc builder, it takes them one click.",
    action: "Invite to direct deposit",
  },
};

export function VendorPaymentCard({
  companyId,
  readiness,
  canEdit,
}: {
  companyId: string;
  readiness: CompanyPaymentReadiness | null;
  canEdit: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const status = readiness?.status ?? "not_started";
  const copy = COPY[status];

  const invite = () =>
    startTransition(async () => {
      try {
        const result = unwrapAction(await inviteCompanyToPaymentSetupAction(companyId));
        toast({
          title: result.delivered ? "Invitation sent" : "Invitation recorded",
          description: result.delivered
            ? `Sent to ${result.recipients} ${result.recipients === 1 ? "contact" : "contacts"} at ${result.companyName}.`
            : "The invitation was recorded but the email could not be delivered.",
        });
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to send the invitation",
          description: (error as Error).message,
        });
      }
    });

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="microlabel">Electronic payment</div>
        <p className="mt-2 text-sm font-medium">{copy.label}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.detail}</p>
        {readiness?.invitedAt && status !== "ready" ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Last invited {readiness.invitedAt.slice(0, 10)}.
          </p>
        ) : null}
      </div>
      {copy.action && canEdit ? (
        <Button variant="outline" size="sm" className="shrink-0" onClick={invite} disabled={pending}>
          {pending ? "Sending…" : copy.action}
        </Button>
      ) : null}
    </div>
  );
}
