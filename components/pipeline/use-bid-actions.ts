"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  answerPricingQuestionAction,
  issuePricingRequestAction,
  recordPricingQuoteAction,
  resendPricingInvitationAction,
  revisePricingRequestScopeAction,
  savePricingRequestDetailsAction,
  selectPricingQuoteAction,
  sendPricingRequestAction,
  setPricingBidPlugAction,
} from "@/app/(app)/pipeline/[dealId]/pricing-actions";
import { unwrapAction } from "@/lib/action-result";
import type { BidPricingGap } from "@/lib/bids/pricing";
import { useDealRoom } from "./deal-room";

type Invitee = { company_id?: string; contact_id?: string; invite_email?: string };

/** Every Bids mutation, through the deal's pricing actions, with one pending flag and one way to report. */
export function useBidActions() {
  const room = useDealRoom();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const prospectId = room.deal.id;

  function run(work: () => Promise<string | void>) {
    startTransition(async () => {
      try {
        const message = await work();
        if (message) toast.success(message);
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That did not work. Try again.");
      }
    });
  }

  const invited = (result: { created: unknown[]; emailsSent: number; failed: { identifier: string; error: string }[] }) => {
    if (result.failed.length) toast.error(result.failed.map((item) => `${item.identifier}: ${item.error}`).join("\n"));
    return result.emailsSent
      ? `Sent to ${result.emailsSent} bidder${result.emailsSent === 1 ? "" : "s"}`
      : result.created.length
        ? "Invitations created, but the emails did not go out. Remind them shortly."
        : undefined;
  };

  return {
    pending,
    issue: (input: Record<string, unknown>, onDone: (packageId: string) => void) =>
      run(async () => {
        const version = await room.state.save();
        const result = unwrapAction(await issuePricingRequestAction(prospectId, input, version));
        if (result.saved) room.state.accept(result.saved);
        onDone(result.packageId);
        return invited(result.invites);
      }),
    /** Saves a request's details; once it is out, the changes go to every bidder as an addendum. */
    saveDetails: (packageId: string, input: Record<string, unknown>, notify: boolean) =>
      run(async () => {
        const notice = unwrapAction(await savePricingRequestDetailsAction(prospectId, packageId, { ...input, notify_bidders: notify }));
        if (notice?.failed.length) toast.warning("Saved, but some bidders were not notified. Send the addendum again from Bidders.");
        return notify ? "Addendum sent to every bidder" : "Saved";
      }),
    revise: (packageId: string, reason: string) =>
      run(async () => {
        const version = await room.state.save();
        const result = unwrapAction(await revisePricingRequestScopeAction(prospectId, packageId, version, reason));
        room.state.accept(result);
        return "Scope revision sent. Bids priced before it are marked to revise.";
      }),
    remind: (packageId: string, inviteIds: string[]) =>
      run(async () => {
        for (const inviteId of inviteIds) unwrapAction(await resendPricingInvitationAction(prospectId, packageId, inviteId));
        return `Reminded ${inviteIds.length} bidder${inviteIds.length === 1 ? "" : "s"}`;
      }),
    invite: (packageId: string, invitees: Invitee[]) =>
      run(async () => invited(unwrapAction(await sendPricingRequestAction(prospectId, packageId, invitees)))),
    record: (packageId: string, input: { bid_invite_id: string | null; company_id: string | null; total_cents: number; valid_until: string | null; exclusions: string; notes: string }) =>
      run(async () => {
        unwrapAction(await recordPricingQuoteAction(prospectId, packageId, input));
        return "Bid recorded as a lump sum";
      }),
    plug: (packageId: string, itemId: string, cents: number | null) =>
      run(async () => {
        unwrapAction(await setPricingBidPlugAction(prospectId, packageId, itemId, cents));
      }),
    answer: (packageId: string, rfiId: string, body: string) =>
      run(async () => {
        unwrapAction(await answerPricingQuestionAction(prospectId, packageId, rfiId, body));
        return "Answer sent to every bidder";
      }),
    /** Prices the request's lines from one bid. Throws, so the decision panel can keep its form open. */
    choose: async (packageId: string, input: { bid_submission_id: string; accepted_alternate_ids: string[]; gaps: BidPricingGap[]; rationale: string }) => {
      const version = await room.state.save();
      room.state.accept(unwrapAction(await selectPricingQuoteAction(prospectId, packageId, input, version)));
      router.refresh();
    },
  };
}

export type BidActions = ReturnType<typeof useBidActions>;
