/**
 * Audio bridging between Twilio Media Streams (8-bit μ-law @ 8 kHz) and Cartesia.
 *
 * - Inbound:  μ-law 8k  → PCM s16le → (upsample 16k) → WAV → Cartesia Ink STT.
 * - Outbound: Cartesia Sonic is asked for μ-law 8k directly (see lib/cartesia MULAW8K),
 *   so it flows straight to Twilio with no encoding work here.
 *
 * Pure JS standard G.711 μ-law — no native deps, so the Fly container stays slim.
 */

// Standard G.711 μ-law bias. Decoding with this yields the full 16-bit linear range
// (±32124), so Ink STT receives full-amplitude audio. (An earlier 13-bit variant
// decoded at ¼ scale / −12 dB, needlessly quietening already-noisy phone audio.)
const MULAW_BIAS = 0x84; // 132

/** One μ-law byte → 16-bit linear PCM sample (standard G.711). */
function mulawDecodeSample(uByte: number): number {
  uByte = ~uByte & 0xff;
  const sign = uByte & 0x80;
  const exponent = (uByte & 0x70) >> 4;
  const mantissa = uByte & 0x0f;
  const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return sign ? -magnitude : magnitude;
}

/** Decode a μ-law buffer (one byte per sample) to Int16 PCM. */
export function mulawToPcm16(mulaw: Buffer): Int16Array {
  const pcm = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) pcm[i] = mulawDecodeSample(mulaw[i]);
  return pcm;
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
