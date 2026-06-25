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
import { validTwilioSignature, mintWsToken, validWsToken } from "./telephony/twilioAuth";
import { Endpointer } from "./telephony/vad";
import { mulawToPcm16, upsample8kTo16k, pcm16ToWav } from "./telephony/audio";

const PORT = Number(process.env.PORT) || 8080;
const GREETING = "Hi, this is NOA from your home care team. How can I help you today?";
const AUTH_TOKEN = config.telephony.authToken; // when set, callers must prove they're Twilio

const server = http.createServer((req, res) => {
  // Twilio Voice webhook: verify it's really Twilio, then answer by opening a Media
  // Stream back to us (with a one-time token in the wss URL to gate the socket).
  if (req.method === "POST" && req.url?.startsWith("/incoming-call")) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64_000) req.destroy(); // Twilio webhooks are tiny; bound the read
    });
    req.on("end", () => {
      const host = req.headers.host ?? "";
      if (AUTH_TOKEN) {
        const sig = req.headers["x-twilio-signature"];
        const params = Object.fromEntries(new URLSearchParams(body));
        // Twilio signs the exact public HTTPS URL it was configured to call.
        const ok =
          typeof sig === "string" &&
          validTwilioSignature(AUTH_TOKEN, sig, `https://${host}${req.url}`, params);
        if (!ok) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("invalid Twilio signature");
          return;
        }
      }
      const wssUrl = AUTH_TOKEN
        ? `wss://${host}/media?token=${mintWsToken(AUTH_TOKEN)}`
        : `wss://${host}/media`;
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(connectStreamTwiml(wssUrl));
    });
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

// Gate the Media Streams upgrade: correct path + (when secured) a valid one-time token.
const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }, cb) => {
    const { pathname, searchParams } = new URL(req.url ?? "", `http://${req.headers.host}`);
    if (pathname !== "/media") return cb(false, 404, "Not Found");
    if (AUTH_TOKEN && !validWsToken(AUTH_TOKEN, searchParams.get("token"))) {
      return cb(false, 403, "Forbidden");
    }
    cb(true);
  },
});
wss.on("connection", (ws) => handleCall(ws));

server.listen(PORT, () => {
  console.log(`[phone] listening on :${PORT}`);
  if (!AUTH_TOKEN) {
    console.warn(
      "[phone] TWILIO_AUTH_TOKEN unset — /incoming-call and /media are UNAUTHENTICATED (dev only)",
    );
  }
});

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
