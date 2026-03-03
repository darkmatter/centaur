import type { Step } from "@/lib/describe";

export type TurnStepGroup = {
  groupKey: string;
  turnId: number | null;
  label: string;
  steps: Step[];
};

function parseTurnIdFromStepId(stepId: string): number | null {
  const turnMatch = stepId.match(/turn-(\d+)/);
  if (turnMatch) {
    const value = Number(turnMatch[1]);
    return Number.isFinite(value) ? value : null;
  }
  const phaseMatch = stepId.match(/^phase:(\d+):/);
  if (!phaseMatch) return null;
  const value = Number(phaseMatch[1]);
  return Number.isFinite(value) ? value : null;
}

function getStepTurnId(step: Step): number | null {
  if (typeof step.turnId === "number" && Number.isFinite(step.turnId)) {
    return step.turnId;
  }
  return parseTurnIdFromStepId(step.id);
}

function getStepEventSeq(step: Step): number {
  if ("eventSeq" in step && typeof step.eventSeq === "number") {
    return step.eventSeq;
  }
  return Number.MAX_SAFE_INTEGER;
}

function orderStepsDeterministically(steps: Step[]): Step[] {
  return steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => {
      const seqA = getStepEventSeq(a.step);
      const seqB = getStepEventSeq(b.step);
      const hasSeqA = seqA !== Number.MAX_SAFE_INTEGER;
      const hasSeqB = seqB !== Number.MAX_SAFE_INTEGER;
      if (hasSeqA && hasSeqB && seqA !== seqB) return seqA - seqB;
      if (hasSeqA !== hasSeqB) return hasSeqA ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.step);
}

export function groupStepsByTurn(steps: Step[], alreadyOrdered = false): TurnStepGroup[] {
  const ordered = alreadyOrdered ? steps : orderStepsDeterministically(steps);
  const groups: TurnStepGroup[] = [];
  let current: TurnStepGroup | null = null;
  let groupIndex = 0;

  for (const step of ordered) {
    const turnId = getStepTurnId(step);
    if (!current || current.turnId !== turnId) {
      const prefix: string = turnId === null ? "context" : `turn-${turnId}`;
      current = {
        groupKey: `${prefix}:${groupIndex}`,
        turnId,
        label: turnId === null ? "Thread Context" : `Turn ${turnId}`,
        steps: [],
      };
      groups.push(current);
      groupIndex += 1;
    }
    current.steps.push(step);
  }

  return groups;
}
