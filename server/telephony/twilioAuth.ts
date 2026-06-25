/**
 * Twilio request authentication — pure, side-effect-free so it's unit-testable
 * (server/phone.ts wires it to the live endpoints).
 *
 *  - validTwilioSignature: the standard webhook check. Twilio sends
 *    X-Twilio-Signature = base64(HMAC-SHA1(authToken, fullUrl + POST params sorted by
 *    key)). Only Twilio knows the token, so a constant-time match authenticates it.
 *    https://www.twilio.com/docs/usage/security
 *  - mint/validWsToken: Twilio does NOT sign the Media Streams WebSocket, so the
 *    (signature-checked) TwiML embeds a short-lived HMAC token in the wss URL that the
 *    /media upgrade requires back — stops anyone who knows the host opening a call socket.
 */
import crypto from "node:crypto";

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function validTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  return timingSafeEqualStr(signature, expected);
}

export function mintWsToken(secret: string, ttlMs = 60_000): string {
  const exp = Date.now() + ttlMs; // Twilio connects within seconds of the webhook
  const mac = crypto.createHmac("sha256", secret).update(String(exp)).digest("base64url");
  return `${exp}.${mac}`;
}

export function validWsToken(secret: string, token: string | null): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expStr = token.slice(0, dot);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = crypto.createHmac("sha256", secret).update(expStr).digest("base64url");
  return timingSafeEqualStr(token.slice(dot + 1), expected);
}
