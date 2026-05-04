"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  XAxis,
  YAxis,
} from "recharts";

import type { ControlTowerData } from "@/lib/services/dashboard";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type Financials = ControlTowerData["financials"];
type RevenueRange = "3" | "6" | "12" | "ytd";

const revenueConfig = {
  invoiced: {
    label: "Revenue",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

const arConfig = {
  balance: {
    label: "Balance",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

function filterRevenue(
  series: Financials["revenueSeries"],
  range: RevenueRange,
) {
  if (range === "ytd") {
    const year = String(new Date().getFullYear());
    return series.filter((point) => point.key.startsWith(year));
  }

  return series.slice(-Number(range));
}

export function FinancialSummary({ financials }: { financials: Financials }) {
  const [range, setRange] = useState<RevenueRange>("6");

  const revenueData = useMemo(
    () =>
      filterRevenue(financials.revenueSeries, range).map((point) => ({
        ...point,
        date: `${point.key}-01`,
        invoiced: point.revenueCents / 100,
      })),
    [financials.revenueSeries, range],
  );

  const arAgingData = [
    {
      bucket: "Current",
      balance: financials.arAging.current / 100,
      fill: "url(#arCurrent)",
    },
    {
      bucket: "1-30",
      balance: financials.arAging.oneToThirty / 100,
      fill: "url(#arOneToThirty)",
    },
    {
      bucket: "31-60",
      balance: financials.arAging.thirtyOneToSixty / 100,
      fill: "url(#arThirtyOneToSixty)",
    },
    {
      bucket: "61-90",
      balance: financials.arAging.sixtyOneToNinety / 100,
      fill: "url(#arSixtyOneToNinety)",
    },
    {
      bucket: "90+",
      balance: financials.arAging.overNinety / 100,
      fill: "url(#arOverNinety)",
    },
    {
      bucket: "No due",
      balance: financials.arAging.noDueDate / 100,
      fill: "url(#arNoDue)",
    },
  ];

  const revenueTotal = revenueData.reduce(
    (sum, point) => sum + point.invoiced,
    0,
  );

  return (
    <section className="border-b border-border/70 bg-card">
      <div className="grid lg:grid-cols-2">
        <div className="min-w-0 border-b border-border/70 px-4 py-4 sm:px-6 lg:border-b-0 lg:border-r">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Receivables
              </p>
              <h2 className="text-lg font-semibold tracking-tight">Revenue</h2>
              <p className="text-xs text-muted-foreground">
                {formatCurrency(revenueTotal * 100)} in selected range
              </p>
            </div>
            <ToggleGroup
              type="single"
              value={range}
              variant="outline"
              size="sm"
              onValueChange={(value) =>
                value && setRange(value as RevenueRange)
              }
            >
              <ToggleGroupItem value="3" aria-label="Show 3 months">
                3
              </ToggleGroupItem>
              <ToggleGroupItem value="6" aria-label="Show 6 months">
                6
              </ToggleGroupItem>
              <ToggleGroupItem value="12" aria-label="Show 12 months">
                12
              </ToggleGroupItem>
              <ToggleGroupItem value="ytd" aria-label="Show year to date">
                YTD
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <ChartContainer
            config={revenueConfig}
            className="h-[230px] w-full aspect-auto"
          >
            <AreaChart data={revenueData} margin={{ left: 0, right: 8 }}>
              <defs>
                <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="var(--color-invoiced)"
                    stopOpacity={0.9}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--color-invoiced)"
                    stopOpacity={0.12}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={28}
                tickFormatter={(value) =>
                  new Date(value).toLocaleDateString("en-US", {
                    month: "short",
                  })
                }
              />
              <YAxis
                tickFormatter={(value) => formatCurrency(Number(value) * 100)}
                tickLine={false}
                axisLine={false}
                domain={[0, (dataMax: number) => Math.max(dataMax, 1)]}
                width={48}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) =>
                      new Date(value).toLocaleDateString("en-US", {
                        month: "short",
                        year: "numeric",
                      })
                    }
                    formatter={(value) => formatCurrency(Number(value) * 100)}
                    indicator="dot"
                  />
                }
              />
              <Area
                dataKey="invoiced"
                type="monotone"
                fill="url(#fillRevenue)"
                fillOpacity={1}
                stroke="var(--color-invoiced)"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive
              />
            </AreaChart>
          </ChartContainer>
        </div>

        <div className="min-w-0 px-4 py-4 sm:px-6">
          <div className="mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Receivables
            </p>
            <h2 className="text-lg font-semibold tracking-tight">AR Aging</h2>
            <p className="text-xs text-muted-foreground">
              {formatCurrency(financials.outstandingAR)} outstanding
            </p>
          </div>

          <ChartContainer
            config={arConfig}
            className="h-[230px] w-full aspect-auto"
          >
            <BarChart data={arAgingData} margin={{ left: 0, right: 8 }}>
              <defs>
                <linearGradient id="arCurrent" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--chart-2)"
                    stopOpacity={0.95}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--chart-2)"
                    stopOpacity={0.45}
                  />
                </linearGradient>
                <linearGradient id="arOneToThirty" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--chart-1)"
                    stopOpacity={0.95}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--chart-1)"
                    stopOpacity={0.45}
                  />
                </linearGradient>
                <linearGradient
                  id="arThirtyOneToSixty"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor="var(--chart-3)"
                    stopOpacity={0.95}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--chart-3)"
                    stopOpacity={0.45}
                  />
                </linearGradient>
                <linearGradient
                  id="arSixtyOneToNinety"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor="var(--chart-4)"
                    stopOpacity={0.95}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--chart-4)"
                    stopOpacity={0.45}
                  />
                </linearGradient>
                <linearGradient id="arOverNinety" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--destructive)"
                    stopOpacity={0.95}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--destructive)"
                    stopOpacity={0.5}
                  />
                </linearGradient>
                <linearGradient id="arNoDue" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--muted-foreground)"
                    stopOpacity={0.75}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--muted-foreground)"
                    stopOpacity={0.3}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="bucket"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <YAxis
                tickFormatter={(value) => formatCurrency(Number(value) * 100)}
                tickLine={false}
                axisLine={false}
                domain={[0, (dataMax: number) => Math.max(dataMax, 1)]}
                width={48}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    formatter={(value) => formatCurrency(Number(value) * 100)}
                  />
                }
              />
              <Bar dataKey="balance" radius={[7, 7, 2, 2]} isAnimationActive>
                {arAgingData.map((entry) => (
                  <Cell key={entry.bucket} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        </div>
      </div>
    </section>
  );
}
