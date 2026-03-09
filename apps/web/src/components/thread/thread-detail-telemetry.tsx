import React from "react";

type ThreadDetailTelemetryProps = {
  state: string;
  turnCount: number;
  elapsed: string;
  activePhase: string | null;
};

export function ThreadDetailTelemetry({
  state,
  turnCount,
  elapsed,
  activePhase,
}: ThreadDetailTelemetryProps) {
  const items = [
    { label: "State", value: state },
    { label: "Turns", value: String(turnCount) },
    { label: "Elapsed", value: elapsed },
    { label: "Phase", value: activePhase ?? "Idle" },
  ];

  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border/50 bg-card/25 px-3 py-1.5 text-xs">
      {items.map((item, i) => (
        <React.Fragment key={item.label}>
          {i > 0 && <span className="hidden text-border/60 md:inline">·</span>}
          <span className="text-muted-foreground">{item.label}</span>
          <span className="font-medium text-foreground">{item.value}</span>
        </React.Fragment>
      ))}
    </div>
  );
}
