"use client";

/**
 * The table behind a chart, collapsed by default.
 *
 * Every chart on the dashboard ships one. It is the accessibility fallback —
 * a screen reader, a forced-colours mode, or anyone who simply wants the
 * numbers gets the same data the marks encode, without needing the colours to
 * be distinguishable. `<details>` is deliberate: it is keyboard-operable and
 * announced correctly with no JavaScript and no dependency.
 */
export function ChartDataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: string[][];
}) {
  return (
    <details className="group">
      <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit cursor-pointer rounded-md text-xs focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none">
        Show the data
      </summary>
      <div className="border-border mt-3 max-h-64 overflow-auto rounded-lg border">
        <table className="w-full text-left text-xs tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-muted text-muted-foreground sticky top-0">
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col" className="px-3 py-2 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-border border-t">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-3 py-1.5">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
