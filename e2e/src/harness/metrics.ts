export type E2ETimingName =
  | "start"
  | "apiReady"
  | "workflowRequest"
  | "workflowAccepted"
  | "executionAccepted"
  | "streamStarted"
  | "firstEvent"
  | "turnDone";

export class E2EMetrics {
  private readonly marks = new Map<E2ETimingName, number>();

  mark(name: E2ETimingName): void {
    this.marks.set(name, Date.now());
  }

  sinceStart(name: E2ETimingName): number | undefined {
    const start = this.marks.get("start");
    const mark = this.marks.get(name);
    if (start === undefined || mark === undefined) return undefined;
    return mark - start;
  }

  summary(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...extra,
      apiReadyMs: this.sinceStart("apiReady"),
      workflowAcceptedMs: this.sinceStart("workflowAccepted"),
      executionAcceptedMs: this.sinceStart("executionAccepted"),
      firstEventMs: this.sinceStart("firstEvent"),
      turnDoneMs: this.sinceStart("turnDone"),
    };
  }
}
