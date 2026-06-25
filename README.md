# NOA Voice Mode — Cartesia test

Turn-based voice agent: **Ink (STT) → NOA agent (Claude) → Sonic (TTS)**.
Built on **Next.js** so it deploys to Vercel: each turn is **one streaming
request** — the client POSTs the recorded utterance and gets the whole turn
streamed back (transcript → text → cards → audio → `done`). The server is
**stateless**; conversation history is held by the client and sent each turn.

No barge-in (per spec): the client finishes speaking before the mic re-arms.

## Setup

```bash
pnpm install
cp .env.example .env   # fill in Cartesia/voice/Anthropic keys + AUTH_USERNAME/AUTH_PASSWORD/SESSION_SECRET
pnpm gen:fillers       # one-time: bake the latency-masking filler clips → public/fillers.json
pnpm dev
```

Open http://localhost:3000 → sign in (`AUTH_USERNAME` / `AUTH_PASSWORD`) →
**Start voice mode** → tap the wave and talk.

> **pnpm only.** A `preinstall` guard enforces it (matches `main`).

## Login gate

A Next.js **proxy/middleware** (`middleware.ts`) gates the voice client and
`/api/voice` behind a session cookie. `/login` posts to `/api/auth/login`, which
checks credentials against `.env` and issues an HMAC-signed httpOnly cookie
(`lib/auth.ts`, Web Crypto so it runs in both Edge middleware and Node routes).
Public paths: `/login`, `/_next/*`, `/api/auth/*`, `/favicon.ico`.

## Layout

| File | Role |
|------|------|
| `lib/config.ts`   | Env + model IDs (`sonic-3.5`, `ink-whisper`), sample rate |
| `lib/cartesia.ts` | Ink `transcribe`, `synthesizeOnce` (fillers), streaming `streamTts` |
| `lib/agent.ts`    | NOA agent — real Claude + mock tools; stateless, `text`/`card`/`history` events |
| `lib/tools.ts`    | Mock back-office tools (client, invoices, visits, deliveries, payments) |
| `app/api/voice/route.ts` | The streaming turn: STT → agent → Sonic, SSE-formatted response |
| `scripts/gen-fillers.ts` | One-time filler synthesis → `public/fillers.json` |
| `next.config.js`  | Rewrites `/` → the static client (`public/index.html`) |
| `public/index.html` | Browser client shell: landing + full-screen voice stage |
| `public/styles.css` | Visual system ("Indigo Clinical"): OKLCH tokens, light/dark, components |
| `public/app.js`   | Client engine: fetch-streamed turn + gapless Web Audio + VAD mic + live spectrum waveform + phase machine + tool cards + client-held history |

## Turn protocol — `POST /api/voice`

Request: multipart `{ audio: Blob, history: JSON }`. Response: a single
streamed body in **SSE wire format** (`event:`/`data:` lines):

| event | data | meaning |
|-------|------|---------|
| `transcript` | `{ text }`         | user STT result |
| `text`       | `{ delta }`        | streamed agent text |
| `card`       | `{ card }`         | visual tool-result card (+ chime) |
| `audio`      | `{ audio }`        | base64 PCM chunk (in order) |
| `done`       | `{ history }`      | turn end → new history; drain queue, re-arm mic |
| `turn_error` | `{ message }`      | failure → surface + re-arm |

Audio is raw `pcm_s16le` @ 16 kHz, base64 in each `data:` field, scheduled
sequentially in the browser's `AudioContext` for gapless playback. Fillers play
**client-side** from `public/fillers.json` (no round-trip).

## Deploy (Vercel)

```bash
vercel link
vercel env add CARTESIA_API_KEY      # + NOA_VOICE_ID, ANTHROPIC_API_KEY
vercel deploy            # preview
vercel deploy --prod     # production
```

The `/api/voice` route runs on the Node.js runtime (`maxDuration` 60s) — a turn
is bounded by the 30s client-side recording cap.

## Benchmark STT/TTS speed

```bash
npm run bench          # 5 runs per phrase
npm run bench -- 10    # 10 runs per phrase
```

Synthesizes known phrases with Sonic, feeds the audio back into Ink, and reports
min/avg/p50/p95/max for:
- **TTS batch total** + **real-time factor** (RTF > 1× = generated faster than it plays)
- **TTS stream first-audio (TTFA)** + stream total
- **STT transcribe** time + a rough **WER** (on synthetic speech — validate real
  older-adult audio separately)

The route logs a per-turn breakdown: `[turn] {stt_ms, tts_ttfa_ms, total_ms}`.

## Verify before production

- **Model IDs / SDK method names** in `lib/cartesia.ts` and `lib/config.ts` are
  version-sensitive (Ink STT is `ink-whisper` in the current SDK; Sonic is `sonic-3.5`).
  Code typechecks against `@cartesia/cartesia-js` ^2.2.9 — re-verify if you bump it.
- **Benchmark Ink on real older-adult speech** — STT accuracy is the highest-stakes
  quality bar. STT/TTS are decoupled; swapping STT is a one-function change.
- **History is client-held** (sent each turn): simple and stateless, but lost on
  reload. Move to Vercel KV / Upstash keyed by a session id if you need persistence.

## Phone line (PSTN via Twilio)

NOA is also reachable on a **regular phone number** through Twilio Media Streams.
This can't run on Vercel — Media Streams is a persistent WebSocket for the life of
the call — so it's a standalone Node server in `server/phone.ts`, deployed to Fly.io,
that **reuses the same `lib/` brain and voice** (`transcribe` / `runAgent` / `streamTts`).

```
Caller → Twilio number → POST /incoming-call → TwiML <Connect><Stream wss://…/media>
       → WS bridge: μ-law 8k in → server VAD → STT → runAgent → Sonic (μ-law 8k) → caller
```

- **STT/TTS:** Cartesia, same as the browser (ConversationRelay can't use Cartesia, so
  we use raw Media Streams). Audio bridging (μ-law 8k ↔ PCM/WAV) lives in
  `server/telephony/audio.ts`; Sonic is asked for μ-law 8k directly.
- **Turn-taking:** no browser VAD on a phone, so the server endpoints utterances by
  energy + trailing silence (`server/telephony/vad.ts`, tuned in `lib/config.ts`).
- **Run locally:** `pnpm phone:dev`, expose with a tunnel (`cloudflared`/`ngrok`), then
  point a Twilio number's Voice webhook at `https://<tunnel>/incoming-call` and call it.
- **Deploy:** `fly launch --no-deploy` → `fly secrets set CARTESIA_API_KEY=… NOA_VOICE_ID=… ANTHROPIC_API_KEY=…` → `fly deploy`, then set the Twilio webhook to `https://<app>.fly.dev/incoming-call`.
- **POC scope:** no phone barge-in, no caller auth, history lost on hangup — see below.

## Next steps

- Buffer agent text to clause/punctuation boundaries before sending to Sonic
  (currently token-by-token) for smoother prosody and fewer TTS round-trips.
- Persist history server-side (Vercel KV) if reload-survival matters.
- Benchmark Ink on real older-adult audio before launch.
- **Phone:** add barge-in (Twilio `clear` + server VAD while speaking), validate
  Cartesia μ-law support on SDK bumps, and tune the server-VAD silence hold for
  older-adult callers; consider caller allow-listing / `X-Twilio-Signature` checks.
