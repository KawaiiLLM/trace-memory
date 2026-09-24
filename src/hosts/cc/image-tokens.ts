// Use the pure header reader, not the package barrel that initializes terminal/editor modules.
import { getImageDimensions } from "@earendil-works/pi-tui/dist/terminal-image.js";

/** Anthropic Vision and resize reference, checked 2026-09-24 UTC:
 * https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size
 * https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#resize-your-image-before-uploading
 * Only embedded base64 image blocks have locally knowable dimensions. */
function modelLimits(model: string | undefined): { edge: number; tokens: number } | null {
  if (!model) return null;
  // Accept Claude's family-first and legacy version-first IDs, optional dated/sized suffixes;
  // unrecognized providers/aliases must not be assigned a resolution tier by guesswork.
  const id = model.replace(/\[\d+[mk]\]$/, "").replace(/-\d{8}$/, "");
  const match = /^(?:claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?|claude-(\d+)(?:-(\d+))?-(?:opus|sonnet|haiku))$/.exec(id);
  if (!match) return null;
  const major = Number(match[1] ?? match[3]);
  const minor = Number(match[2] ?? match[4] ?? 0);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || major < 3) return null;
  return major > 4 || (major === 4 && minor >= 7)
    ? { edge: 2576, tokens: 4784 }
    : { edge: 1568, tokens: 1568 };
}

const patches = (width: number, height: number): number => Math.ceil(width / 28) * Math.ceil(height / 28);
const evenRound = (value: number): number => {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? floor + (floor % 2) : Math.round(value);
};

/** Exact binary search from Anthropic's TypeScript reference, including padded-edge checks. */
function resizedSize(width: number, height: number, edge: number, budget: number): [number, number] {
  const fits = (w: number, h: number): boolean =>
    Math.ceil(w / 28) * 28 <= edge && Math.ceil(h / 28) * 28 <= edge && patches(w, h) <= budget;
  if (fits(width, height)) return [width, height];
  if (height > width) {
    const [h, w] = resizedSize(height, width, edge, budget);
    return [w, h];
  }
  const ratio = width / height;
  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(evenRound(mid / ratio), 1))) lo = mid;
    else hi = mid;
  }
  return [lo, Math.max(evenRound(lo / ratio), 1)];
}

/** Local visual-token estimate for one Claude API image block; null means unavailable. */
export function estimateCcImageTokens(block: Record<string, unknown>, model: string | undefined): number | null {
  if (block.type !== "image") return null;
  const limits = modelLimits(model);
  const source = block.source;
  if (!limits || !source || typeof source !== "object" || Array.isArray(source)) return null;
  const image = source as Record<string, unknown>;
  if (image.type !== "base64" || typeof image.data !== "string" || typeof image.media_type !== "string") return null;
  const dimensions = getImageDimensions(image.data, image.media_type);
  if (!dimensions || !Number.isSafeInteger(dimensions.widthPx) || !Number.isSafeInteger(dimensions.heightPx) ||
      dimensions.widthPx < 1 || dimensions.heightPx < 1) return null;
  const [width, height] = resizedSize(dimensions.widthPx, dimensions.heightPx, limits.edge, limits.tokens);
  return patches(width, height);
}
