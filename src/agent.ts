import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { config } from "./config.js";
import { toolDefs, runTool } from "./tools.js";

export type AgentEvent =
  | { kind: "text"; delta: string }
  | { kind: "card"; card: unknown };

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// Per-session conversation history → real multi-turn dialogue (not a stub).
const histories = new Map<string, MessageParam[]>();

// In-flight turns, keyed by session. The history is a single shared array per
// session, and the Anthropic API rejects a request the moment a `tool_use`
// block no longer immediately precedes its `tool_result`. Two overlapping turns
// (double-tap, retry, a second tab) would interleave their pushes and desync,
// so a session may only run one turn at a time.
const inFlight = new Set<string>();

const SYSTEM = `You are NOA, a warm voice assistant for a home-care service company.
You are talking to the customer OUT LOUD — your text is read aloud by a speech engine.

Rules:
- Keep replies SHORT and conversational, like spoken English. One or two sentences.
- NEVER output markdown, bullet points, JSON, code, or symbols like *, #, $. Say "dollars" not "$".
- Use the tools to look up real account data before answering anything factual. Never invent
  invoice numbers, dates, amounts, or statuses — read them from a tool.
- After a tool returns, give a brief natural summary of what matters to the customer.
- If something is overdue or a payment failed, mention it gently and offer to help.
- The customer may be an older adult: be patient, clear, and reassuring.`;

/**
 * NOA agent — real Claude with mock back-office tools.
 *
 * Yields spoken `text` deltas (-> Sonic) and `card` events (raw tool data -> UI) SEPARATELY.
 * Claude never "speaks" audio; it reasons and emits text. Cartesia handles all voice.
 */
export async function* runAgent(
  sessionId: string,
  userText: string,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  // One turn per session at a time (see `inFlight`). Reject overlaps instead of
  // letting them interleave the shared history.
  if (inFlight.has(sessionId)) {
    throw new Error("a turn is already in progress for this session");
  }
  inFlight.add(sessionId);

  // Build the turn on a COPY of the committed history; it is written back only
  // if the whole turn succeeds. So a mid-loop failure (stream/tool throws) can't
  // leave a dangling `user` message that would produce two user turns in a row.
  const messages: MessageParam[] = [
    ...(histories.get(sessionId) ?? []),
    { role: "user", content: userText },
  ];

  try {
    // Agentic loop: stream text, run any tools, feed results back, repeat until Claude stops.
    for (let hop = 0; hop < 6; hop++) {
      const stream = anthropic.messages.stream(
        {
          model: config.agentModel,
          max_tokens: 512,
          system: SYSTEM,
          tools: toolDefs,
          messages,
        },
        { signal },
      );

      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield { kind: "text", delta: event.delta.text }; // spoken -> Sonic
          }
        }
      } catch (err) {
        // A barge-in aborts the stream: stop gracefully and DON'T commit, so the
        // interrupted (partial) turn leaves the committed history untouched.
        if (signal?.aborted) return;
        throw err;
      }

      if (signal?.aborted) return; // barge-in landed between deltas — discard
      const msg = await stream.finalMessage();
      messages.push({ role: "assistant", content: msg.content });

      const toolUses = msg.content.filter((b) => b.type === "tool_use");
      if (toolUses.length === 0) break; // Claude is done talking

      // Execute each tool, emit its raw result as a UI card, feed result back to Claude.
      const results: ContentBlockParam[] = [];
      for (const tu of toolUses) {
        const out = runTool(tu.name, (tu.input ?? {}) as Record<string, unknown>);
        yield { kind: "card", card: out.card }; // visual only — never read aloud
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(out.data),
        });
      }
      messages.push({ role: "user", content: results });
    }

    // Commit only after a fully successful turn.
    histories.set(sessionId, messages);
  } finally {
    inFlight.delete(sessionId);
  }
}

/** Drop a session's memory when its SSE channel closes. */
export function forgetSession(sessionId: string): void {
  histories.delete(sessionId);
  inFlight.delete(sessionId);
}
