import crypto from "node:crypto";
import { config } from "./config.js";

export const COOKIE_NAME = "noa_session";

// Constant-time string compare that won't throw on length mismatch.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn a compare to keep timing flat-ish.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// True iff the submitted creds match the ones in .env.
export function checkCredentials(username: string, password: string): boolean {
  return (
    safeEqual(username, config.authUsername) &&
    safeEqual(password, config.authPassword)
  );
}

function hmac(payload: string): string {
  return crypto
    .createHmac("sha256", config.sessionSecret)
    .update(payload)
    .digest("base64url");
}

// Token = base64url(json{ u, exp }).signature — stateless, no server store.
export function issueToken(username: string): string {
  const body = Buffer.from(
    JSON.stringify({ u: username, exp: Date.now() + config.sessionTtlMs }),
  ).toString("base64url");
  return `${body}.${hmac(body)}`;
}

// Returns the username if the token is well-formed, unexpired, and untampered.
export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, hmac(body))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof exp !== "number" || Date.now() > exp) return null;
    return typeof u === "string" ? u : null;
  } catch {
    return null;
  }
}

// Minimal cookie-header parser (avoids a dep). Returns the named cookie value.
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}
