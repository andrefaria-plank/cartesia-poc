/**
 * NOA on a phone line — Twilio Media Streams bridge.
 *
 * Why a standalone server (not the Next.js/Vercel app): Twilio Media Streams is a
 * persistent bidirectional WebSocket for the life of the call, which Vercel's
 * stateless functions cannot host. This long-lived Node process can — and one
 * WebSocket connection IS one call, so per-call state lives safely in the closure.
 *
 * It reuses the exact same brain and voice as the browser app:
 *   transcribe() / streamTts()  → lib/cartesia   (STT Ink, TTS Sonic)
 *   runAgent()                  → lib/agent      (Claude + mock back-office tools)
 *
 * Flow per call:
 *   POST /incoming-call → TwiML <Connect><Stream wss://…/media>
 *   ws "start"  → greet the caller
 *   ws "media"  → decode μ-law → server VAD; on end-of-utterance run a turn:
 *                 upsample→WAV→STT → runAgent → Sonic(μ-law 8k) → outbound media
 *   ws "mark"   → playback finished → resume listening
 *   ws "stop"   → hang up: abort in-flight turn, tear down
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { config } from "../lib/config";
import { transcribe, streamTts, MULAW8K } from "../lib/cartesia";
import { runAgent } from "../lib/agent";
import { connectStreamTwiml } from "./telephony/twiml";
import { Endpointer } from "./telephony/vad";
import { mulawToPcm16, upsample8kTo16k, pcm16ToWav } from "./telephony/audio";

const PORT = Number(process.env.PORT) || 8080;
const GREETING = "Hi, this is NOA from your home care team. How can I help you today?";

const server = http.createServer((req, res) => {
  // Twilio Voice webhook: answer the call by opening a Media Stream back to us.
  if (req.method === "POST" && req.url?.startsWith("/incoming-call")) {
    req.resume(); // drain the form body we don't need
    const host = req.headers.host;
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(connectStreamTwiml(`wss://${host}/media`));
    return;
  }
  if (req.url?.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/media" });
wss.on("connection", (ws) => handleCall(ws));

server.listen(PORT, () => console.log(`[phone] listening on :${PORT}`));

function handleCall(ws: WebSocket): void {
  let streamSid = "";
  let history: MessageParam[] = [];
  let speaking = false; // true while NOA talks (no barge-in: ignore inbound audio then)
  let pendingMark: string | null = null;
  let markSeq = 0;
  let turn: AbortController | null = null;

  const endpointer = new Endpointer(
    {
      sampleRate: config.telephony.sampleRate,
      speechRms: config.telephony.speechRms,
      silenceHoldMs: config.telephony.silenceHoldMs,
      minUtteranceMs: config.telephony.minUtteranceMs,
    },
    (pcm) => void runTurn(pcm),
  );

  const sendAudio = (payloadBase64: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: payloadBase64 } }));
    }
  };

  // End NOA's turn: a mark flushes after the queued audio, and Twilio echoes it back
  // when playback actually finishes — only then do we re-open the mic.
  const endSpeaking = () => {
    const name = `m${++markSeq}`;
    pendingMark = name;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name } }));
    }
  };

  const resumeListening = () => {
    speaking = false;
    pendingMark = null;
    endpointer.reset();
  };

  const speak = async (text: AsyncIterable<string>, signal?: AbortSignal) => {
    speaking = true;
    endpointer.reset();
    await streamTts(text, sendAudio, signal, MULAW8K);
  };

  async function greet(): Promise<void> {
    try {
      await speak(oneShot(GREETING));
      endSpeaking();
    } catch (err) {
      console.error("[call] greeting failed:", err);
      resumeListening();
    }
  }

  async function runTurn(pcm8k: Int16Array): Promise<void> {
    speaking = true; // gate inbound frames synchronously before any await
    endpointer.reset();
    turn?.abort();
    const controller = new AbortController();
    turn = controller;
    const signal = controller.signal;

    try {
      const wav = pcm16ToWav(upsample8kTo16k(pcm8k), config.telephony.sttSampleRate);
      const userText = (await transcribe(wav)).trim();
      if (signal.aborted) return;
      if (!userText) {
        resumeListening();
        return;
      }
      console.log("[call] caller:", userText);

      const textStream = (async function* () {
        for await (const ev of runAgent(history, userText, signal)) {
          if (signal.aborted) return;
          if (ev.kind === "text") yield ev.delta;
          else if (ev.kind === "card") console.log("[call] tool:", JSON.stringify(ev.card));
          else history = ev.messages; // terminal history event — commit
        }
      })();

      await speak(textStream, signal);
      if (signal.aborted) return;
      endSpeaking();
    } catch (err) {
      if (!signal.aborted) {
        console.error("[call] turn error:", err);
        resumeListening();
      }
    }
  }

  ws.on("message", (raw) => {
    let msg: TwilioInbound;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start":
        streamSid = msg.start?.streamSid ?? msg.streamSid ?? "";
        console.log("[call] start", streamSid);
        void greet();
        break;
      case "media":
        if (speaking || !msg.media?.payload) return; // half-duplex: ignore while NOA speaks
        endpointer.push(mulawToPcm16(Buffer.from(msg.media.payload, "base64")));
        break;
      case "mark":
        if (msg.mark?.name && msg.mark.name === pendingMark) resumeListening();
        break;
      case "stop":
        console.log("[call] stop", streamSid);
        turn?.abort();
        ws.close();
        break;
    }
  });

  ws.on("close", () => {
    turn?.abort();
    endpointer.reset();
    console.log("[call] closed", streamSid);
  });
  ws.on("error", (err) => console.error("[call] ws error:", err));
}

async function* oneShot(text: string): AsyncIterable<string> {
  yield text;
}

interface TwilioInbound {
  event: "connected" | "start" | "media" | "mark" | "stop" | "dtmf";
  streamSid?: string;
  start?: { streamSid?: string; callSid?: string };
  media?: { track?: string; payload?: string };
  mark?: { name?: string };
}
