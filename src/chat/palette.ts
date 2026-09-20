/// Colours for member names: deterministic from the name, so Alex is the same colour on
/// every machine, in every theme and every session, and humans can say "the orange one".
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
];

const hash = (s: string): number => {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
};

export const nameColor = (name: string): string => PALETTE[hash(name.toLowerCase()) % PALETTE.length]!;
