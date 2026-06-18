import { synthesizeOnce } from "./cartesia.js";

// Pre-cached "let me think…" clips. Synthesized ONCE at boot so they play instantly,
// masking STT + LLM-first-token latency.
const PHRASES = ["Let me check that for you.", "One moment…", "Okay, looking now."];

let cache: string[] = [];

export async function warmFillers(): Promise<void> {
  cache = await Promise.all(PHRASES.map(synthesizeOnce));
}

export function randomFiller(): string | null {
  if (cache.length === 0) return null;
  return cache[Math.floor(Math.random() * cache.length)];
}
