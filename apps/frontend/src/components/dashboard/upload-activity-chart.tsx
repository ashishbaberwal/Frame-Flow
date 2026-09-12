"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";

/** Chart colors validated with the dataviz palette checker for light/dark surfaces. */
const CHART = { light: "#4263EB", dark: "#6D89DC" };

function useChartColor() {
  const [color, setColor] = React.useState(CHART.light);
  React.useEffect(() => {
    const root = document.documentElement;
    const update = () =>
      setColor(root.classList.contains("dark") ? CHART.dark : CHART.light);
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return color;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-sm shadow-md">
      <p className="font-medium">{label}</p>
      <p className="text-muted-foreground tabular-nums">
        {payload[0].value.toLocaleString()} photos uploaded
      </p>
    </div>
  );
}

export function UploadActivityChart({ data }: { data: { day: string; uploads: number }[] }) {
  const color = useChartColor();
  return (
    <div className="h-64 w-full" role="img" aria-label="Bar chart of photos uploaded over the last 14 days">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="35%">
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis
            dataKey="day"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
            tickFormatter={(v: number) => (v >= 1000 ? `${v / 1000}k` : String(v))}
          />
          <RechartsTooltip cursor={{ fill: "var(--secondary)", opacity: 0.6 }} content={<ChartTooltip />} />
          <Bar dataKey="uploads" fill={color} radius={[4, 4, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
