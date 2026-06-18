# Why Cartesia for NOA Voice Mode

A short case for using **Cartesia** (Sonic TTS + Ink STT) as the speech layer for
NOA's Voice Mode — and for real-time voice agents in general. Backed by the
measurements in [`BENCHMARK.md`](./BENCHMARK.md).

---

## 1. What Cartesia gives you

Cartesia is a **real-time voice infrastructure** company built on **State Space
Models** (the Mamba architecture) rather than transformers. For voice that means
linear-time, streaming-friendly inference → low latency and efficient scaling.

You consume two of the three legs of a voice agent:

| Product | Role | Used here as |
|---|---|---|
| **Sonic** (TTS) | fast, lifelike speech | NOA's single defined voice |
| **Ink** (STT) | streaming transcription | user-turn → text (persisted to history) |
| **Line** | full voice-agent framework | _not used — we orchestrate our own NOA agent_ |

The LLM ("NOA") stays yours. STT and TTS are **decoupled**, so either can be
swapped with a one-function change.

---

## 2. Why it fits *this* project specifically

The Voice Mode spec deliberately removes the hardest parts of real-time voice —
which is exactly what plays to Cartesia's strengths:

| Spec requirement | Why Cartesia fits |
|---|---|
| **No barge-in** (system finishes before listening) | Half-duplex turn loop — no full-duplex/echo-cancel complexity needed |
| **Single defined female voice** | One Sonic voice ID; no need for a huge voice marketplace (ElevenLabs' main edge becomes irrelevant) |
| **"Effortless for older adults"** | Sonic's natural pacing + low latency = responsive, warm, intelligible |
| **Instant "filler" audio for fast response** | Sonic synthesizes fillers once, cached; first-audio so fast the filler easily masks the rest |
| **Transcripts saved to chat history** | Ink batch transcription is accurate on clean audio and fast (~395ms p50) |
| **No complex noise handling required** | Matches Cartesia's scope — speech in/out, not audio cleanup |
| **On-prem / data-residency option** (older-adult, possibly health data) | Cartesia supports cloud, on-prem, and on-device deployment |

In short: this is the *easy, latency-sensitive* shape of voice agent, and that is
precisely where Cartesia is strongest.

---

## 3. The measured case (from our own benchmark)

Run on `2026-06-17`, 30 samples each, from a Node server over the public internet:

| What | Result | Why it matters |
|---|---|---|
| **TTS first-audio (TTFA)** | **~242ms p50** (≤355ms) | Snappy replies; filler covers it trivially |
| **TTS real-time factor** | **~4.5×** (min 2.96×) | Generated 4–5× faster than it plays → **no streaming stalls** |
| **STT transcribe** | **~395ms p50** (≤706ms) | Fast turn-around on a 3–4s utterance |
| **Estimated perceived latency** | **~640ms + LLM** ≈ **~1.0–1.1s** | Inside the "feels natural" (<1.8s) band |

These are real numbers from this repo, not marketing claims — reproducible with
`npm run bench`.

---

## 4. Why Cartesia over the alternatives (for this use case)

- **vs ElevenLabs** — ElevenLabs wins on voice *library* breadth, which we don't
  need (one voice). Cartesia wins on **latency** and **STT+TTS in one vendor**.
- **vs OpenAI TTS/Realtime** — comparable quality, but Cartesia's TTFA and
  real-time-factor headroom suit a streaming turn loop, plus **on-prem** options
  for sensitive data.
- **vs Deepgram/Whisper (STT only)** — strong STT, but you'd still need a separate
  TTS vendor; Cartesia keeps both behind one SDK/key. (Still worth A/B-ing Ink on
  real elderly speech — see caveats.)

---

## 5. Developer experience benefits

- **One SDK / one key** for STT + TTS (`@cartesia/cartesia-js`).
- **Streaming-native**: pipe LLM tokens into Sonic via websocket continuations →
  audio starts before the model finishes the sentence.
- **Typed SDK** that this project **typechecks and builds against** (`^2.2.9`).
- **Free tier** to start; sign up with any email (incl. university).
- **Decoupled design**: swapping STT or TTS later is a single function change.

---

## 6. Honest caveats (don't skip these)

- **WER is unproven on the real population.** Our 3% WER is on *synthetic* speech.
  The highest-stakes quality bar — Ink's accuracy on **older-adult voices** — still
  needs a real-audio test before production.
- **LLM/agent latency is not included** in the numbers above; it's the missing
  piece of true end-to-end and depends on your model choice.
- **Model IDs / SDK surface drift** between versions — pin and re-verify on upgrade.
- **base64-over-SSE** adds ~33% to audio payloads; fine at this scale, but move the
  audio leg to a WebSocket if bandwidth ever bites.

---

## Bottom line

For a **turn-based, single-voice, latency-sensitive** voice experience aimed at
older adults, Cartesia is a strong, measured fit: fast first-audio, no playback
stalls, accurate fast STT, both legs behind one typed SDK, and on-prem options for
sensitive data. The one open risk — STT accuracy on real elderly speech — is
cheap to de-risk and easy to swap out if it falls short.
