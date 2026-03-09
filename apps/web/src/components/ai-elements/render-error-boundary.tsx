"use client";

import type { ReactNode } from "react";
import { Component } from "react";

import { CodeBlock } from "@/components/ai-elements/code-block";

function fallbackCode(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

export class RenderErrorBoundary extends Component<
  {
    children: ReactNode;
    rawOutput: unknown;
  },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: Readonly<{ children: ReactNode; rawOutput: unknown }>): void {
    if (this.state.hasError && prevProps.rawOutput !== this.props.rawOutput) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return <CodeBlock code={fallbackCode(this.props.rawOutput)} language="json" />;
    }
    return this.props.children;
  }
}
