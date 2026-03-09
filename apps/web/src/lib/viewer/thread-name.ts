const ADJECTIVES = [
  "Amber", "Bold", "Calm", "Crisp", "Deep", "Eager", "Fair", "Fast",
  "Keen", "Lean", "Live", "Mild", "Neat", "Pure", "Rich", "Sharp",
  "Slim", "Soft", "Swift", "Warm", "Wise", "Bright", "Dense", "Rapid",
  "Stark", "Vivid", "Clear", "Pale", "Thin", "Vast", "Still", "Gold",
];

const NOUNS = [
  "Arc", "Bolt", "Core", "Dash", "Edge", "Flux", "Gate", "Helm",
  "Knot", "Link", "Mesh", "Node", "Path", "Shard", "Tide", "Wave",
  "Beam", "Drift", "Echo", "Forge", "Gleam", "Haze", "Pulse", "Spark",
  "Crest", "Mist", "Nova", "Prism", "Reef", "Veil", "Rune", "Sigil",
];

function hashCode(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function threadName(threadKey: string): string {
  const h = hashCode(threadKey);
  const adj = ADJECTIVES[h % ADJECTIVES.length];
  const noun = NOUNS[(h >>> 8) % NOUNS.length];
  return `${adj} ${noun} Thread`;
}
