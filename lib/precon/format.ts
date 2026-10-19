export function money(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/** Scannable pipeline value: $280k, $1.25M. */
export function compactMoney(cents: number) {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1_000_000)
    return `$${(dollars / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (Math.abs(dollars) >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
  return `$${Math.round(dollars)}`;
}

/** How long a deal has waited on whoever holds it. */
export function waitingAge(since: string, now: Date) {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000));
  return { days, label: days === 0 ? "today" : `${days}d` };
}

const BAND_AMOUNT = /\$?\s*(\d+(?:\.\d+)?)\s*(k|m)?\b/gi;
const bandAmount = (value: string, unit: string) => {
  const amount = Number(value);
  return unit.toLowerCase() === "m" ? `$${amount}M` : amount >= 1000 ? `$${amount / 1000}M` : `$${amount}k`;
};

/**
 * A stated budget, however it was stored: intake keys ("500k_1m", "over_1m"),
 * typed bands ("$450k–$520k", "$500k+") and the closed lists all read the same.
 * Anything without an amount ("undecided") is no budget at all.
 */
export function budgetBand(raw: string | null) {
  if (!raw) return null;
  const text = raw.replace(/_/g, " ");
  const matches = [...text.matchAll(BAND_AMOUNT)];
  // "$1–2M" names its unit once, on the high end.
  const amounts = matches.flatMap((match, index) => {
    const unit = match[2] ?? matches.slice(index + 1).find((next) => next[2])?.[2];
    return unit ? [bandAmount(match[1], unit)] : [];
  });
  if (!amounts.length) return null;
  if (/\b(under|below|less)\b/i.test(text)) return `Under ${amounts[0]}`;
  if (amounts.length === 1) return /\b(over|above|plus)\b|\+/i.test(text) ? `${amounts[0]}+` : amounts[0];
  return `${amounts[0]}–${amounts[1]}`;
}
