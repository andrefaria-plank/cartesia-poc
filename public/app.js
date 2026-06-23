// NOA Voice Mode — browser client.
// Turn-based voice loop over SSE: open stream → record → POST utterance →
// filler + transcript + streamed text/cards + ordered PCM audio → done → re-arm.
// The UI is a full-screen "voice stage": a live spectrum waveform whose bars
// are driven per-frame by the mic (listening) or the playback bus (speaking),
// a phase machine, projector-legible captions, and floating tool-result cards.

const SR = 16000;
const BAND_COUNT = 56;

const $ = (id) => document.getElementById(id);

// ── Theme (light default; explicit choice persists) ──────────────────
const THEME_KEY = "noa-theme";
function applyTheme(t) {
  if (t) document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
}
(function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) applyTheme(saved);
})();
$("theme").onclick = () => {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const next = dark ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
};

// ── App state ────────────────────────────────────────────────────────
let sessionId = null;
let es = null;
let ctx = null;
let master = null; // GainNode → destination, taps playbackAnalyser
let playbackAnalyser = null;
let micAnalyser = null;
let micStream = null;
let playHead = 0;
let pendingAudio = 0; // scheduled chunks still to finish playing
let phase = "connecting";
let assistantText = "";
let lastUser = "";
const liveSources = new Set(); // scheduled playback buffers, for instant cut
let expectingReply = false; // gate: are incoming assistant events for the live turn?

// Barge-in interruption method. "voice" = hands-free (the mic detects you
// starting to talk); "manual" = tap the wave or the Interrupt button.
const BARGE_KEY = "noa-barge-mode";
let bargeMode = localStorage.getItem(BARGE_KEY) || "voice";

// ── Phase machine ────────────────────────────────────────────────────
const PHASE_LABEL = {
  connecting: "Connecting",
  paused: "Paused",
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Connection error",
};
const BUSY = new Set(["listening", "transcribing", "thinking", "speaking"]);

function setPhase(p) {
  phase = p;
  const stage = $("stage");
  stage.dataset.phase = p;
  $("phaseLabel").textContent = PHASE_LABEL[p] ?? p;
  updateControl();
}

// Bottom control: the breathing status line, its hint, and (manual mode) the
// Interrupt button — all derived from the current phase + barge-in method.
function updateControl() {
  const line = $("controlLine");
  const hint = $("controlHint");
  const btn = $("interruptBtn");
  const replying = phase === "speaking" || phase === "thinking";
  btn.hidden = !(replying && bargeMode === "manual");

  if (phase === "listening") {
    line.textContent = "Listening for you…";
    hint.textContent = "Tap the wave to stop · NOA replies when you pause";
  } else if (replying) {
    line.textContent = phase === "speaking" ? "NOA is speaking" : "Working…";
    hint.textContent =
      bargeMode === "voice"
        ? "Just start talking to cut in — NOA stops and listens"
        : "Tap Interrupt (or the wave) to cut in";
  } else if (phase === "error") {
    line.textContent = "Something went wrong";
    hint.textContent = "Tap the wave to try again";
  } else {
    line.textContent = "Tap to talk";
    hint.textContent = "NOA can check invoices, visits, deliveries & payments";
  }
}

// ── Captions ─────────────────────────────────────────────────────────
function setCaption(speaker, text, highlightTail) {
  const cap = $("caption");
  cap.innerHTML = "";
  if (speaker) {
    const s = document.createElement("span");
    s.className = "voice-stage__speaker";
    s.textContent = speaker;
    cap.appendChild(s);
  }
  if (!text) {
    const hint = document.createElement("span");
    hint.className = "voice-stage__hint";
    hint.textContent =
      phase === "listening" ? "I'm listening…" : "Tap the wave to talk";
    cap.appendChild(hint);
    return;
  }
  if (!highlightTail) {
    cap.appendChild(document.createTextNode(text));
    return;
  }
  // Emphasize the trailing words so the caption reads as "live" while the
  // reply streams in (text deltas arrive roughly in step with the audio).
  const words = text.split(/(\s+)/);
  const tailFrom = Math.max(0, words.length - 7);
  words.forEach((w, i) => {
    if (!w.trim()) {
      cap.appendChild(document.createTextNode(w));
      return;
    }
    const span = document.createElement("span");
    span.className =
      "voice-stage__word voice-stage__word--" +
      (i >= tailFrom ? "active" : "spoken");
    span.textContent = w;
    cap.appendChild(span);
  });
}

