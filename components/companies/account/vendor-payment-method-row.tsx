"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { inviteCompanyToPaymentSetupAction } from "@/app/(app)/companies/actions";
import { unwrapAction } from "@/lib/action-result";
import type { CompanyPaymentReadiness } from "@/lib/services/vendor-payment-invitations";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

/**
 * How this vendor actually gets paid today. Paying by check is a legitimate
 * standing answer, not a setup failure, so the row reports the current method
 * plainly and offers Arc Pay as a quiet alternative rather than a prompt.
 */
const STATUS_LABEL: Record<CompanyPaymentReadiness["status"], string | null> = {
  ready: "Arc Pay",
  verifying: "Arc Pay — verifying",
  invited: "Arc Pay — invited",
  not_started: null,
  suspended: "Arc Pay — suspended",
  revoked: "Arc Pay — revoked",
};

function formatMethod(value?: string) {
  if (!value) return "Check";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function VendorPaymentMethodRow({
  companyId,
  readiness,
  defaultMethod,
  canEdit,
}: {
  companyId: string;
  readiness: CompanyPaymentReadiness | null;
  defaultMethod?: string;
  canEdit: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const status = readiness?.status ?? "not_started";
  const enrolledLabel = STATUS_LABEL[status];
  const canInvite = status === "not_started" || status === "invited" || status === "verifying";

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
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">Payment method</span>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate font-medium text-foreground">
          {enrolledLabel ?? formatMethod(defaultMethod)}
        </span>
        {canEdit && canInvite ? (
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 h-auto shrink-0 px-1.5 py-0.5 text-xs font-normal text-muted-foreground hover:text-foreground"
            onClick={invite}
            disabled={pending}
          >
            {pending ? "Sending…" : status === "not_started" ? "Invite to Arc Pay" : "Resend"}
          </Button>
        ) : null}
      </span>
    </div>
  );
}
