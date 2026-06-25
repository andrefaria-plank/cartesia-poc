import { CartesiaClient } from "@cartesia/cartesia-js";
import { Blob } from "node:buffer";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { config } from "./config";

export const cartesia = new CartesiaClient({ apiKey: config.cartesiaApiKey });

// Raw PCM s16le so the browser can schedule chunks directly in Web Audio.
const OUTPUT_FORMAT = {
  container: "raw",
  encoding: "pcm_s16le",
  sampleRate: config.sampleRate,
} as const;

// Sonic output formats. The browser path wants raw PCM s16le @ 16k (Web Audio);
// the telephony path wants raw μ-law @ 8k so chunks drop straight into Twilio
// Media Streams `media` messages with no resampling on our side.
export type TtsOutputFormat = {
  container: "raw";
  encoding: "pcm_s16le" | "pcm_mulaw";
  sampleRate: number;
};

export const PCM16K: TtsOutputFormat = {
  container: "raw",
  encoding: "pcm_s16le",
  sampleRate: config.sampleRate,
};

export const MULAW8K: TtsOutputFormat = {
  container: "raw",
  encoding: "pcm_mulaw",
  sampleRate: 8000,
};

async function readableToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * STT (Ink). Whole-utterance transcription — there is no barge-in in this spec,
 * so a batch transcribe is both simpler and more accurate than streaming endpointing,
 * which matters because transcripts are persisted to chat history.
 */
export async function transcribe(audio: Buffer): Promise<string> {
  const res = await cartesia.stt.transcribe(new Blob([audio]), {
    model: config.sttModel,
    language: config.language,
  });
  return res.text ?? "";
}

/**
 * Synthesize one whole phrase to base64 PCM. Used by the filler-generation script
 * (scripts/gen-fillers.ts) to bake the latency-masking clips into a static asset.
 */
export async function synthesizeOnce(transcript: string): Promise<string> {
  const stream = await cartesia.tts.bytes({
    modelId: config.ttsModel,
    voice: { mode: "id", id: config.voiceId },
    transcript,
    outputFormat: OUTPUT_FORMAT,
  });
  return (await readableToBuffer(stream)).toString("base64");
}

/**
 * Stream LLM text deltas INTO Sonic and emit base64 PCM audio chunks as they return.
 * Uses a single TTS websocket context with continuations: every delta is sent with
 * `continue: true`, then a final empty send with `continue: false` flushes the tail.
 */
export async function streamTts(
  textDeltas: AsyncIterable<string>,
  // Receives base64-encoded audio in whatever `outputFormat` requested
  // (PCM s16le for the browser, μ-law for telephony).
  onAudioChunk: (audioBase64: string) => void,
  // Aborts on barge-in: drop the socket and unblock `finished` so the turn tears down at once.
  signal?: AbortSignal,
  outputFormat: TtsOutputFormat = PCM16K,
): Promise<void> {
  const ws = cartesia.tts.websocket(outputFormat);
  await ws.connect();
  const contextId = randomUUID();

  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const onAbort = () => {
    try {
      ws.disconnect();
    } catch {
      /* already closed */
    }
    resolveDone();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  let attached = false;
  const attach = (response: Awaited<ReturnType<typeof ws.send>>) => {
    response.on("message", (raw) => {
      const msg = JSON.parse(raw) as { type?: string; data?: string; error?: string };
      if (msg.type === "chunk" && msg.data) onAudioChunk(msg.data); // base64 PCM
      else if (msg.type === "done") resolveDone();
      else if (msg.type === "error") rejectDone(new Error(msg.error ?? "tts error"));
    });
  };

  const sendChunk = async (transcript: string, isFinal: boolean) => {
    const response = await ws.send({
      modelId: config.ttsModel,
      voice: { mode: "id", id: config.voiceId },
      transcript,
      contextId,
      continue: !isFinal,
    });
    if (!attached) {
      attached = true;
      attach(response);
    }
  };

  try {
    for await (const delta of textDeltas) {
      if (signal?.aborted) return;
      if (delta.trim()) await sendChunk(delta, false);
    }
    if (signal?.aborted) return;
    await sendChunk("", true); // flush the final context
    if (!attached) return; // nothing was ever spoken
    await finished;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    ws.disconnect();
  }
}
