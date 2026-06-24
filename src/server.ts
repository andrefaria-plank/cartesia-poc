import express, { type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import { config } from "./config.js";
import { transcribe, streamTts } from "./cartesia.js";
import { runAgent, forgetSession, type AgentEvent } from "./agent.js";
import { warmFillers, randomFiller } from "./filler.js";
import {
  COOKIE_NAME,
  checkCredentials,
  issueToken,
  verifyToken,
  readCookie,
} from "./auth.js";
import {
  openSession,
  closeSession,
  send,
  nextSeq,
  touch,
  hasSession,
} from "./sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dev = process.env.NODE_ENV !== "production";
const nextApp = next({ dev, dir: path.join(__dirname, "..") });
const handleNext = nextApp.getRequestHandler();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// ── Auth gate ──────────────────────────────────────────────────────────────
// Reachable without a session: login page, its asset bundle, the login API.
// Everything else (voice client + SSE/upload API) requires a valid cookie.
function isPublicPath(p: string): boolean {
  return (
    p === "/login" ||
    p.startsWith("/_next/") ||
    p.startsWith("/api/auth/") ||
    p === "/favicon.ico"
  );
}

// Login: compare creds to .env, set an httpOnly signed cookie on success.
app.post("/api/auth/login", express.json(), (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password required" });
    return;
  }
  if (!checkCredentials(username, password)) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  res.cookie(COOKIE_NAME, issueToken(username), {
    httpOnly: true,
    sameSite: "lax",
    secure: !dev,
    maxAge: config.sessionTtlMs,
    path: "/",
  });
  res.json({ ok: true });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

app.use((req: Request, res: Response, nextFn: NextFunction) => {
  if (isPublicPath(req.path)) return nextFn();
  if (verifyToken(readCookie(req.headers.cookie, COOKIE_NAME))) return nextFn();
  // API callers get a clean 401; page navigations get bounced to /login.
  if (req.path.startsWith("/voice/") || req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return res.redirect("/login");
});

app.use(express.static(path.join(__dirname, "..", "public")));

// Active turn per session, so a barge-in can abort the one in flight: aborting
// stops the Claude stream + Sonic socket and releases the agent's per-session
// lock, clearing the way for the interrupting utterance to start a fresh turn.
const turns = new Map<string, { ac: AbortController; done: Promise<void> }>();

/** Abort the in-flight turn (if any) and wait for it to fully unwind. */
async function supersede(id: string): Promise<void> {
  const t = turns.get(id);
  if (!t) return;
  t.ac.abort();
  try {
    await t.done;
  } catch {
    /* aborted turns settle without surfacing here */
  }
}

// (2) Client opens the SSE channel → "Abre SSE e retorna OK".
app.get("/voice/stream/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  openSession(sessionId, res);
  req.on("close", () => {
    turns.get(sessionId)?.ac.abort();
    turns.delete(sessionId);
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

  // Barge-in safety: stop any turn already running for this session before
  // starting this one, so they can't overlap on the shared history.
  await supersede(sessionId);

  const ac = new AbortController();
  const done = handleTurn(sessionId, req.file.buffer, ac.signal).catch(
    (err) => {
      if (!ac.signal.aborted) {
        // Named `turn_error`, not `error`: EventSource delivers a plain `error`
        // event to the same handler as transport failures, so a turn error sent
        // that way is silently swallowed client-side.
        send(sessionId, "turn_error", { message: (err as Error).message });
      }
    },
  );
  turns.set(sessionId, { ac, done });
  await done;
  if (turns.get(sessionId)?.ac === ac) turns.delete(sessionId);
});

// Barge-in: silence the in-flight turn at once (cut Claude + Sonic). The client
// also stops local playback and opens the mic to capture the interrupting words.
app.post("/voice/abort/:sessionId", (req, res) => {
  turns.get(req.params.sessionId)?.ac.abort();
  res.json({ ok: true });
});

async function handleTurn(
  id: string,
  audio: Buffer,
  signal: AbortSignal,
): Promise<void> {
  const t0 = performance.now();

  // (4) Instant filler — "Manda áudio template pra resposta rápida".
  const filler = randomFiller();
  if (filler) send(id, "filler", { seq: nextSeq(id), audio: filler });
  const tFiller = performance.now();

  // STT (Ink) — whole utterance.
  const userText = await transcribe(audio, signal);
  if (signal.aborted) return;
  const tStt = performance.now();
  send(id, "transcript", { text: userText }); // persisted to chat history client-side

  // Fan the agent stream into: spoken text (-> Sonic) and cards (-> UI + chime).
  const textStream = (async function* (): AsyncIterable<string> {
    for await (const ev of runAgent(id, userText, signal) as AsyncIterable<AgentEvent>) {
      if (signal.aborted) return;
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
  await streamTts(
    textStream,
    (pcmBase64) => {
      if (signal.aborted) return;
      if (!tFirstAudio) tFirstAudio = performance.now();
      send(id, "audio", { seq: nextSeq(id), audio: pcmBase64 });
    },
    signal,
  );
  // Interrupted turns stop silently — the client already moved on, so a `done`
  // here would wrongly re-arm it against the (superseding) new turn.
  if (signal.aborted) return;
  const tEnd = performance.now();

  // (7) Turn complete — client drains its queue, then re-arms the mic.
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

// Everything not handled above (the /login page + its assets) → Next.js.
app.all("*", (req, res) => handleNext(req, res));

async function bootstrap() {
  await nextApp.prepare();
  app.listen(config.port, async () => {
    await warmFillers();
    console.log(`NOA Voice Mode listening on http://localhost:${config.port}`);
  });
}

bootstrap();
