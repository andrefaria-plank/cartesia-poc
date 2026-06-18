# Cartesia STT/TTS Benchmark Results

**Date:** 2026-06-17
**Command:** `npm run bench -- 10` (10 runs × 3 phrases = 30 samples each)
**Config:** `tts=sonic-3.5` · `stt=ink-whisper` · `sampleRate=16000Hz`
**Method:** phrases synthesized with Sonic, then fed back into Ink — speed measured
both directions; WER is on synthetic speech (sanity check, not a real-user quality test).

## TTS (Sonic)

| Metric | min | avg | p50 | p95 | max | unit |
|---|---|---|---|---|---|---|
| batch total | 652 | 830 | 790 | 1134 | 1304 | ms |
| batch real-time factor | 2.96 | 4.52 | 4.56 | 5.31 | 5.51 | × |
| stream first-audio (TTFA) | 207 | 244 | 242 | 283 | 355 | ms |
| stream total | 641 | 775 | 778 | 843 | 909 | ms |

## STT (Ink)

| Metric | min | avg | p50 | p95 | max | unit |
|---|---|---|---|---|---|---|
| transcribe | 347 | 453 | 395 | 618 | 706 | ms |
| word error rate | 0 | 3 | 0 | 10 | 10 | % |

## Interpretation

- **TTS time-to-first-audio ~242ms p50 (≤355ms max).** Snappy. Note this is from a
  Node server over the public internet, so it includes network RTT — the raw model
  number is lower. Good enough that the filler clip easily covers it.
- **TTS real-time factor ~4.5× (min 2.96×).** Audio is generated ~4–5× faster than it
  plays, with comfortable headroom — no streaming stalls/gaps expected.
- **STT ~395ms p50 (≤706ms max)** for a ~3–4s clip. Fast for batch transcription.
- **WER avg 3%** — but on *clean synthetic speech*, so this only confirms the pipeline
  works. Real older-adult speech will be higher; must be measured separately.

## Estimated perceived turn latency

User stops speaking → first real audio (excluding the filler that masks it):

```
STT (~395ms p50) + agent first token (LLM, not measured here) + TTS TTFA (~242ms p50)
```

≈ **640ms + LLM latency**. With a fast LLM first-token (~300–500ms) the total lands
around **~1.0–1.1s**, inside the "feels natural" (<1.8s) range. The pre-cached filler
plays at ~0ms, so the user perceives an immediate response.

## Caveats

- Run from a single machine/network on `2026-06-17`; absolute numbers vary with
  location, concurrency, and plan tier.
- LLM/agent latency is **not** included — that's the missing piece of end-to-end.
- WER is synthetic. The real quality bar (Ink on older-adult voices) is still untested.
