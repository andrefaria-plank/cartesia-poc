import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { transcribe, streamTts } from "../../../lib/cartesia";
import { runAgent, type AgentEvent } from "../../../lib/agent";

// The Cartesia/Anthropic SDKs need Node APIs (Buffer, ws), not the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // a turn is bounded; recording is capped at 30s client-side

/**
 * One streaming request = one voice turn. Replaces the old SSE-channel + separate
 * upload split, which relied on shared server memory and could not run on Vercel.
 *
 * Request:  multipart form { audio: Blob, history: JSON string }
 * Response: SSE wire format (event:/data: lines), one ordered stream:
 *   transcript → text → card → audio → done{history}   (or turn_error{message})
 *
 * Barge-in: there is no separate abort endpoint — the turn IS the request, so the
 * client just aborts its `fetch`. That fires `req.signal`, which we thread into the
 * agent + Sonic so a cut tears the turn down at once and emits no `done` (no commit).
 */
export async function POST(req: Request): Promise<Response> {
  let audio: Buffer;
  let history: MessageParam[];
  try {
    const form = await req.formData();
    const file = form.get("audio");
    if (!(file instanceof Blob)) {
      return Response.json({ error: "missing audio file" }, { status: 400 });
    }
    audio = Buffer.from(await file.arrayBuffer());
    history = JSON.parse((form.get("history") as string) || "[]");
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const t0 = performance.now();
  const enc = new TextEncoder();
  const signal = req.signal; // aborts when the client cancels the fetch (barge-in)

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed || signal.aborted) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true; // stream already torn down (client gone)
        }
      };

      try {
        // STT (Ink) — whole utterance.
        const userText = await transcribe(audio);
        if (signal.aborted) return;
        const tStt = performance.now();
        send("transcript", { text: userText });

        // Fan the agent stream into: spoken text (-> Sonic) and cards (-> UI).
        // The terminal `history` event is captured for the `done` payload.
        let newHistory: MessageParam[] = history;
        const textStream = (async function* (): AsyncIterable<string> {
          for await (const ev of runAgent(history, userText, signal) as AsyncIterable<AgentEvent>) {
            if (signal.aborted) return;
            if (ev.kind === "text") {
              send("text", { delta: ev.delta });
              yield ev.delta;
            } else if (ev.kind === "card") {
              send("card", { card: ev.card });
            } else {
              newHistory = ev.messages;
            }
          }
        })();

        // Stream agent tokens into Sonic; relay each PCM chunk in order.
        let tFirstAudio = 0;
        await streamTts(
          textStream,
          (pcmBase64) => {
            if (signal.aborted) return;
            if (!tFirstAudio) tFirstAudio = performance.now();
            send("audio", { audio: pcmBase64 });
          },
          signal,
        );

        // A barge-in cut leaves silently — no `done`, so the client (already moved
        // on to the interrupting utterance) won't re-arm or commit against this turn.
        if (signal.aborted) return;
        // Turn complete — hand the new history back for the next turn.
        send("done", { history: newHistory });

        const ms = (a: number, b: number) => Math.round(b - a);
        console.log(
          "[turn]",
          JSON.stringify({
            stt_ms: ms(t0, tStt),
            tts_ttfa_ms: tFirstAudio ? ms(tStt, tFirstAudio) : null,
            total_ms: ms(t0, performance.now()),
          }),
        );
      } catch (err) {
        // A barge-in abort can surface here too — don't report it as a failure.
        if (!signal.aborted) send("turn_error", { message: (err as Error).message });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
