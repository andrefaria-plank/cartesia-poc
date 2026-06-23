/**
 * One-time: synthesize the latency-masking filler clips with Sonic and bake them
 * into a static asset (public/fillers.json) as base64 PCM. The browser fetches
 * this once and plays a random clip INSTANTLY on mic-stop — no server round-trip,
 * which is the whole point of a filler. Re-run if the voice or phrases change.
 *
 *   npm run gen:fillers
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { synthesizeOnce } from "../lib/cartesia";

const PHRASES = ["Let me check that for you.", "One moment…", "Okay, looking now."];

const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "fillers.json",
);

const clips = await Promise.all(PHRASES.map(synthesizeOnce));
writeFileSync(out, JSON.stringify(clips));
console.log(`Wrote ${clips.length} filler clips → ${out}`);