// ── Tool-result cards ────────────────────────────────────────────────
function toneFor(status) {
  const s = String(status).toLowerCase();
  if (["paid", "succeeded", "delivered", "completed", "active"].includes(s))
    return "positive";
  if (["overdue", "declined", "failed", "error"].includes(s)) return "danger";
  if (["open", "scheduled", "in_transit", "pending"].includes(s))
    return "warning";
  return "neutral";
}
const money = (n) => `$${Number(n).toFixed(2)}`;

function row(label, value, tone) {
  const r = document.createElement("div");
  r.className = "tool-row";
  const l = document.createElement("span");
  l.className = "tool-row__label";
  l.textContent = label;
  r.appendChild(l);
  if (tone) {
    const b = document.createElement("span");
    b.className = "badge";
    b.dataset.tone = tone;
    b.textContent = value;
    r.appendChild(b);
  } else {
    const v = document.createElement("span");
    v.className = "tool-row__value";
    v.textContent = value;
    r.appendChild(v);
  }
  return r;
}
function group(rows) {
  const g = document.createElement("div");
  g.className = "tool-card__group";
  rows.forEach((r) => g.appendChild(r));
  return g;
}

// Map a tool card payload → { tool, title, body(node) }.
function buildCard(card) {
  const body = document.createElement("div");
  body.className = "tool-card__body";
  let tool = "check_" + card.type;
  let title = "";

  if (card.type === "client") {
    tool = "check_client";
    title = card.name;
    body.appendChild(
      group([
        row("Plan", card.plan),
        row("Status", card.status, toneFor(card.status)),
        row("Phone", card.phone),
        row("Member since", card.joined),
      ]),
    );
  } else if (card.type === "invoices") {
    tool = "check_invoices";
    title = `${card.invoices.length} invoice${card.invoices.length === 1 ? "" : "s"}`;
    card.invoices.forEach((inv) =>
      body.appendChild(
        group([
          row(inv.id, money(inv.amount)),
          row("Due " + inv.due, inv.status, toneFor(inv.status)),
        ]),
      ),
    );
  } else if (card.type === "visits") {
    tool = "check_visits";
    title = `${card.visits.length} visit${card.visits.length === 1 ? "" : "s"}`;
    card.visits.forEach((v) =>
      body.appendChild(
        group([
          row(v.date, v.status, toneFor(v.status)),
          row("Technician", v.technician),
          row("Reason", v.reason),
        ]),
      ),
    );
  } else if (card.type === "deliveries") {
    tool = "check_delivery_status";
    title = `${card.deliveries.length} order${card.deliveries.length === 1 ? "" : "s"}`;
    card.deliveries.forEach((d) =>
      body.appendChild(
        group([
          row(d.item, d.status, toneFor(d.status)),
          row(d.carrier, d.eta ? "ETA " + d.eta : "Delivered " + d.delivered),
          row("Tracking", d.tracking),
        ]),
      ),
    );
  } else if (card.type === "payments") {
    tool = "check_payments";
    title = `${card.payments.length} payment${card.payments.length === 1 ? "" : "s"}`;
    card.payments.forEach((p) =>
      body.appendChild(
        group([
          row(p.date, money(p.amount)),
          row(p.method, p.status, toneFor(p.status)),
        ]),
      ),
    );
  } else {
    title = "result";
    body.appendChild(row("data", JSON.stringify(card)));
  }
  return { tool, title, body };
}

function renderCard(card) {
  const { tool, title, body } = buildCard(card);
  const el = document.createElement("div");
  el.className = "tool-card";
  const head = document.createElement("div");
  head.className = "tool-card__head";
  const name = document.createElement("code");
  name.className = "tool-card__name";
  name.textContent = tool;
  const t = document.createElement("span");
  t.className = "tool-card__title";
  t.textContent = title;
  head.appendChild(name);
  head.appendChild(t);
  el.appendChild(head);
  el.appendChild(body);
  $("cardsRail").appendChild(el);
}
function clearCards() {
  $("cardsRail").innerHTML = "";
}

