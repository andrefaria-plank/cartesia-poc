/**
 * Login-gate auth — a stateless HMAC-signed session cookie (ported from the
 * Express version Gabriel added on `main`). Rewritten on **Web Crypto** so the
 * SAME code runs in Edge middleware (the gate) and Node route handlers (login),
 * which is what lets it work on Vercel. No `node:crypto` — keep it edge-safe.
 */
export const COOKIE_NAME = "noa_session";

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return b64url(sig);
}

// Constant-time-ish string compare that won't short-circuit on content.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** True iff submitted creds match the configured ones. */
export function checkCredentials(
  username: string,
  password: string,
  expectedUser: string,
  expectedPass: string,
): boolean {
  return safeEqual(username, expectedUser) && safeEqual(password, expectedPass);
}

/** Token = base64url(json{ u, exp }).signature — stateless, no server store. */
export async function issueToken(
  username: string,
  secret: string,
  ttlMs: number,
): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ u: username, exp: Date.now() + ttlMs })));
  return `${body}.${await hmac(body, secret)}`;
}

/** Returns the username if the token is well-formed, unexpired, and untampered. */
export async function verifyToken(
  token: string | undefined,
  secret: string,
): Promise<string | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, await hmac(body, secret))) return null;
  try {
    const { u, exp } = JSON.parse(b64urlDecode(body));
    if (typeof exp !== "number" || Date.now() > exp) return null;
    return typeof u === "string" ? u : null;
  } catch {
    return null;
  }
}
