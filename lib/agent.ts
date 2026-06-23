import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { config } from "./config";
import { toolDefs, runTool } from "./tools";

export type AgentEvent =
  | { kind: "text"; delta: string }
  | { kind: "card"; card: unknown }
  // Emitted exactly once, last, on a fully successful turn: the new committed
  // history for the client to send back on the next turn.
  | { kind: "history"; messages: MessageParam[] };

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

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
 * NOA agent — real Claude with mock back-office tools. STATELESS: history comes in
 * as an argument and the new history is yielded back as the terminal `history`
 * event. One HTTP request is one turn, so there is no shared-state concurrency to
 * guard (each Vercel invocation owns its own `messages` array).
 *
 * Yields spoken `text` deltas (-> Sonic) and `card` events (raw tool data -> UI)
 * SEPARATELY. Claude never "speaks" audio; it reasons and emits text.
 */
export async function* runAgent(
  history: MessageParam[],
  userText: string,
): AsyncIterable<AgentEvent> {
  // Build the turn on a COPY of the incoming history; only the terminal `history`
  // event (emitted after a fully successful turn) commits it. A mid-loop failure
  // throws before that, so the client keeps its previous history — no dangling
  // `user` message that would produce two user turns in a row.
  const messages: MessageParam[] = [...history, { role: "user", content: userText }];

  // Agentic loop: stream text, run any tools, feed results back, repeat until Claude stops.
  for (let hop = 0; hop < 6; hop++) {
    const stream = anthropic.messages.stream({
      model: config.agentModel,
      max_tokens: 512,
      system: SYSTEM,
      tools: toolDefs,
      messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { kind: "text", delta: event.delta.text }; // spoken -> Sonic
      }
    }

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
  yield { kind: "history", messages };
}