// ── Audio: gapless PCM playback through an analysed bus ───────────────
function ensureCtx() {
  if (ctx) return;
  ctx = new AudioContext({ sampleRate: SR });
  master = ctx.createGain();
  playbackAnalyser = ctx.createAnalyser();
  playbackAnalyser.fftSize = 256;
  playbackAnalyser.smoothingTimeConstant = 0.6;
  master.connect(playbackAnalyser);
  playbackAnalyser.connect(ctx.destination);
  playHead = ctx.currentTime;
}

function enqueuePcm(b64) {
  ensureCtx();
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const buf = ctx.createBuffer(1, i16.length, SR);
  const f32 = buf.getChannelData(0);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(master);
  const start = Math.max(playHead, ctx.currentTime);
  src.start(start);
  playHead = start + buf.duration;
  pendingAudio++;
  liveSources.add(src);
  if (phase !== "speaking") setPhase("speaking");
  src.onended = () => {
    pendingAudio = Math.max(0, pendingAudio - 1);
    liveSources.delete(src);
  };
}

// Cut all scheduled/playing audio at once (barge-in). Silence is immediate.
function cutPlayback() {
  for (const s of liveSources) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  liveSources.clear();
  pendingAudio = 0;
  if (ctx) playHead = ctx.currentTime;
}

// ── Waveform render loop (drives every bar each frame) ────────────────
const shown = new Array(BAND_COUNT).fill(0.04);
const REST = 0.04;
let freq = null;

function sampleBands(analyser) {
  if (!freq || freq.length !== analyser.frequencyBinCount)
    freq = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(freq);
  // Map the lower ~70% of bins (where voice energy lives) across the bars.
  const usable = Math.floor(freq.length * 0.7);
  const out = new Array(BAND_COUNT);
  for (let i = 0; i < BAND_COUNT; i++) {
    const a = Math.floor((i / BAND_COUNT) * usable);
    const b = Math.floor(((i + 1) / BAND_COUNT) * usable);
    let max = 0;
    for (let j = a; j <= b && j < usable; j++) max = Math.max(max, freq[j]);
    // Mild curve + boost so quiet speech still moves the bars.
    out[i] = Math.min(1, Math.pow(max / 255, 0.7) * 1.25);
  }
  return out;
}

