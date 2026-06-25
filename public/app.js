// NOA Voice Mode — browser client.
// Turn-based voice loop over SSE: open stream → record → POST utterance →
// filler + transcript + streamed text/cards + ordered PCM audio → done → re-arm.
// Barge-in: the mic stays live while NOA speaks; a higher-threshold VAD (or a tap /
// the Interrupt button) cuts her off — playback stops, the in-flight turn is aborted,
// and we listen again, preserving the words you opened with.
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
let micAnalyser = null; // session-scoped: lives for the whole voice session
let micStream = null; // opened once on enter, closed on exit (so barge-in can hear)
let playHead = 0;
let pendingAudio = 0; // scheduled chunks still to finish playing
let phase = "connecting";
let assistantText = "";
let currentUserText = ""; // transcript of the in-flight turn (for partial history)

const liveSources = new Set(); // scheduled playback buffers, for an instant cut
let turnController = null; // AbortController for the in-flight /api/voice fetch
let turnGen = 0; // bumped per listening turn; stale async work checks against it

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

function setPhase(p) {
  phase = p;
  const stage = $("stage");
  stage.dataset.phase = p;
  $("phaseLabel").textContent = PHASE_LABEL[p] ?? p;
  const line = $("controlLine");
  const hint = $("controlHint");
  const btn = $("interrupt");
  // While NOA is replying, the manual interrupt affordance is available.
  const replying = p === "speaking" || p === "thinking" || p === "transcribing";
  if (btn) btn.hidden = !replying;
  if (p === "listening") {
    line.textContent = "Listening for you…";
    hint.textContent = "Tap the wave to stop · NOA replies when you pause";
  } else if (p === "speaking") {
    line.textContent = "NOA is speaking";
    hint.textContent = "Just start talking — or tap — to cut in";
  } else if (p === "thinking" || p === "transcribing") {
    line.textContent = "Working…";
    hint.textContent = "Looking up your account · talk to cut in";
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

// Dispatch one parsed SSE event to the UI. `gen` is the turn it belongs to;
// if a barge-in has since started a new turn, the frame is dropped.
function handleEvent(event, data, gen) {
  if (gen !== turnGen) return;
  if (event === "transcript") {
    const t = data.text || "";
    currentUserText = t; // remember it in case this turn gets interrupted
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
      if (gen !== turnGen) return; // barged during the spoken tail
      if (assistantText.trim()) setCaption("NOA", assistantText.trim(), false);
      setPhase("paused"); // clear "speaking" so the re-arm guard lets us listen
      startListening();
    });
  } else if (event === "turn_error") {
    // Server caught an error mid-turn (no `done` follows). Surface it and drop
    // to a tappable idle state — deliberately no auto re-arm so it can be read.
    console.warn("[turn_error]", data.message);
    stopBargeWatch();
    setPhase("paused");
    setCaption("NOA", "Sorry, I hit a problem. Tap the wave to try again.", false);
  }
}

