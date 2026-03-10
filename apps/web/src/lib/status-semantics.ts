import type { ComponentType } from "react";
import {
  Bot,
  Brain,
  CheckCircle,
  Circle,
  CircleStop,
  CircleX,
  FilePenLine,
  FileText,
  FlaskConical,
  Globe,
  LoaderCircle,
  SearchCode,
  ShieldCheck,
  SquareTerminal,
  type LucideProps,
} from "lucide-react";

export type SemanticTone = "default" | "secondary" | "destructive";
export type DashboardStatus = "success" | "warning" | "error" | "idle" | "running";

type IconComponent = ComponentType<LucideProps>;

export function normalizeThreadState(state: string | undefined): string {
  return (state ?? "").trim().toLowerCase();
}

export function threadStateLabel(state: string | undefined): string {
  const normalized = normalizeThreadState(state);
  if (normalized === "working") return "Working";
  if (normalized === "running") return "Running";
  if (normalized === "stopping") return "Stopping";
  if (normalized === "stopped") return "Done";
  if (normalized === "error") return "Error";
  return "Idle";
}

export function threadStateIcon(state: string | undefined): IconComponent {
  const normalized = normalizeThreadState(state);
  if (normalized === "running" || normalized === "working") return LoaderCircle;
  if (normalized === "stopping") return CircleStop;
  if (normalized === "error") return CircleX;
  if (normalized === "stopped") return CheckCircle;
  return Circle;
}

export function threadStateIconClassName(state: string | undefined): string {
  const normalized = normalizeThreadState(state);
  if (normalized === "running" || normalized === "working") return "text-primary animate-spin";
  if (normalized === "stopping") return "text-muted-foreground animate-pulse";
  if (normalized === "error") return "text-destructive";
  if (normalized === "stopped") return "text-primary";
  return "text-muted-foreground";
}

export function categorizeAgentStatusText(status: string | null): {
  icon: IconComponent;
  text: string;
} {
  const raw = (status ?? "").replace(/\s+/g, " ").trim();
  const lower = raw.toLowerCase();
  if (!raw) return { icon: Bot, text: "Working" };
  if (/search|grep|find/.test(lower)) return { icon: SearchCode, text: raw };
  if (/read|reading/.test(lower)) return { icon: FileText, text: raw };
  if (/edit|write|creat/.test(lower)) return { icon: FilePenLine, text: raw };
  if (/run|shell|command/.test(lower)) return { icon: SquareTerminal, text: raw };
  if (/fetch|web/.test(lower)) return { icon: Globe, text: raw };
  if (/think|reason/.test(lower)) return { icon: Brain, text: raw };
  if (/review|audit|verify|check/.test(lower)) return { icon: ShieldCheck, text: raw };
  if (/test|qa|validate/.test(lower)) return { icon: FlaskConical, text: raw };
  return { icon: Bot, text: raw };
}

export function normalizeSubagentStatus(status: string | undefined): string {
  const normalized = (status ?? "").trim().toLowerCase();
  if (normalized === "progress") return "working";
  return normalized;
}

export function subagentTone(status: string | undefined): SemanticTone {
  const normalized = normalizeSubagentStatus(status);
  if (normalized === "failed") return "destructive";
  if (normalized === "completed" || normalized === "selected") return "default";
  return "secondary";
}

export function subagentStatusLabel(status: string | undefined): string {
  const normalized = normalizeSubagentStatus(status);
  if (normalized === "working") return "Running";
  if (normalized === "started") return "Starting";
  if (normalized === "completed") return "Complete";
  if (normalized === "failed") return "Failed";
  if (normalized === "selected") return "Selected";
  return normalized.replace(/_/g, " ") || "Update";
}

export function subagentDotClassName(status: string | undefined): string {
  const normalized = normalizeSubagentStatus(status);
  if (normalized === "failed") return "bg-destructive";
  if (normalized === "completed" || normalized === "selected") return "bg-primary";
  return "bg-primary";
}

export function dashboardStatusDotClassName(status: DashboardStatus): string {
  if (status === "success") return "bg-primary";
  if (status === "warning") return "bg-yellow-500";
  if (status === "error") return "bg-destructive";
  if (status === "running") return "bg-primary animate-pulse";
  return "bg-muted-foreground";
}

export function toolGroupStatusIcon(loading: number, error: number): IconComponent {
  if (error > 0) return CircleX;
  if (loading > 0) return LoaderCircle;
  return CheckCircle;
}

export function toolGroupStatusIconClassName(loading: number, error: number): string {
  if (error > 0) return "text-destructive";
  if (loading > 0) return "text-muted-foreground animate-spin";
  return "text-primary";
}
