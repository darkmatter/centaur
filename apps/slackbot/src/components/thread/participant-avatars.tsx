"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Participant } from "@/lib/types";
import { cn } from "@/lib/utils";

const FALLBACK_COLORS = [
  "bg-blue-500/20 text-blue-300",
  "bg-violet-500/20 text-violet-300",
  "bg-emerald-500/20 text-emerald-300",
  "bg-amber-500/20 text-amber-300",
  "bg-pink-500/20 text-pink-300",
] as const;
const SLACK_USER_ID_RE = /^U[A-Z0-9]+$/;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

function participantLabel(participant: Participant): string {
  const name = String(participant.name || "").trim();
  if (name && !SLACK_USER_ID_RE.test(name)) return name;
  const id = String(participant.id || "").trim();
  if (!id) return "Participant";
  if (SLACK_USER_ID_RE.test(id)) return `User ${id.slice(-4)}`;
  return id;
}

export function ParticipantAvatars({
  participants,
  max = 3,
  size = 20,
}: {
  participants?: Participant[];
  max?: number;
  size?: number;
}) {
  const resolved = (participants ?? []).filter((p) => String(p.id || "").trim().length > 0);
  if (resolved.length === 0) return null;
  const visible = resolved.slice(0, max);
  const overflow = resolved.length - visible.length;

  return (
    <div className="inline-flex items-center -space-x-1.5">
      {visible.map((participant) => {
        const label = participantLabel(participant);
        return (
          <Tooltip key={participant.id}>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                role="img"
                aria-label={label}
                className={cn(
                  "ring-2 ring-background rounded-full shrink-0 overflow-hidden flex items-center justify-center text-[10px] font-semibold",
                  !participant.avatar_url && colorForId(participant.id),
                )}
                style={{ width: size, height: size }}
              >
                {participant.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={participant.avatar_url}
                    alt={label}
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  initials(label)
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
      {overflow > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              role="img"
              aria-label={`${overflow} more participant${overflow === 1 ? "" : "s"}`}
              className="ring-2 ring-background rounded-full bg-secondary text-muted-foreground shrink-0 flex items-center justify-center text-[10px] font-semibold"
              style={{ width: size, height: size }}
            >
              +{overflow}
            </span>
          </TooltipTrigger>
          <TooltipContent>{overflow} more participant{overflow === 1 ? "" : "s"}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
