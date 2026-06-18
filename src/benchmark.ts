/**
 * Benchmark Cartesia STT (Ink) and TTS (Sonic) latency.
 *
 * Strategy: synthesize known phrases with TTS, then feed that audio back into STT.
 * This measures speed for both AND gives a rough accuracy (WER) signal for free,
 * since we know exactly what text the audio should contain.
 *
 *   npm run bench            # 5 runs per phrase
 *   npm run bench -- 10      # 10 runs per phrase
 *
 * Measures:
 *   TTS batch  — total synth time + real-time factor (RTF = audio sec / wall sec)
 *   TTS stream — time-to-first-audio (TTFA) over the websocket + total
 *   STT        — transcribe time + rough word error rate
 */
import { CartesiaClient } from "@cartesia/cartesia-js";
import { Blob } from "node:buffer";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

const cartesia = new CartesiaClient({ apiKey: config.cartesiaApiKey });
const SR = config.sampleRate;
const RUNS = Number(process.argv[2] ?? 5);

const PHRASES = [
  "Hello, can you help me check my appointments for tomorrow?",
  "What time is my doctor visit on Friday afternoon?",
  "Please remind me to take my medication at eight o'clock.",
];

const OUTPUT_FORMAT = { container: "raw", encoding: "pcm_s16le", sampleRate: SR } as const;
const voice = { mode: "id", id: config.voiceId } as const;

// ── helpers ──────────────────────────────────────────────────────────────
async function readableToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

// pcm_s16le mono: 2 bytes per sample.
const audioSeconds = (bytes: number) => bytes / 2 / SR;

function percentile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

function report(label: string, unit: string, xs: number[]): void {
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  const f = (n: number) => n.toFixed(unit === "x" ? 2 : 0);
  console.log(
    `  ${label.padEnd(22)} n=${xs.length}  ` +
      `min ${f(Math.min(...xs))}  avg ${f(avg)}  ` +
      `p50 ${f(percentile(xs, 0.5))}  p95 ${f(percentile(xs, 0.95))}  ` +
      `max ${f(Math.max(...xs))} ${unit}`,
  );
}

// rough word error rate (Levenshtein over normalized words)
function wer(ref: string, hyp: string): number {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  const r = norm(ref), h = norm(hyp);
  const d: number[][] = Array.from({ length: r.length + 1 }, () => new Array(h.length + 1).fill(0));
  for (let i = 0; i <= r.length; i++) d[i][0] = i;
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
  return r.length ? d[r.length][h.length] / r.length : 0;
}

// ── benchmarks ───────────────────────────────────────────────────────────
async function ttsBatch(text: string) {
  const t0 = performance.now();
  const stream = await cartesia.tts.bytes({ modelId: config.ttsModel, voice, transcript: text, outputFormat: OUTPUT_FORMAT });
  const buf = await readableToBuffer(stream);
  const ms = performance.now() - t0;
  return { ms, rtf: audioSeconds(buf.length) / (ms / 1000), pcm: buf };
}

async function ttsStream(text: string) {
  const ws = cartesia.tts.websocket({ container: "raw", encoding: "pcm_s16le", sampleRate: SR });
  await ws.connect();
  const t0 = performance.now();
  let ttfa = 0;
  const response = await ws.send({ modelId: config.ttsModel, voice, transcript: text, contextId: randomUUID(), continue: false });
  await new Promise<void>((resolve, reject) => {
    response.on("message", (raw) => {
      const m = JSON.parse(raw) as { type?: string; data?: string; error?: string };
      if (m.type === "chunk" && m.data && !ttfa) ttfa = performance.now() - t0;
      else if (m.type === "done") resolve();
      else if (m.type === "error") reject(new Error(m.error ?? "tts error"));
    });
  });
  ws.disconnect();
  return { ttfa, total: performance.now() - t0 };
}

async function stt(pcm: Buffer, refText: string) {
  const t0 = performance.now();
  const res = await cartesia.stt.transcribe(new Blob([pcm]), {
    model: config.sttModel,
    language: config.language,
    encoding: "pcm_s16le",
    sampleRate: SR,
  });
  return { ms: performance.now() - t0, wer: wer(refText, res.text ?? "") };
}

// ── main ─────────────────────────────────────────────────────────────────
const m = {
  ttsBatchMs: [] as number[], ttsRtf: [] as number[],
  ttsTtfaMs: [] as number[], ttsTotalMs: [] as number[],
  sttMs: [] as number[], sttWer: [] as number[],
};

console.log(`\nBenchmark: ${RUNS} runs × ${PHRASES.length} phrases`);
console.log(`tts=${config.ttsModel}  stt=${config.sttModel}  sampleRate=${SR}Hz\n`);

for (let run = 0; run < RUNS; run++) {
  for (const phrase of PHRASES) {
    const batch = await ttsBatch(phrase);
    m.ttsBatchMs.push(batch.ms);
    m.ttsRtf.push(batch.rtf);

    const stream = await ttsStream(phrase);
    m.ttsTtfaMs.push(stream.ttfa);
    m.ttsTotalMs.push(stream.total);

    const s = await stt(batch.pcm, phrase);
    m.sttMs.push(s.ms);
    m.sttWer.push(s.wer * 100);
  }
  process.stdout.write(`  run ${run + 1}/${RUNS} done\r`);
}

console.log("\n\nTTS (Sonic)");
report("batch total", "ms", m.ttsBatchMs);
report("batch real-time factor", "x", m.ttsRtf);
report("stream first-audio", "ms", m.ttsTtfaMs);
report("stream total", "ms", m.ttsTotalMs);

console.log("\nSTT (Ink)");
report("transcribe", "ms", m.sttMs);
report("word error rate", "%", m.sttWer);

console.log(
  "\nNotes: RTF > 1x means audio is generated faster than it plays (no stalls).",
  "\n       WER here is on synthetic speech — benchmark real older-adult audio separately.\n",
);
