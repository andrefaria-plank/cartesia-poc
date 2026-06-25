/**
 * Audio bridging between Twilio Media Streams (8-bit μ-law @ 8 kHz) and Cartesia.
 *
 * - Inbound:  μ-law 8k  → PCM s16le → (upsample 16k) → WAV → Cartesia Ink STT.
 * - Outbound: Cartesia Sonic is asked for μ-law 8k directly (see lib/cartesia MULAW8K),
 *   so it flows straight to Twilio with no work here. The PCM→μ-law encoder below is
 *   the fallback for if/when Sonic μ-law output is unavailable.
 *
 * Pure JS (G.711, MULAW_BIAS=33) — no native deps, so the Fly container stays slim.
 */

const MULAW_BIAS = 33;
const MULAW_MAX = 0x1fff;

/** One μ-law byte → 16-bit linear PCM sample. */
function mulawDecodeSample(uByte: number): number {
  uByte = ~uByte & 0xff;
  const sign = uByte & 0x80;
  const exponent = ((uByte & 0x70) >> 4) + 5;
  const decoded =
    ((1 << exponent) | ((uByte & 0x0f) << (exponent - 4)) | (1 << (exponent - 5))) - MULAW_BIAS;
  return sign ? -decoded : decoded;
}

/** One 16-bit linear PCM sample → μ-law byte. */
function mulawEncodeSample(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sample = -sample;
    sign = 0x80;
  }
  sample += MULAW_BIAS;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  let position = 12;
  for (; position >= 5; position--) {
    if (sample & (1 << position)) break;
  }
  const lsb = (sample >> (position - 4)) & 0x0f;
  return ~(sign | ((position - 5) << 4) | lsb) & 0xff;
}

/** Decode a μ-law buffer (one byte per sample) to Int16 PCM. */
export function mulawToPcm16(mulaw: Buffer): Int16Array {
  const pcm = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) pcm[i] = mulawDecodeSample(mulaw[i]);
  return pcm;
}

/** Encode Int16 PCM to a μ-law buffer (one byte per sample). */
export function pcm16ToMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = mulawEncodeSample(pcm[i]);
  return out;
}

/** Upsample 8 kHz → 16 kHz by linear interpolation (2× rate). */
export function upsample8kTo16k(pcm: Int16Array): Int16Array {
  const out = new Int16Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const cur = pcm[i];
    const next = i + 1 < pcm.length ? pcm[i + 1] : cur;
    out[2 * i] = cur;
    out[2 * i + 1] = (cur + next) >> 1;
  }
  return out;
}

/** Wrap Int16 PCM (mono, little-endian) in a 44-byte WAV header for the STT API. */
export function pcm16ToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

/** Normalised RMS energy (0..1) of a PCM frame — used for server-side VAD. */
export function frameRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length) / 32768;
}
