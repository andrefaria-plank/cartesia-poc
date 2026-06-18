export type AgentEvent =
  | { kind: "text"; delta: string }
  | { kind: "card"; card: unknown };

/**
 * NOA agent. Replace the body with your real streaming LLM call.
 *
 * Contract: yield spoken `text` deltas and visual `card` events SEPARATELY.
 * Only `text` reaches Sonic — cards are never read aloud, they render in the UI
 * and trigger the chime on the client.
 */
export async function* runAgent(userText: string): AsyncIterable<AgentEvent> {
  // ---- demo stub ----
  yield { kind: "text", delta: "Sure. " };
  yield { kind: "text", delta: "Here is your appointment for tomorrow. " };
  yield { kind: "card", card: { type: "appointment", title: "Doctor", time: "10:00" } };
  yield { kind: "text", delta: "Is there anything else I can help with?" };

  // Quiet the unused-var lint in the stub; your real impl will use userText.
  void userText;
}
