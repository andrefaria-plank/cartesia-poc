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
