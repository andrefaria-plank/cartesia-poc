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
  anthropicApiKey: required("ANTHROPIC_API_KEY"),

  // ── Login gate (ported from main) ──
  authUsername: required("AUTH_USERNAME"),
  authPassword: required("AUTH_PASSWORD"),
  // Signs the session cookie. Any long random string; rotating it logs everyone out.
  sessionSecret: required("SESSION_SECRET"),
  sessionTtlMs: 12 * 60 * 60_000, // 12h

  agentModel: "claude-sonnet-4-6", // NOA's reasoning brain
  ttsModel: "sonic-3.5",
  sttModel: "ink-whisper", // Ink STT model id used by the SDK
  language: "en",

  // Raw PCM s16le so the browser can schedule chunks directly in Web Audio.
  sampleRate: 16000,
} as const;
