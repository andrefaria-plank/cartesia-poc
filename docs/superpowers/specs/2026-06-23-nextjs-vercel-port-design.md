# NOA Voice Mode — Next.js / Vercel port

**Date:** 2026-06-23
**Status:** Approved

## Goal

Run NOA Voice Mode on Vercel. The current app is a stateful Express server whose
voice loop spans two HTTP requests sharing in-process memory — incompatible with
Vercel's stateless serverless functions. Port to Next.js with a transport that
fits serverless, with **no loss of functionality** and **minimal UI churn**.

## Why the current design fails on Vercel

1. A turn uses two requests: long-lived `GET /voice/stream/:id` (SSE) and
   `POST /voice/message/:id`. They communicate through in-memory `Map`s
   (`sessions.ts`, `agent.ts`). On serverless these land on different instances
   with no shared memory → every message 409s and `send()` can't reach the SSE
   response. This is fatal and framework-independent.
2. `warmFillers()` runs inside `app.listen()`, which Vercel never calls.
3. Per-turn Cartesia WebSocket + 5-minute SSE assume a persistent process.

## Decisions

- **Frontend:** keep the existing vanilla `public/index.html` + `app.js` +
  `styles.css`. Only the networking changes. Lowest risk.
- **History:** client-held. The browser keeps the Anthropic message array and
  sends it with each turn; the server is fully stateless. No external store.
- **Fillers:** pre-generated once into static assets, played client-side.

## Architecture — one streaming request per turn

```
Client records audio
  → plays a local filler clip instantly (static asset, no round-trip)
  → POST /api/voice   multipart { audio, history(JSON) }
  → route handler streams the whole turn back in ONE response (SSE wire format):
        transcript → text deltas → cards → audio chunks → done{history}
Server holds ZERO cross-request state.
```

The wire format stays SSE (`event:`/`data:` lines) so the event protocol is
unchanged; the client reads bytes from a `fetch()` `ReadableStream` instead of
`EventSource` (which cannot POST). A turn is bounded (recording capped at 30s
client-side), within a Fluid Compute function `maxDuration`.

## Project structure

```
app/api/voice/route.ts   POST turn orchestration (was server.ts handleTurn)
                         exports: runtime='nodejs', dynamic='force-dynamic', maxDuration=60
lib/cartesia.ts          transcribe + streamTts (unchanged logic)
lib/agent.ts             runAgent(history, userText) → async-iterable of events,
                         emits a final {kind:'history'} on success. PURE/stateless.
lib/tools.ts             unchanged
lib/config.ts            env + model ids (drop port + silenceTimeout)
public/index.html        unchanged
public/styles.css        unchanged
public/app.js            transport rewired: EventSource → fetch streaming; client
                         holds history; client-side filler; SSE-line parser
public/fillers.json      array of base64 PCM filler clips (pre-generated)
scripts/gen-fillers.ts   one-time: synth filler phrases → public/fillers.json
next.config.js           rewrite "/" → "/index.html" so the vanilla UI serves at root
```

## Component contracts

- **`runAgent(history, userText)`** — async generator. Yields
  `{kind:'text',delta}` and `{kind:'card',card}` as today; on a fully successful
  turn yields a terminal `{kind:'history',messages}` carrying the new committed
  history. No module-level `histories`/`inFlight` Maps — one request is one turn,
  so the concurrency lock is structural.
- **`POST /api/voice`** — parses `formData()` (audio Blob + history JSON), runs
  STT → agent fan-out → Sonic, streaming SSE events; ends with
  `done{history}`. On any throw, emits `turn_error{message}` then closes.
- **Client** — keeps `history`; on `done` replaces it with `data.history`. Plays
  a random local filler on mic-stop. Parses the streamed SSE manually.

## Removed

- `express`, `multer` dependencies; `src/server.ts`, `src/sessions.ts`.
- The `seq` field (single ordered stream → arrival order suffices).
- Server-side filler synthesis at boot.

## Error handling

`turn_error` (distinct from transport errors) surfaces a message and drops the
UI to a tappable idle state; no `done` follows, so the client recovers there.
Carries over the fix from PR #2.

## Testing / verification

- `next build` compiles.
- Local `next dev`: full turn works end-to-end (transcript, spoken reply, cards,
  re-arm), filler plays instantly, multi-turn history persists across turns.
- Deploy preview to Vercel; smoke-test a live turn.

## Env vars (Vercel project)

`CARTESIA_API_KEY`, `NOA_VOICE_ID`, `ANTHROPIC_API_KEY`. No `PORT`.
