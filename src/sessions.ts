import type { Response } from "express";
import { config } from "./config.js";

type Session = { res: Response; seq: number; timeout: NodeJS.Timeout };

const sessions = new Map<string, Session>();

export function openSession(id: string, res: Response): void {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  sessions.set(id, { res, seq: 0, timeout: armTimeout(id) });
  send(id, "ready", { sessionId: id });
}

export function send(id: string, event: string, data: unknown): void {
  const s = sessions.get(id);
  if (!s) return;
  s.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Monotonically increasing sequence number so the client plays chunks in order. */
export function nextSeq(id: string): number {
  const s = sessions.get(id);
  return s ? s.seq++ : 0;
}

export function hasSession(id: string): boolean {
  return sessions.has(id);
}

/** Reset the silence timer after any activity. */
export function touch(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.timeout);
  s.timeout = armTimeout(id);
}

export function closeSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.timeout);
  try {
    s.res.end();
  } catch {
    /* already closed */
  }
  sessions.delete(id);
}

function armTimeout(id: string): NodeJS.Timeout {
  return setTimeout(() => {
    send(id, "done", { reason: "timeout" });
    closeSession(id);
  }, config.silenceTimeoutMs);
}
