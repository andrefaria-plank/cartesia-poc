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
  onAudioChunk: (pcmBase64: string) => void,
): Promise<void> {
  const ws = cartesia.tts.websocket({
    container: "raw",
    encoding: "pcm_s16le",
    sampleRate: config.sampleRate,
  });
  await ws.connect();
  const contextId = randomUUID();

  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

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
      if (delta.trim()) await sendChunk(delta, false);
    }
    await sendChunk("", true); // flush the final context
    if (!attached) return; // nothing was ever spoken
    await finished;
  } finally {
    ws.disconnect();
  }
}
