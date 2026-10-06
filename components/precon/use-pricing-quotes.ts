"use client";

import { useCallback, useRef } from "react";
import { getPricingQuotesAction } from "@/app/(app)/pipeline/[dealId]/pricing-actions";
import { unwrapAction } from "@/lib/action-result";

export type PricingQuoteData = Awaited<
  ReturnType<typeof import("@/lib/services/precon-pricing").getPricingQuotes>
>;
type Entry = {
  data?: PricingQuoteData;
  expires: number;
  pending?: Promise<PricingQuoteData>;
};

// Scoped to this mounted worksheet, never shared between users or workspaces.
export function usePricingQuotes(prospectId: string) {
  const cache = useRef(new Map<string, Entry>());
  const read = useCallback(
    (id: string) => {
      const entry = cache.current.get(`${prospectId}:${id}`);
      return entry && entry.expires > Date.now() ? entry.data : undefined;
    },
    [prospectId],
  );
  const load = useCallback(
    (id: string, force = false): Promise<PricingQuoteData> => {
      const key = `${prospectId}:${id}`;
      const existing = cache.current.get(key);
      if (!force && existing?.pending) return existing.pending;
      if (!force && existing?.data && existing.expires > Date.now())
        return Promise.resolve(existing.data);
      const entry: Entry = { expires: 0 };
      cache.current.set(key, entry);
      entry.pending = getPricingQuotesAction(prospectId, id)
        .then(unwrapAction)
        .then((data) => {
          if (cache.current.get(key) === entry) {
            entry.data = data;
            entry.expires = Date.now() + 30_000;
          }
          return data;
        })
        .finally(() => {
          entry.pending = undefined;
        });
      return entry.pending;
    },
    [prospectId],
  );
  return { read, load };
}
