"use client";

import { Component, type ReactNode } from "react";
import type { DashboardSpec } from "./types";
import { DashboardLayout } from "./layout";
import { parseDashboardSpec as parseToonSpec } from "@/lib/viewer/dashboard-parser";

interface ErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class DashboardErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function parseDashboardSpec(raw: string): DashboardSpec | null {
  // Try TOON format first (the primary format emitted by the agent)
  const toonResult = parseToonSpec(raw);
  if (toonResult) return toonResult as DashboardSpec;

  // Fall back to JSON
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "title" in parsed && "components" in parsed) {
      return parsed as DashboardSpec;
    }
    return null;
  } catch {
    return null;
  }
}

function ErrorCard({ raw }: { raw: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
      <p className="mb-2 text-xs font-medium text-destructive">Failed to render dashboard</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{raw}</pre>
    </div>
  );
}

export function DashboardRenderer({ spec: raw }: { spec: string }) {
  const spec = parseDashboardSpec(raw);

  if (!spec) {
    return <ErrorCard raw={raw} />;
  }

  return (
    <DashboardErrorBoundary fallback={<ErrorCard raw={raw} />}>
      <DashboardLayout spec={spec} />
    </DashboardErrorBoundary>
  );
}
