import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// ── Verify these against docs.cartesia.ai + your installed @cartesia/cartesia-js version ──
// Model IDs and the STT model name are the things most likely to drift between SDK versions.
export const config = {
  cartesiaApiKey: required("CARTESIA_API_KEY"),
  voiceId: required("NOA_VOICE_ID"),
  port: Number(process.env.PORT ?? 3000),

  ttsModel: "sonic-3.5",
  sttModel: "ink-whisper", // Ink STT model id used by the SDK
  language: "en",

  // Raw PCM s16le so the browser can schedule chunks directly in Web Audio.
  sampleRate: 16000,

  // Spec: 5 minutes of silence ends the voice session.
  silenceTimeoutMs: 5 * 60_000,
} as const;
