import { NextResponse } from "next/server";
import { config } from "../../../../lib/config";
import { COOKIE_NAME, checkCredentials, issueToken } from "../../../../lib/auth";

export const runtime = "nodejs";

// Compare creds to .env; on success set an httpOnly signed session cookie.
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "username and password required" }, { status: 400 });
  }
  if (!checkCredentials(username, password, config.authUsername, config.authPassword)) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const token = await issueToken(username, config.sessionSecret, config.sessionTtlMs);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.floor(config.sessionTtlMs / 1000),
    path: "/",
  });
  return res;
}
