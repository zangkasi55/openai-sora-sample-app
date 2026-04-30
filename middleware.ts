// Middleware to protect the API routes
import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, isValidAuthToken } from "@/lib/auth";

const getAllowedOrigins = (): Set<string> => {
  const s = new Set<string>();

  // Add explicit env override (optional)
  // e.g. NEXT_PUBLIC_APP_URL=https://yourapp.example
  if (process.env.NEXT_PUBLIC_APP_URL) {
    s.add(process.env.NEXT_PUBLIC_APP_URL);
  }

  // If deploying on Vercel, allow the (preview) host returned in VERCEL_URL
  if (process.env.VERCEL_URL) {
    s.add(`https://${process.env.VERCEL_URL}`);
  }

  return s;
};

const ALLOWED_FROM_ENV = getAllowedOrigins();

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/login",
  "/favicon.ico",
  "/sora-2.png",
]);

const isPublicPath = (pathname: string): boolean =>
  PUBLIC_PATHS.has(pathname)
  || pathname.startsWith("/_next/")
  || /\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|map|txt)$/i.test(pathname);

export async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;

  // Let OPTIONS preflights pass
  if (req.method === "OPTIONS") return new NextResponse(null, { status: 204 });

  const isAuthenticated = await isValidAuthToken(
    req.cookies.get(AUTH_COOKIE_NAME)?.value,
  );

  if (!isAuthenticated && !isPublicPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: { message: "Authentication required" } },
        { status: 401 },
      );
    }

    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthenticated && pathname === "/login") {
    const homeUrl = req.nextUrl.clone();
    homeUrl.pathname = "/";
    homeUrl.search = "";
    return NextResponse.redirect(homeUrl);
  }

  if (!pathname.startsWith("/api/")) return NextResponse.next();

  // Get the incoming Origin header (may be null for same-origin navigations)
  const incomingOrigin = req.headers.get("origin");

  // Derive this app's runtime origin from the request URL.
  // This handles dev and prod automatically (e.g., http://localhost:3000 or https://yourapp.example).
  const appOrigin = req.nextUrl.origin;

  // Build the allowed set for this request: appOrigin has priority (auto-injected)
  const allowed = new Set(ALLOWED_FROM_ENV);
  allowed.add(appOrigin);

  // For strictness: reject requests without Origin (they could be forms),
  // but many same-origin browser requests won't send Origin (so we allow referer fallback).
  if (!incomingOrigin) {
    // Try referer fallback (safer than outright deny).
    const referer = req.headers.get("referer");
    if (referer) {
      try {
        const u = new URL(referer);
        if (!allowed.has(`${u.protocol}//${u.host}`)) {
          return NextResponse.json(
            { error: "Forbidden — invalid Referer" },
            { status: 403 }
          );
        }
      } catch {
        return NextResponse.json(
          { error: "Forbidden — invalid Referer" },
          { status: 403 }
        );
      }
    } else {
      // No Origin and no Referer — conservative block (prevents form PoC).
      return NextResponse.json(
        { error: "Forbidden — missing Origin/Referer" },
        { status: 403 }
      );
    }
  } else {
    // If incoming Origin is present, ensure it matches what we expect.
    if (!allowed.has(incomingOrigin)) {
      return NextResponse.json(
        { error: "Forbidden — invalid Origin" },
        { status: 403 }
      );
    }
  }

  // Additionally: for POSTs, enforce JSON content-type to block form posts
  if (req.method === "POST") {
    const ct = (req.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("application/json")) {
      return NextResponse.json(
        { error: "Unsupported Media Type" },
        { status: 415 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
