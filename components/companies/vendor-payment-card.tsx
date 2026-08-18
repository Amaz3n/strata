"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { inviteCompanyToPaymentSetupAction, setCompanyPaymentAccessStatusAction } from "@/app/(app)/companies/actions";
import { unwrapAction } from "@/lib/action-result";
import type { CompanyPaymentReadiness } from "@/lib/services/vendor-payment-invitations";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

const COPY: Record<
  CompanyPaymentReadiness["status"],
  { label: string; detail: string; action: string | null }
> = {
  ready: {
    label: "Set up for Arc Pay",
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
    detail: "They have been asked to set up Arc Pay and have not finished yet.",
    action: "Send it again",
  },
  not_started: {
    label: "Paid by check",
    detail:
      "Invite them to set up Arc Pay. If they already did this for another Arc builder, it takes them one click.",
    action: "Invite to Arc Pay",
  },
  suspended: {
    label: "Direct deposit suspended",
    detail:
      "Electronic payment to this vendor is paused and their payment page is closed. Restoring re-opens it and needs two-factor verification.",
    action: null,
  },
  revoked: {
    label: "Direct deposit revoked",
    detail:
      "Electronic payment to this vendor was withdrawn along with their payout claim. Restoring re-opens it and needs two-factor verification.",
    action: null,
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

  const changeAccess = (nextStatus: "active" | "suspended" | "revoked") =>
    startTransition(async () => {
      try {
        unwrapAction(await setCompanyPaymentAccessStatusAction(companyId, nextStatus));
        toast({
          title:
            nextStatus === "active"
              ? "Payment access restored"
              : nextStatus === "suspended"
                ? "Payment access suspended"
                : "Payment access revoked",
          description:
            nextStatus === "active"
              // Restoring re-enters the new-vendor hold window, so the next run
              // is held rather than paying a destination nobody re-checked.
              ? "The next payment to this vendor is held for your new-vendor hold period before it can be released."
              : nextStatus === "suspended"
                ? "Existing in-flight payments are unchanged; future runs are blocked and the vendor's payment page is closed."
                : "Their payment claim is withdrawn with their access. Existing in-flight payments are unchanged.",
        });
        router.refresh();
      } catch (error) {
        toast({ title: "Unable to change payment access", description: (error as Error).message });
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
      {canEdit ? (
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {copy.action ? (
            <Button variant="outline" size="sm" onClick={invite} disabled={pending}>
              {pending ? "Sending…" : copy.action}
            </Button>
          ) : null}
          {status === "suspended" || status === "revoked" ? (
            <Button variant="outline" size="sm" onClick={() => changeAccess("active")} disabled={pending}>Restore</Button>
          ) : status !== "not_started" ? (
            <>
              <Button variant="outline" size="sm" onClick={() => changeAccess("suspended")} disabled={pending}>Suspend</Button>
              <Button variant="destructive" size="sm" onClick={() => changeAccess("revoked")} disabled={pending}>Revoke</Button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
