/**
 * Server-side endpointing for phone calls. A phone has no browser VAD, so we decide
 * when the caller has finished an utterance from frame energy alone: once speech has
 * started, a run of trailing silence longer than `silenceHoldMs` ends the turn.
 *
 * Frames arrive at a steady ~20 ms cadence from Twilio, so silence is accounted in
 * frame-duration rather than wall-clock — robust and clock-free.
 */
import { frameRms } from "./audio";

export interface EndpointerOptions {
  sampleRate: number;
  speechRms: number;
  silenceHoldMs: number;
  minUtteranceMs: number;
}

export class Endpointer {
  private speaking = false;
  private silenceMs = 0;
  private voicedMs = 0;
  private chunks: Int16Array[] = [];

  constructor(
    private readonly opts: EndpointerOptions,
    // Fires once with the full utterance PCM (speech + trailing silence) when endpointed.
    private readonly onUtterance: (pcm: Int16Array) => void,
  ) {}

  /** Feed one inbound PCM frame (decoded from a Twilio `media` event). */
  push(frame: Int16Array): void {
    const frameMs = (frame.length / this.opts.sampleRate) * 1000;
    const voiced = frameRms(frame) >= this.opts.speechRms;

    if (voiced) {
      this.speaking = true;
      this.silenceMs = 0;
      this.voicedMs += frameMs;
      this.chunks.push(frame);
      return;
    }

    if (!this.speaking) return; // pre-speech silence — ignore

    // Trailing silence: keep collecting so we don't clip the word's tail.
    this.silenceMs += frameMs;
    this.chunks.push(frame);
    if (this.silenceMs >= this.opts.silenceHoldMs) this.finalize();
  }

  /** Drop any buffered audio without firing (e.g. on hangup or while NOA is speaking). */
  reset(): void {
    this.speaking = false;
    this.silenceMs = 0;
    this.voicedMs = 0;
    this.chunks = [];
  }

  private finalize(): void {
    const voicedMs = this.voicedMs;
    const utterance = concat(this.chunks);
    this.reset();
    if (voicedMs >= this.opts.minUtteranceMs) this.onUtterance(utterance);
  }
}

function concat(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
