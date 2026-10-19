import {
  exclusionSuggestions,
  firstNames,
  proposalChanges,
  proposalNeeds,
  proposalPriceLines,
  proposalKind,
  proposalSectionStates,
  resolveProposalDocument,
  type DealProposal,
  type ProposalDefaults,
  type ProposalNames,
} from "@/lib/precon/proposal-documents";
import { money } from "@/lib/precon/format";
import { worksheetEstimateLines, type PricingWorksheet } from "@/lib/precon/pricing-worksheet";
import type { DealProposalData } from "@/lib/services/precon-proposal";

/**
 * The proposal as the client would get it right now, and what each section
 * says about itself. The server resolves the same document when it sends, from
 * the same pure functions, so the preview is the document.
 */
export function dealProposalModel(input: {
  proposal: DealProposal;
  data: DealProposalData;
  defaults: ProposalDefaults;
  worksheet: PricingWorksheet | null;
  range: { low: number; high: number } | null;
  total: number;
  client: { name: string; email: string };
  dealName: string;
  builder: string;
  sender: string;
  today: Date;
}) {
  const { proposal, data, worksheet } = input;
  const lines = worksheet ? worksheetEstimateLines(worksheet) : [];
  const priceLines = proposalPriceLines(lines);
  const kind = proposalKind(proposal);
  const names: ProposalNames = {
    client: firstNames([input.client.name, ...proposal.co_signers.map((signer) => signer.name)].filter(Boolean)) || "there",
    project: input.dealName || "your project",
    builder: input.builder,
    sender: input.sender,
  };
  const document = resolveProposalDocument({
    proposal,
    defaults: input.defaults,
    kind,
    lines: priceLines,
    names,
    primarySigner: input.client.name && input.client.email ? { name: input.client.name, email: input.client.email } : null,
    today: input.today,
  });
  const suggestions = exclusionSuggestions(data.bids, proposal, document.exclusions);
  const unanswered = data.comments.filter((comment) => !comment.answer).length;
  const clientName = input.client.name.split(" ")[0] || "The client";
  const states = proposalSectionStates({
    proposal,
    defaults: input.defaults,
    document,
    priceLabel: kind === "budget" && input.range ? `${money(input.range.low)}–${money(input.range.high)}` : money(input.total),
    optionCount: priceLines.filter((line) => line.is_optional).length,
    openSuggestions: suggestions.length,
    unansweredComments: unanswered,
    answered: data.comments.length - unanswered,
    clientName,
  });
  const changes = proposalChanges(data.lastSent, {
    kind,
    version: (data.lastSent?.version ?? 0) + 1,
    sent_at: null,
    total_cents: input.total,
    range: kind === "budget" ? input.range : null,
    options: priceLines.filter((line) => line.is_optional).map((line) => line.description),
    exclusions: document.exclusions,
    payments: document.payments.length,
    start_window: document.start_window,
    signers: document.signers.map((signer) => signer.name),
  });
  return { kind, lines, priceLines, names, document, suggestions, states, needs: proposalNeeds(states), unanswered, changes };
}

export type DealProposalModel = ReturnType<typeof dealProposalModel>;