// POST the utterance + history; stream the turn back and dispatch each frame.
// The fetch is abortable so a barge-in tears the whole turn down at once.
async function postTurn(audioBlob, gen) {
  const fd = new FormData();
  fd.append("audio", audioBlob, "turn.webm");
  fd.append("history", JSON.stringify(history));

  turnController = new AbortController();
  let res;
  try {
    res = await fetch("/api/voice", {
      method: "POST",
      body: fd,
      signal: turnController.signal,
    });
  } catch {
    if (gen !== turnGen) return; // aborted by a barge-in — expected
    setPhase("error");
    return;
  }
  if (gen !== turnGen) return;
  if (!res.ok || !res.body) {
    setPhase("error");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (gen !== turnGen) return; // a barge-in superseded this turn
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
          handleEvent(event, JSON.parse(dataStr), gen);
        } catch {
          /* skip malformed frame */
        }
      }
    }
  } catch {
    // Reader threw — usually our own abort (barge-in); otherwise a dropped stream.
    if (gen !== turnGen) return;
    setPhase("error");
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

// ── Mic session (opened once; lives across turns so barge-in can hear) ─
async function openMic() {
  if (micStream) return true;
  ensureCtx();
  try {
    // Echo cancellation keeps NOA's own playback out of the mic, so her voice
    // can't trip the barge-in detector while she's speaking.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    setPhase("error");
    setCaption("", "Microphone access denied.", false);
    return false;
  }
  micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 1024;
  micAnalyser.smoothingTimeConstant = 0.4;
  ctx.createMediaStreamSource(micStream).connect(micAnalyser);
  return true;
}
function closeMic() {
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  micAnalyser = null;
}

let vadBuf = null;
function micLevel() {
  if (!micAnalyser) return 0;
  if (!vadBuf || vadBuf.length !== micAnalyser.fftSize)
    vadBuf = new Float32Array(micAnalyser.fftSize);
  micAnalyser.getFloatTimeDomainData(vadBuf);
  let sum = 0;
  for (let i = 0; i < vadBuf.length; i++) sum += vadBuf[i] * vadBuf[i];
  return Math.sqrt(sum / vadBuf.length);
}

// ── Capture VAD (auto-stop on trailing silence) + barge VAD ──────────
const SILENCE_RMS = 0.012; // end-of-utterance threshold while listening
const SILENCE_HOLD_MS = 1400;
const MAX_TURN_MS = 30000;
// Barge-in needs a higher bar than ordinary silence so NOA's residual audio or a
// stray noise won't trigger it; sustained speech past the hold is a real interrupt.
const BARGE_RMS = 0.05;
const BARGE_HOLD_MS = 280;

let rec = null;
let chunks = [];
let vadRAF = null;
let silenceSince = 0;
let hasSpoken = false;
let listening = false;
let maxTimer = null;

// Barge watcher state
let bargeRAF = null;
let bargeSince = 0; // when the current run of above-threshold speech began
let provisional = false; // a recorder started at barge onset, not yet committed

// Begin (or adopt) a listening turn. `adopt` keeps the provisional recorder that
// a barge-in already started, so the user's opening words aren't clipped.
function startListening({ adopt = false } = {}) {
  if (listening) return;
  stopBargeWatch();
  if (maxTimer) {
    clearTimeout(maxTimer);
    maxTimer = null;
  }
  const gen = ++turnGen; // invalidates any still-draining previous turn
  listening = true;
  silenceSince = 0;
  hasSpoken = adopt; // adopting means the user is already mid-word

  if (adopt && rec && rec.state === "recording") {
    provisional = false; // promote the onset recorder to this turn's recorder
    rec.onstop = () => onUtteranceEnd(gen);
  } else {
    rec = new MediaRecorder(micStream);
    chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => onUtteranceEnd(gen);
    rec.start();
  }

  // New turn: clear the previous reply + its cards from the stage.
  assistantText = "";
  currentUserText = "";
  clearCards();
  setPhase("listening");
  setCaption("", "", false);
  startCaptureVad();
  maxTimer = setTimeout(stopRec, MAX_TURN_MS);
}

async function onUtteranceEnd(gen) {
  if (gen !== turnGen) return; // superseded
  stopCaptureVad();
  listening = false;
  // Nothing said (re-arm noise or a silent timeout) → just listen again.
  if (!hasSpoken) {
    startListening();
    return;
  }
  setPhase("thinking");
  playFiller(); // instant latency mask, no server round-trip
  startBargeWatch(); // you can cut in during thinking AND speaking
  await postTurn(new Blob(chunks, { type: "audio/webm" }), gen);
}

function startCaptureVad() {
  const tick = () => {
    if (!listening) return;
    const rms = micLevel();
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
function stopCaptureVad() {
  if (vadRAF) cancelAnimationFrame(vadRAF);
  if (maxTimer) clearTimeout(maxTimer);
  vadRAF = null;
  maxTimer = null;
}
function stopRec() {
  if (rec && rec.state !== "inactive") rec.stop();
}

// While NOA replies, watch the live mic for the user talking over her. We start
// capturing at the first sign of speech (so onset isn't lost) but only commit to
// an interrupt once that speech is sustained past BARGE_HOLD_MS.
function startBargeWatch() {
  if (bargeRAF) return;
  bargeSince = 0;
  const tick = () => {
    if (phase !== "speaking" && phase !== "thinking" && phase !== "transcribing") {
      bargeRAF = null;
      cancelProvisionalRecorder();
      bargeSince = 0;
      return;
    }
    const rms = micLevel();
    const now = performance.now();
    if (rms >= BARGE_RMS) {
      if (!bargeSince) {
        bargeSince = now;
        startProvisionalRecorder(); // capture the opening words now
      } else if (now - bargeSince >= BARGE_HOLD_MS) {
        bargeIn({ adopt: true });
        return;
      }
    } else if (bargeSince) {
      // The blip died before the hold — not an interrupt. Discard, keep playing.
      cancelProvisionalRecorder();
      bargeSince = 0;
    }
    bargeRAF = requestAnimationFrame(tick);
  };
  bargeRAF = requestAnimationFrame(tick);
}
function stopBargeWatch() {
  if (bargeRAF) cancelAnimationFrame(bargeRAF);
  bargeRAF = null;
  bargeSince = 0;
  cancelProvisionalRecorder();
}

function startProvisionalRecorder() {
  if (provisional || !micStream) return;
  rec = new MediaRecorder(micStream);
  chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = null; // not bound to a turn until the barge commits
  rec.start();
  provisional = true;
}
function cancelProvisionalRecorder() {
  if (!provisional) return;
  provisional = false;
  const r = rec;
  rec = null;
  chunks = [];
  if (r && r.state !== "inactive") {
    r.ondataavailable = null;
    r.onstop = null;
    try {
      r.stop();
    } catch {
      /* already stopped */
    }
  }
}

// The interrupt itself — shared by the voice trigger, the wave tap, and the button.
function bargeIn({ adopt = false } = {}) {
  if (phase !== "speaking" && phase !== "thinking" && phase !== "transcribing")
    return;
  // 1) Remember the interrupted exchange so NOA stays coherent across the cut.
  commitPartialHistory();
  // 2) Silence NOA and abort the server turn (no `done`, so nothing re-arms it).
  cutPlayback();
  turnController?.abort();
  // 3) Stop the watcher loop, but keep the onset recorder when adopting it.
  if (bargeRAF) {
    cancelAnimationFrame(bargeRAF);
    bargeRAF = null;
  }
  bargeSince = 0;
  if (adopt && provisional && rec && rec.state === "recording") {
    startListening({ adopt: true });
  } else {
    cancelProvisionalRecorder();
    startListening();
  }
}

// Record the interrupted turn locally. The server aborted without committing, so
// we reconstruct a minimal text-only record: the user's question + the words NOA
// actually spoke, marked as cut off. (Tool-call blocks for the dropped turn are
// intentionally omitted — that turn won't continue.)
function commitPartialHistory() {
  const u = currentUserText.trim();
  if (!u) return; // never saw the transcript → nothing reliable to record
  const a = assistantText.trim();
  history.push({ role: "user", content: u });
  history.push({
    role: "assistant",
    content: a ? a + " — [interrupted by the user]" : "[interrupted before responding]",
  });
}

// The wave is the single primary control: stop while listening, interrupt while
// NOA replies, or (re)start while idle.
function handleWaveTap() {
  if (listening) {
    stopRec();
    return;
  }
  if (phase === "speaking" || phase === "thinking" || phase === "transcribing") {
    bargeIn(); // manual interrupt: no onset recorder, the user taps then speaks
    return;
  }
  startListening();
}

// ── Enter / exit the voice stage ─────────────────────────────────────
async function enterVoiceMode() {
  // Unlock audio inside the click gesture; the first playback comes later.
  ensureCtx();
  if (ctx.state === "suspended") await ctx.resume();
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
  // Open the mic once for the whole session, then go hands-free.
  if (await openMic()) startListening();
}

function exitVoiceMode() {
  turnGen++; // invalidate any in-flight turn callbacks
  turnController?.abort();
  stopRec();
  stopCaptureVad();
  stopBargeWatch();
  cutPlayback();
  listening = false;
  closeMic();
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
$("interrupt").onclick = () => bargeIn();
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("stage").hidden) exitVoiceMode();
});
