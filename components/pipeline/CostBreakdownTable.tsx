import type { Estimate } from "@/lib/cost-estimator";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type CostBreakdownTableProps = {
  /** The forecast estimate produced by `estimatePipelineCost`. */
  estimate: Estimate;
  /** Optional realised costs — when present, an Actual column appears. */
  actual?: Estimate;
  /** Optional override for the empty-state message. */
  emptyMessage?: string;
  /** Optional outer wrapper override. */
  className?: string;
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const formatCurrency = (n: number): string => currency.format(n);

const formatUnits = (n: number): string => {
  // Integer-ish counts render without decimals; fractional (e.g. 0.8 1k chars)
  // keep two decimal places so the column reads cleanly.
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
};

/**
 * Tabular cost breakdown for the pipeline review / done stages. Renders
 * one row per line item plus a bold total row. When `actual` is provided
 * the table grows an Actual column alongside the forecast subtotal.
 *
 * The wrapping `overflow-x-auto` keeps the table usable at 375px — the
 * inner table sets a `min-w-` so cells don't squash.
 */
export function CostBreakdownTable({
  estimate,
  actual,
  emptyMessage,
  className,
}: CostBreakdownTableProps) {
  if (estimate.items.length === 0) {
    return (
      <div
        className={cn(
          "rounded-md border border-dashed bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground",
          className,
        )}
        role="status"
      >
        {emptyMessage ?? "No cost yet"}
      </div>
    );
  }

  // Build a lookup so the Actual column lines up by API label.
  const actualByApi = new Map<string, number>();
  if (actual) {
    for (const item of actual.items) {
      actualByApi.set(item.api, item.subtotal);
    }
  }

  return (
    <div className={cn("overflow-x-auto", className)}>
      <div className="min-w-[520px]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>API</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
              <TableHead className="text-right">Subtotal</TableHead>
              {actual ? <TableHead className="text-right">Actual</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {estimate.items.map((item) => (
              <TableRow key={`${item.api}-${item.unit_label}`}>
                <TableCell className="font-medium">{item.api}</TableCell>
                <TableCell className="text-muted-foreground">{item.unit_label}</TableCell>
                <TableCell className="text-right tabular-nums">{formatUnits(item.units)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(item.unit_cost)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(item.subtotal)}
                </TableCell>
                {actual ? (
                  <TableCell className="text-right tabular-nums">
                    {actualByApi.has(item.api)
                      ? formatCurrency(actualByApi.get(item.api) ?? 0)
                      : "—"}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold" colSpan={4}>
                Total
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">
                {formatCurrency(estimate.total)}
              </TableCell>
              {actual ? (
                <TableCell className="text-right font-semibold tabular-nums">
                  {formatCurrency(actual.total)}
                </TableCell>
              ) : null}
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </div>
  );
}
