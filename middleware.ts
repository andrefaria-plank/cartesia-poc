import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, verifyToken } from "./lib/auth";

// Reachable without a session: the login page, its asset bundle, the auth API,
// the favicon. Everything else (voice client + /api/voice) requires a cookie.
const PUBLIC = [/^\/login$/, /^\/_next\//, /^\/api\/auth\//, /^\/favicon\.ico$/];

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();

  const token = req.cookies.get(COOKIE_NAME)?.value;
  const user = await verifyToken(token, process.env.SESSION_SECRET ?? "");
  if (user) return NextResponse.next();

  // API callers get a clean 401; page navigations get bounced to /login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next's static internals (the public-path list above
  // still gates /_next/ data requests, but static assets/images are skipped).
  matcher: ["/((?!_next/static|_next/image).*)"],
};
