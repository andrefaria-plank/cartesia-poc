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
export async function* runAgent(sessionId: string, userText: string): AsyncIterable<AgentEvent> {
  const history = histories.get(sessionId) ?? [];
  history.push({ role: "user", content: userText });

  // Agentic loop: stream text, run any tools, feed results back, repeat until Claude stops.
  for (let hop = 0; hop < 6; hop++) {
    const stream = anthropic.messages.stream({
      model: config.agentModel,
      max_tokens: 512,
      system: SYSTEM,
      tools: toolDefs,
      messages: history,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { kind: "text", delta: event.delta.text }; // spoken -> Sonic
      }
    }

    const msg = await stream.finalMessage();
    history.push({ role: "assistant", content: msg.content });

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
    history.push({ role: "user", content: results });
  }

  histories.set(sessionId, history);
}

/** Drop a session's memory when its SSE channel closes. */
export function forgetSession(sessionId: string): void {
  histories.delete(sessionId);
}
