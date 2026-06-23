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
// History is client-held: the server is stateless, so we keep the Anthropic
// message array here and send it with every turn (the server hands back an
// updated copy on `done`).
let history = [];
let fillers = []; // base64 PCM clips, loaded once from /fillers.json
let ctx = null;
let master = null; // GainNode → destination, taps playbackAnalyser
let playbackAnalyser = null;
let micAnalyser = null;
let micStream = null;
let playHead = 0;
let pendingAudio = 0; // scheduled chunks still to finish playing
let phase = "connecting";
let assistantText = "";

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
  const line = $("controlLine");
  const hint = $("controlHint");
  if (p === "listening") {
    line.textContent = "Listening for you…";
    hint.textContent = "Tap the wave to stop · NOA replies when you pause";
  } else if (p === "speaking") {
    line.textContent = "NOA is speaking";
    hint.textContent = "No barge-in — NOA finishes, then the mic re-arms";
  } else if (p === "thinking" || p === "transcribing") {
    line.textContent = "Working…";
    hint.textContent = "Looking up your account";
  } else if (p === "error") {
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
  if (phase !== "speaking") setPhase("speaking");
  src.onended = () => {
    pendingAudio = Math.max(0, pendingAudio - 1);
  };
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

// ── Streaming turn (one POST, SSE-formatted response body) ───────────
// EventSource can't POST, so we read the streamed response with fetch + a
// ReadableStream reader and parse the SSE `event:`/`data:` frames ourselves.
const FILLERS_URL = "/fillers.json";

async function loadFillers() {
  try {
    const res = await fetch(FILLERS_URL);
    if (res.ok) fillers = await res.json();
  } catch {
    fillers = []; // no filler is fine; the turn just starts a touch later
  }
}

function playFiller() {
  if (!fillers.length) return;
  enqueuePcm(fillers[Math.floor(Math.random() * fillers.length)]);
}

// Dispatch one parsed SSE event to the UI.
function handleEvent(event, data) {
  if (event === "transcript") {
    const t = data.text || "";
    if (t) setCaption("You", t, false);
  } else if (event === "text") {
    assistantText += data.delta;
    setCaption("NOA", assistantText.trim(), true);
  } else if (event === "card") {
    renderCard(data.card);
  } else if (event === "audio") {
    enqueuePcm(data.audio);
  } else if (event === "done") {
    if (Array.isArray(data.history)) history = data.history; // adopt new history
    waitForPlaybackThen(() => {
      if (assistantText.trim()) setCaption("NOA", assistantText.trim(), false);
      setPhase("paused"); // clear "speaking" so the re-arm guard lets us listen
      startVoiceTurn();
    });
  } else if (event === "turn_error") {
    // Server caught an error mid-turn (no `done` follows). Surface it and drop
    // to a tappable idle state — deliberately no auto re-arm so it can be read.
    console.warn("[turn_error]", data.message);
    setPhase("paused");
    setCaption("NOA", "Sorry, I hit a problem. Tap the wave to try again.", false);
  }
}

// POST the utterance + history; stream the turn back and dispatch each frame.
async function postTurn(audioBlob) {
  const fd = new FormData();
  fd.append("audio", audioBlob, "turn.webm");
  fd.append("history", JSON.stringify(history));

  let res;
  try {
    res = await fetch("/api/voice", { method: "POST", body: fd });
  } catch {
    setPhase("error");
    return;
  }
  if (!res.ok || !res.body) {
    setPhase("error");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = "message";
      let dataStr = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      try {
        handleEvent(event, JSON.parse(dataStr));
      } catch {
        /* skip malformed frame */
      }
    }
  }
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

// ── Mic capture + VAD (auto-stop on trailing silence) ────────────────
const SILENCE_RMS = 0.012;
const SILENCE_HOLD_MS = 1400;
const MAX_TURN_MS = 30000;

let rec = null;
let chunks = [];
let vadRAF = null;
let silenceSince = 0;
let hasSpoken = false;
let listening = false;
let maxTimer = null;

async function startVoiceTurn() {
  if (listening) return;
  if (BUSY.has(phase) && phase !== "listening") return;
  ensureCtx();
  if (ctx.state === "suspended") await ctx.resume();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setPhase("error");
    setCaption("", "Microphone access denied.", false);
    return;
  }
  // Tap the same stream for the live spectrum while listening.
  micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 1024;
  micAnalyser.smoothingTimeConstant = 0.55;
  ctx.createMediaStreamSource(micStream).connect(micAnalyser);

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
  startVad();
  maxTimer = setTimeout(stopRec, MAX_TURN_MS);
}

async function onRecStop() {
  stopVad();
  micStream?.getTracks().forEach((t) => t.stop());
  micAnalyser = null;
  listening = false;
  // Nothing said (re-arm noise or a silent timeout) → just listen again.
  if (!hasSpoken) {
    startVoiceTurn();
    return;
  }
  setPhase("thinking");
  playFiller(); // instant latency mask, no server round-trip
  await postTurn(new Blob(chunks, { type: "audio/webm" }));
}

function startVad() {
  const analyser = micAnalyser;
  const data = new Float32Array(analyser.fftSize);
  const tick = () => {
    if (!listening) return;
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const now = performance.now();
    if (rms >= SILENCE_RMS) {
      hasSpoken = true;
      silenceSince = 0;
    } else if (hasSpoken) {
      if (silenceSince === 0) silenceSince = now;
      else if (now - silenceSince > SILENCE_HOLD_MS) {
        stopRec();
        return;
      }
    }
    vadRAF = requestAnimationFrame(tick);
  };
  vadRAF = requestAnimationFrame(tick);
}
function stopVad() {
  if (vadRAF) cancelAnimationFrame(vadRAF);
  if (maxTimer) clearTimeout(maxTimer);
  vadRAF = null;
  maxTimer = null;
}
function stopRec() {
  if (rec && rec.state !== "inactive") rec.stop();
}

// The wave is the single control: stop while listening, (re)start while idle.
function handleWaveTap() {
  if (listening) {
    stopRec();
    return;
  }
  if (phase === "speaking" || phase === "thinking" || phase === "transcribing")
    return; // no barge-in
  startVoiceTurn();
}

// ── Enter / exit the voice stage ─────────────────────────────────────
function enterVoiceMode() {
  // Unlock audio inside the click gesture; the first playback comes later.
  ensureCtx();
  if (ctx.state === "suspended") ctx.resume();
  $("landing").hidden = true;
  $("stage").hidden = false;
  $("stage").focus();
  setCaption("", "", false);
  startWaveLoop();
  // Stateless server: nothing to "open". Preload fillers, reset history, listen.
  history = [];
  loadFillers();
  $("statusRow").dataset.live = "true";
  $("statusText").textContent = "Live";
  setPhase("connecting");
  startVoiceTurn(); // hands-free: begin listening immediately
}

function exitVoiceMode() {
  stopRec();
  stopVad();
  listening = false;
  micStream?.getTracks().forEach((t) => t.stop());
  $("statusRow").dataset.live = "false";
  $("statusText").textContent = "Idle";
  $("stage").hidden = true;
  $("landing").hidden = false;
  clearCards();
  assistantText = "";
  history = [];
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
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("stage").hidden) exitVoiceMode();
});
