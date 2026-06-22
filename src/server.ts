import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { transcribe, streamTts } from "./cartesia.js";
import { runAgent, forgetSession, type AgentEvent } from "./agent.js";
import { warmFillers, randomFiller } from "./filler.js";
import {
  openSession,
  closeSession,
  send,
  nextSeq,
  touch,
  hasSession,
} from "./sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static(path.join(__dirname, "..", "public")));

// (2) Client opens the SSE channel → "Abre SSE e retorna OK".
app.get("/voice/stream/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  openSession(sessionId, res);
  req.on("close", () => {
    closeSession(sessionId);
    forgetSession(sessionId);
  });
});

// (3) Client posts one recorded utterance → "Manda mensagem de voz".
// EventSource can't POST a body, so the upload is a separate request keyed by sessionId;
// all results stream back over that session's SSE channel.
app.post("/voice/message/:sessionId", upload.single("audio"), async (req, res) => {
  const { sessionId } = req.params;
  if (!hasSession(sessionId)) {
    res.status(409).json({ error: "no open SSE session" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "missing audio file" });
    return;
  }
  res.json({ ok: true }); // ack immediately; the turn plays out over SSE
  touch(sessionId);

  try {
    await handleTurn(sessionId, req.file.buffer);
  } catch (err) {
    send(sessionId, "error", { message: (err as Error).message });
  }
});

async function handleTurn(id: string, audio: Buffer): Promise<void> {
  const t0 = performance.now();

  // (4) Instant filler — "Manda áudio template pra resposta rápida".
  const filler = randomFiller();
  if (filler) send(id, "filler", { seq: nextSeq(id), audio: filler });
  const tFiller = performance.now();

  // STT (Ink) — whole utterance.
  const userText = await transcribe(audio);
  const tStt = performance.now();
  send(id, "transcript", { text: userText }); // persisted to chat history client-side

  // Fan the agent stream into: spoken text (-> Sonic) and cards (-> UI + chime).
  const textStream = (async function* (): AsyncIterable<string> {
    for await (const ev of runAgent(id, userText) as AsyncIterable<AgentEvent>) {
      if (ev.kind === "text") {
        send(id, "text", { delta: ev.delta }); // drives transcript UI
        yield ev.delta;
      } else {
        send(id, "card", { card: ev.card }); // client renders + plays chime
      }
    }
  })();

  // (6) Stream agent tokens into Sonic; relay each PCM chunk in order over SSE.
  let tFirstAudio = 0;
  await streamTts(textStream, (pcmBase64) => {
    if (!tFirstAudio) tFirstAudio = performance.now();
    send(id, "audio", { seq: nextSeq(id), audio: pcmBase64 });
  });
  const tEnd = performance.now();

  // (7) Turn complete — client drains its queue, then re-arms the mic (no barge-in).
  send(id, "done", {});
  touch(id);

  // Per-turn latency breakdown (server-side). Pair with client-side perceived latency.
  const ms = (a: number, b: number) => Math.round(b - a);
  console.log(
    "[turn]",
    JSON.stringify({
      filler_ms: ms(t0, tFiller),
      stt_ms: ms(tFiller, tStt),
      tts_ttfa_ms: tFirstAudio ? ms(tStt, tFirstAudio) : null, // text->first audio chunk
      total_ms: ms(t0, tEnd),
    }),
  );
}

app.listen(config.port, async () => {
  await warmFillers();
  console.log(`NOA Voice Mode API listening on http://localhost:${config.port}`);
});
