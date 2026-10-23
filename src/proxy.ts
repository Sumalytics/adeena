import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/auth/paths";
import { supabaseBrowserConfig } from "@/auth/public-config";
import { isStudioApiPath, isStudioPagePath, studioFixturesAllowed } from "@/studio/availability";
import { RELEASE_HEADERS } from "@/releases/contract";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path.startsWith("/play/r/") || path.startsWith("/api/releases/")) {
    return NextResponse.next({ headers: RELEASE_HEADERS });
  }
  const studioApi = isStudioApiPath(path);
  const studioPage = isStudioPagePath(path);
  if ((studioApi || studioPage) && !studioFixturesAllowed()) {
    if (studioApi) {
      return NextResponse.json({ error: "not-found" }, { status: 404, headers: { "cache-control": "no-store" } });
    }
    return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  }

  let response = NextResponse.next({ request });
  const { url, key } = supabaseBrowserConfig();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headersToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        const refreshed = NextResponse.next({ request });
        copyAuthState(response, refreshed);
        for (const { name, value, options } of cookiesToSet) refreshed.cookies.set(name, value, options);
        for (const [name, value] of Object.entries(headersToSet)) refreshed.headers.set(name, value);
        response = refreshed;
      },
    },
  });

  let subject: string | null = null;
  try {
    const verified = await supabase.auth.getClaims();
    subject = verified.error ? null : typeof verified.data?.claims?.sub === "string" ? verified.data.claims.sub : null;
  } catch {
    subject = null;
  }

  const creatorApi = path === "/api/creator" || path.startsWith("/api/creator/");
  const creatorPage = path === "/creator" || path.startsWith("/creator/");
  if ((creatorApi || studioApi || creatorPage || studioPage) && !subject) {
    if (creatorApi || studioApi) {
      const denied = NextResponse.json({ error: "unauthenticated" }, { status: 401 });
      return copyAuthState(response, denied);
    }
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.search = "";
    redirectUrl.searchParams.set("next", safeNextPath(path));
    const redirect = NextResponse.redirect(redirectUrl);
    return copyAuthState(response, redirect);
  }
  return response;
}

function copyAuthState(source: NextResponse, target: NextResponse) {
  for (const cookie of source.cookies.getAll()) target.cookies.set(cookie);
  for (const [name, value] of source.headers) {
    if (["cache-control", "expires", "pragma"].includes(name.toLowerCase())) {
      target.headers.set(name, value);
    }
  }
  return target;
}

export const config = {
  matcher: ["/play/r/:path*", "/api/releases/:path*", "/creator", "/creator/:path*", "/studio", "/studio/:path*", "/login", "/register", "/auth/:path*", "/api/creator", "/api/creator/:path*", "/api/studio", "/api/studio/:path*"],
};