function startWaveLoop() {
  const bars = $("bars").children;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    for (const bar of bars) bar.style.transform = "scaleY(0.4)";
    return;
  }
  const tick = () => {
    const now = performance.now();
    let targets = null;
    if (phase === "listening" && micAnalyser) targets = sampleBands(micAnalyser);
    else if (phase === "speaking" && playbackAnalyser && pendingAudio > 0)
      targets = sampleBands(playbackAnalyser);

    const pulse =
      phase === "thinking" || phase === "transcribing"
        ? 0.1 + 0.12 * (0.5 + 0.5 * Math.sin(now / 300))
        : phase === "connecting" || phase === "paused"
          ? 0.05 + 0.03 * (0.5 + 0.5 * Math.sin(now / 700))
          : REST;

    for (let i = 0; i < bars.length; i++) {
      // A travelling phase offset gives the calm pulse a gentle wave shape.
      const target = targets
        ? Math.max(REST, targets[i])
        : pulse * (0.6 + 0.4 * (0.5 + 0.5 * Math.sin(now / 360 + i * 0.4)));
      const cur = shown[i];
      const k = target > cur ? 0.5 : 0.2; // snappy attack, smooth decay
      shown[i] = cur + (target - cur) * k;
      bars[i].style.transform = `scaleY(${shown[i].toFixed(3)})`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── SSE stream ───────────────────────────────────────────────────────
function openStream() {
  sessionId = crypto.randomUUID();
  es = new EventSource(`/voice/stream/${sessionId}`);

  es.addEventListener("ready", () => {
    $("statusRow").dataset.live = "true";
    $("statusText").textContent = "Live";
    startVoiceTurn(); // hands-free: begin listening immediately
  });
  // Assistant events are ignored unless we're expecting a reply for the live
  // turn — so a barge-in's aborted turn can't leak stray audio/text/cards into
  // the new one (the protocol carries no turn id to filter on).
  es.addEventListener("transcript", (e) => {
    if (!expectingReply) return;
    lastUser = JSON.parse(e.data).text || "";
    if (lastUser) setCaption("You", lastUser, false);
  });
  es.addEventListener("filler", (e) => {
    if (expectingReply) enqueuePcm(JSON.parse(e.data).audio);
  });
  es.addEventListener("text", (e) => {
    if (!expectingReply) return;
    assistantText += JSON.parse(e.data).delta;
    setCaption("NOA", assistantText.trim(), true);
  });
  es.addEventListener("card", (e) => {
    if (expectingReply) renderCard(JSON.parse(e.data).card);
  });
  es.addEventListener("audio", (e) => {
    if (expectingReply) enqueuePcm(JSON.parse(e.data).audio);
  });
  es.addEventListener("done", () => {
    if (!expectingReply) return;
    expectingReply = false;
    // Wait for the queued audio to finish, then re-arm the mic.
    waitForPlaybackThen(() => {
      if (assistantText.trim()) setCaption("NOA", assistantText.trim(), false);
      setPhase("paused"); // clear "speaking" so the re-arm guard lets us listen
      startCapture();
    });
  });
  es.addEventListener("error", (e) => {
    if (es && es.readyState === EventSource.CLOSED) setPhase("error");
  });
}

function waitForPlaybackThen(fn) {
  const check = () => {
    if (!ctx || (pendingAudio === 0 && ctx.currentTime >= playHead - 0.02)) {
      fn();
    } else {
      setTimeout(check, 120);
    }
  };
  check();
}

// ── Mic capture, VAD & barge-in ──────────────────────────────────────
const SILENCE_RMS = 0.012; // below this counts as silence (end-of-turn)
const SILENCE_HOLD_MS = 1400; // trailing silence that ends a capture
const MAX_TURN_MS = 30000; // hard cap on one capture
// Barge-in: louder + sustained so NOA's own voice (leaking past the browser's
// echo canceller) doesn't self-interrupt. Tuned for headphones or a quiet room.
const BARGE_RMS = 0.05;
const BARGE_HOLD_MS = 320;

let micSource = null; // persistent MediaStreamSource (kept for the whole session)
let rec = null;
let chunks = [];
let silenceSince = 0;
let bargeSince = 0;
let hasSpoken = false;
let listening = false;
let maxTimer = null;
let vadRAF = null;

/** Open the mic once for the whole voice session (echo-cancelled for barge-in). */
async function ensureMic() {
  if (micStream) return true;
  ensureCtx();
  if (ctx.state === "suspended") await ctx.resume();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch {
    setPhase("error");
    setCaption("", "Microphone access denied.", false);
    return false;
  }
  micSource = ctx.createMediaStreamSource(micStream);
  micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 1024;
  micAnalyser.smoothingTimeConstant = 0.5;
  micSource.connect(micAnalyser);
  startVadLoop();
  return true;
}

/** First listen of the session (or after exit): open mic, then capture. */
async function startVoiceTurn() {
  if (listening) return;
  if (BUSY.has(phase) && phase !== "listening") return;
  if (!(await ensureMic())) return;
  startCapture();
}

/** Begin recording a user turn on the already-open mic. */
function startCapture() {
  if (listening || !micStream) return;
  rec = new MediaRecorder(micStream);
  chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = onRecStop;
  rec.start();
  listening = true;
  hasSpoken = false;
  silenceSince = 0;
  // New turn: clear the previous reply + its cards from the stage.
  assistantText = "";
  clearCards();
  setPhase("listening");
  setCaption("", "", false);
  if (maxTimer) clearTimeout(maxTimer);
  maxTimer = setTimeout(stopRec, MAX_TURN_MS);
}

async function onRecStop() {
  if (maxTimer) clearTimeout(maxTimer);
  maxTimer = null;
  listening = false;
  // Nothing said (re-arm noise or a silent timeout) → just listen again.
  if (!hasSpoken) {
    startCapture();
    return;
  }
  setPhase("thinking");
  expectingReply = true; // assistant events from here belong to this turn
  const fd = new FormData();
  fd.append("audio", new Blob(chunks, { type: "audio/webm" }), "turn.webm");
  try {
    await fetch(`/voice/message/${sessionId}`, { method: "POST", body: fd });
  } catch {
    setPhase("error");
  }
}

function stopRec() {
  if (rec && rec.state !== "inactive") rec.stop();
}

/**
 * Interrupt NOA mid-reply: cut local audio, tell the server to stop the turn,
 * and immediately start capturing the interrupting utterance as the next turn.
 */
function bargeIn() {
  if (phase !== "speaking" && phase !== "thinking") return;
  expectingReply = false; // drop any remaining events from the aborted turn
  cutPlayback();
  if (sessionId)
    fetch(`/voice/abort/${sessionId}`, { method: "POST" }).catch(() => {});
  setPhase("paused");
  startCapture();
}

// One VAD loop for the whole session. While listening it ends the turn on
// trailing silence; while NOA is replying (voice mode) it detects you starting
// to talk and barges in.
function startVadLoop() {
  if (vadRAF) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const data = new Float32Array(micAnalyser.fftSize);
  const tick = () => {
    if (!micAnalyser) {
      vadRAF = null;
      return;
    }
    micAnalyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const now = performance.now();

    if (listening) {
      bargeSince = 0;
      if (rms >= SILENCE_RMS) {
        hasSpoken = true;
        silenceSince = 0;
      } else if (hasSpoken) {
        if (silenceSince === 0) silenceSince = now;
        else if (now - silenceSince > SILENCE_HOLD_MS) stopRec();
      }
    } else if (
      bargeMode === "voice" &&
      !reduce &&
      (phase === "speaking" || phase === "thinking")
    ) {
      // Require sustained loudness so a blip (or echo) doesn't false-trigger.
      if (rms >= BARGE_RMS) {
        if (bargeSince === 0) bargeSince = now;
        else if (now - bargeSince > BARGE_HOLD_MS) {
          bargeSince = 0;
          bargeIn();
        }
      } else {
        bargeSince = 0;
      }
    } else {
      bargeSince = 0;
    }
    vadRAF = requestAnimationFrame(tick);
  };
  vadRAF = requestAnimationFrame(tick);
}

// The wave is the single tap-control: stop while listening, interrupt while NOA
// is replying (works in either mode), (re)start while idle.
function handleWaveTap() {
  if (listening) {
    stopRec();
    return;
  }
  if (phase === "speaking" || phase === "thinking") {
    bargeIn();
    return;
  }
  startVoiceTurn();
}

// Reflect the active barge-in method in the segmented control + persist it.
function setBargeMode(mode) {
  bargeMode = mode;
  localStorage.setItem(BARGE_KEY, mode);
  for (const item of $("modeSeg").children)
    item.dataset.selected = String(item.dataset.mode === mode);
  updateControl();
}

// ── Enter / exit the voice stage ─────────────────────────────────────
function enterVoiceMode() {
  // Unlock audio inside the click gesture; the first playback comes later (SSE).
  ensureCtx();
  if (ctx.state === "suspended") ctx.resume();
  $("landing").hidden = true;
  $("stage").hidden = false;
  $("stage").focus();
  setPhase("connecting");
  setCaption("", "", false);
  startWaveLoop();
  openStream();
}

function exitVoiceMode() {
  stopRec();
  if (vadRAF) cancelAnimationFrame(vadRAF);
  vadRAF = null;
  if (maxTimer) clearTimeout(maxTimer);
  maxTimer = null;
  listening = false;
  expectingReply = false;
  cutPlayback();
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  micSource = null;
  micAnalyser = null;
  es?.close();
  es = null;
  $("statusRow").dataset.live = "false";
  $("statusText").textContent = "Idle";
  $("stage").hidden = true;
  $("landing").hidden = false;
  clearCards();
  assistantText = "";
}

// ── Build the waveform bars + wire controls ──────────────────────────
(function buildBars() {
  const bars = $("bars");
  for (let i = 0; i < BAND_COUNT; i++) {
    const b = document.createElement("span");
    b.className = "voice-wave__bar";
    bars.appendChild(b);
  }
})();

$("start").onclick = enterVoiceMode;
$("wave").onclick = handleWaveTap;
$("exit").onclick = exitVoiceMode;
$("interruptBtn").onclick = bargeIn;
for (const item of $("modeSeg").children)
  item.onclick = () => setBargeMode(item.dataset.mode);
setBargeMode(bargeMode); // initialise the segmented control + control copy

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("stage").hidden) exitVoiceMode();
});
