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
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  let user: { id: string } | null = null;
  try {
    const verified = await supabase.auth.getUser();
    user = verified.data.user;
  } catch {
    user = null;
  }

  const creatorApi = path === "/api/creator" || path.startsWith("/api/creator/");
  const creatorPage = path === "/creator" || path.startsWith("/creator/");
  if ((creatorApi || studioApi || creatorPage || studioPage) && !user) {
    if (creatorApi || studioApi) {
      const denied = NextResponse.json({ error: "unauthenticated" }, { status: 401 });
      for (const cookie of response.cookies.getAll()) denied.cookies.set(cookie);
      return denied;
    }
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.search = "";
    redirectUrl.searchParams.set("next", safeNextPath(path));
    const redirect = NextResponse.redirect(redirectUrl);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }
  return response;
}

export const config = {
  matcher: ["/play/r/:path*", "/api/releases/:path*", "/creator", "/creator/:path*", "/studio", "/studio/:path*", "/login", "/register", "/auth/:path*", "/api/creator", "/api/creator/:path*", "/api/studio", "/api/studio/:path*"],
};
