import Link from "next/link";
import { addDays, type PayPeriodRange } from "@/lib/time/pay-periods";
import { formatLocalDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// Server-side period navigation: `?period=` carries any date inside the period.
export function TimesheetPeriodNav({
  period,
  current,
  basePath,
  params = {},
}: {
  period: PayPeriodRange;
  current: PayPeriodRange;
  basePath: string;
  params?: Record<string, string>;
}) {
  const href = (date: string | null) => {
    const query = new URLSearchParams(params);
    if (date) query.set("period", date);
    const text = query.toString();
    return text ? `${basePath}?${text}` : basePath;
  };
  const isCurrent = period.startsOn === current.startsOn;
  const label = `${formatLocalDate(period.startsOn, "MMM d")} – ${formatLocalDate(period.endsOn, "MMM d, yyyy")}`;
  return (
    <div className="flex items-center gap-2">
      <Button asChild size="sm" variant="outline">
        <Link href={href(addDays(period.startsOn, -1))} scroll={false}>
          Previous
        </Link>
      </Button>
      <span className="min-w-40 text-center text-sm font-medium tabular-nums">{label}</span>
      {isCurrent ? (
        <Button size="sm" variant="outline" disabled>
          Next
        </Button>
      ) : (
        <Button asChild size="sm" variant="outline">
          <Link href={href(addDays(period.endsOn, 1))} scroll={false}>
            Next
          </Link>
        </Button>
      )}
      {!isCurrent && (
        <Button asChild size="sm" variant="ghost">
          <Link href={href(null)} scroll={false}>
            Current
          </Link>
        </Button>
      )}
    </div>
  );
}
