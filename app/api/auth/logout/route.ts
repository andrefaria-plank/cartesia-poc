import { NextResponse } from "next/server";
import { COOKIE_NAME } from "../../../../lib/auth";

export const runtime = "nodejs";

// Clear the session cookie.
export async function POST(): Promise<Response> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return res;
}
