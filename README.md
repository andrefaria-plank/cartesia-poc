# NOA Voice Mode — Cartesia test

Turn-based voice agent: **Ink (STT) → NOA agent → Sonic (TTS)**, streamed to the
browser over **SSE + base64 audio**. Implements the sequence diagram: open SSE →
send voice message → instant filler → streamed text + audio chunks → `done`.

Supports **barge-in**: the user can cut NOA off mid-reply. Voice mode (hands-free
— the live mic detects you starting to talk) or manual (tap the wave / Interrupt
button). A barge-in cuts local playback, `POST`s `/voice/abort/:sessionId` to stop
the in-flight turn (Claude stream + Sonic socket aborted, agent lock released),
and captures the interrupting utterance as the next turn.

## Setup

```bash
npm install
cp .env.example .env   # fill in CARTESIA_API_KEY and NOA_VOICE_ID
npm run dev
```

Open http://localhost:3000 → **Start voice mode** → **hold to talk**.

## Layout

| File | Role |
|------|------|
| `src/config.ts`   | Env + model IDs (`sonic-3.5`, `ink-whisper`), sample rate, 5-min timeout |
| `src/cartesia.ts` | Ink `transcribe`, filler `synthesizeOnce`, streaming `streamTts` |
| `src/filler.ts`   | Pre-cached "let me think…" clips, synthesized once at boot |
| `src/agent.ts`    | NOA agent stub — yields `text` (spoken) vs `card` (visual) separately |
| `src/sessions.ts` | SSE registry, ordered `seq`, silence timeout |
| `src/server.ts`   | Routes + per-turn orchestration |
| `public/index.html` | Browser client shell: landing + full-screen voice stage |
| `public/styles.css` | Visual system ("Indigo Clinical"): OKLCH tokens, light/dark, components |
| `public/app.js`   | Client engine: SSE + gapless Web Audio + VAD mic + live spectrum waveform + phase machine + tool cards |

## SSE event protocol (server → client)

| event | data | meaning |
|-------|------|---------|
| `ready`      | `{ sessionId }` | SSE open |
| `transcript` | `{ text }`      | user STT result (save to history) |
| `filler`     | `{ seq, audio }`| instant base64 PCM filler |
| `text`       | `{ delta }`     | streamed agent text |
| `card`       | `{ card }`      | visual card (+ chime) |
| `audio`      | `{ seq, audio }`| ordered base64 PCM chunk |
| `done`       | `{}`            | turn end → drain queue, re-arm mic |
| `turn_error` | `{ message }`   | turn failure (client shows it; tap the wave to retry) |

Client → server: `POST /voice/message/:sessionId` (one utterance, supersedes any
in-flight turn) and `POST /voice/abort/:sessionId` (barge-in: abort the in-flight
turn). An aborted turn emits no `done` and is discarded from history.

Audio is raw `pcm_s16le` @ 16 kHz, base64 in the SSE `data:` field, scheduled
sequentially in the browser's `AudioContext` for gapless playback.

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

The live server also logs a per-turn breakdown: `[turn] {filler_ms, stt_ms, tts_ttfa_ms, total_ms}`.

## Verify before production

- **Model IDs / SDK method names** in `src/cartesia.ts` and `src/config.ts` are
  version-sensitive (Ink STT is `ink-whisper` in the current SDK; Sonic is `sonic-3.5`).
  Code typechecks against `@cartesia/cartesia-js` ^2.2.9 — re-verify if you bump it.
- **Benchmark Ink on real older-adult speech** — transcripts are persisted, so STT
  accuracy is the highest-stakes quality bar. STT/TTS are decoupled; swapping STT
  is a one-function change.

## Next steps

- If base64-over-SSE bandwidth bites, move just the `audio` channel to a WebSocket.
- Harden voice barge-in echo rejection (compare the heard transcript to NOA's
  current speech) so it's robust on speakers, not just headphones.
- Defer barge-in teardown while a tool is mid-flight so an interrupt can't strand
  a half-done action (the agent already commits history only on success).
