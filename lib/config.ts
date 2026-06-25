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
  // Lazy getters: only the Next.js web entrypoint (middleware/login) uses these, so
  // they're required on first access rather than at import — that lets the telephony
  // server (server/phone.ts) import config without setting auth secrets it never reads.
  get authUsername() {
    return required("AUTH_USERNAME");
  },
  get authPassword() {
    return required("AUTH_PASSWORD");
  },
  // Signs the session cookie. Any long random string; rotating it logs everyone out.
  get sessionSecret() {
    return required("SESSION_SECRET");
  },
  sessionTtlMs: 12 * 60 * 60_000, // 12h

  agentModel: "claude-sonnet-4-6", // NOA's reasoning brain
  ttsModel: "sonic-3.5",
  sttModel: "ink-whisper", // Ink STT model id used by the SDK
  language: "en",

  // Raw PCM s16le so the browser can schedule chunks directly in Web Audio.
  sampleRate: 16000,

  // ── Telephony (Twilio Media Streams) ──
  // Twilio sends/expects 8-bit μ-law mono @ 8 kHz. There is no browser VAD on a
  // phone call, so the server endpoints utterances itself: detect speech by frame
  // energy, then fire end-of-turn after a hold of trailing silence.
  telephony: {
    sampleRate: 8000, // μ-law inbound + outbound
    // Server-side VAD, tuned higher/longer than the browser (public/app.js) because
    // phone audio is noisier and older-adult callers pause mid-sentence.
    speechRms: 0.02, // frame RMS above this counts as speech
    silenceHoldMs: 900, // trailing silence that ends an utterance
    minUtteranceMs: 300, // ignore sub-blips (coughs, line noise)
    sttSampleRate: 16000, // upsample target for Ink STT
  },
} as const;
