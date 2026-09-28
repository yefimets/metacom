/// Colours for member names. The hub gives every member an index into this palette (hub/lib/
/// colors.js, the same order), so Alex is the same colour on every machine and in every room,
/// and no two names in a room share one; humans can say "the orange one". A name the hub has
/// not coloured falls back to its hash over the first ten, the palette as it once was.
const PALETTE = [
  "#61AFEF", // blue
  "#E88F4C", // orange
  "#98C379", // green
  "#C678DD", // purple
  "#56B6C2", // cyan
  "#E5C07B", // yellow
  "#E06C75", // red
  "#7DC8A0", // mint
  "#BEA0E6", // lavender
  "#DCA08C", // tan
  "#FF79C6", // pink
  "#8BE9FD", // sky
  "#F1FA8C", // lemon
  "#4EC9B0", // teal
  "#FFB86C", // apricot
  "#A6ACEC", // periwinkle
  "#D7875F", // rust
  "#B5CEA8", // sage
  "#FF6E6E", // coral
  "#87AFFF", // cornflower
];

const LEGACY = 10;
const assigned = new Map<string, number>();

/// The hub's colours, from the member list (every room's): called whenever it comes.
export const setColors = (list: { name: string; color?: number }[]): void => {
  for (const m of list) if (typeof m.color === "number") assigned.set(m.name.toLowerCase(), m.color);
};

const hash = (s: string): number => {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
};

export const nameColor = (name: string): string => {
  const key = name.toLowerCase();
  const i = assigned.get(key);
  return PALETTE[i !== undefined ? i % PALETTE.length : hash(key) % LEGACY]!;
};
