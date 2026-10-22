import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse } from "next/server";
import { validateCredentials } from "./credentials";
import { safeNextPath } from "./paths";
import { supabaseBrowserConfig } from "./public-config";

const MAX_PASSWORD_POST_BYTES = 2048;
const WINDOW_MS = 10 * 60 * 1000;
const EMAIL_LIMIT = 8;
const GLOBAL_LIMIT = 40;

const LOGIN_ERRORS = new Set(["credentials", "unconfirmed", "rejected", "limited", "unavailable"]);
const REGISTER_ERRORS = new Set(["exists", "rejected", "limited", "unavailable"]);

export type AuthCookie = {
  name: string;
  value: string;
  options?: CookieOptions;
};

type Attempt =
  | { ok: true; cookies: AuthCookie[] }
  | { ok: false; code: string; cookies: AuthCookie[] };

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function resetPasswordPostLimits() {
  buckets.clear();
}

function consume(key: string, limit: number, now: number) {
  const current = buckets.get(key);
  if (!current || now >= current.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

export function requestOriginAllowed(request: Request) {
  let expected: string;
  try {
    expected = new URL(request.url).origin;
  } catch {
    return false;
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin) return origin === expected;
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

function formContentType(request: Request) {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  return type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/form-data");
}

function declaredLength(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "");
  return Number.isInteger(declared) && declared >= 0 && declared <= MAX_PASSWORD_POST_BYTES;
}

export function rejectPasswordPost(request: Request, page: "/login" | "/register") {
  if (request.method !== "POST" || !formContentType(request) || !declaredLength(request) || !requestOriginAllowed(request)) {
    return seeOther(request, page, { error: "rejected" });
  }
  return null;
}

function seeOther(request: Request, pathname: string, params: { error?: string; status?: string; next?: string }) {
  const url = new URL(pathname, request.url);
  url.search = "";
  url.hash = "";
  if (params.error) url.searchParams.set("error", params.error);
  if (params.status) url.searchParams.set("status", params.status);
  if (params.next) url.searchParams.set("next", safeNextPath(params.next));
  const response = NextResponse.redirect(url, 303);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

function withCookies(response: NextResponse, cookies: AuthCookie[]) {
  for (const cookie of cookies) response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}

async function boundedFormData(request: Request) {
  if (!request.body) return null;
  let total = 0;
  const stream = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > MAX_PASSWORD_POST_BYTES) throw new Error("oversized");
      controller.enqueue(chunk);
    },
  }));
  const bounded = new Request("http://adeena.local/auth", {
    method: "POST",
    headers: request.headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  try {
    return await bounded.formData();
  } catch {
    return null;
  }
}

async function readFields(request: Request) {
  const form = await boundedFormData(request);
  if (!form) return null;
  const allowed = new Set(["email", "password", "next"]);
  for (const key of form.keys()) {
    if (!allowed.has(key)) return null;
  }
  const email = form.get("email");
  const password = form.get("password");
  const next = form.get("next");
  if (typeof email !== "string" || typeof password !== "string") return null;
  if (form.getAll("email").length !== 1 || form.getAll("password").length !== 1) return null;
  if (next !== null && (typeof next !== "string" || form.getAll("next").length !== 1)) return null;
  return { email, password, next: safeNextPath(typeof next === "string" ? next : null) };
}

function requestCookies(request: Request) {
  const header = request.headers.get("cookie") ?? "";
  return header.split(";").flatMap((part) => {
    const index = part.indexOf("=");
    if (index <= 0) return [];
    const name = part.slice(0, index).trim();
    if (!name) return [];
    return [{ name, value: part.slice(index + 1).trim() }];
  });
}

function authClient(request: Request, jar: AuthCookie[]) {
  const { url, key } = supabaseBrowserConfig();
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return requestCookies(request);
      },
      setAll(cookiesToSet) {
        jar.splice(0, jar.length, ...cookiesToSet);
      },
    },
  });
}

function loginCode(code: string | undefined) {
  if (code === "invalid_credentials") return "credentials";
  if (code === "email_not_confirmed") return "unconfirmed";
  if (code === "over_request_rate_limit" || code === "too_many_requests") return "limited";
  return "unavailable";
}

export function loginFailureMessage(code: string | undefined) {
  if (code === "confirm") return "The confirmation link is invalid or expired.";
  if (code === "credentials") return "Email or password is incorrect.";
  if (code === "unconfirmed") return "Confirm your email before signing in.";
  if (code === "rejected") return "Check the email and password and try again.";
  if (code === "limited") return "Sign-in did not complete. Try again shortly.";
  if (code === "unavailable") return "Sign-in did not complete.";
  return null;
}

export function registerFailureMessage(code: string | undefined) {
  if (code === "exists") return "An account with that email already exists.";
  if (code === "rejected") return "Check the email and password and try again.";
  if (code === "limited") return "Registration did not complete. Try again shortly.";
  if (code === "unavailable") return "Registration did not complete.";
  return null;
}

export function registerStatusMessage(status: string | undefined) {
  if (status === "confirm") return "Check your email to confirm your account.";
  return null;
}

function registerCode(code: string | undefined) {
  if (code === "user_already_exists") return "exists";
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || code === "too_many_requests") return "limited";
  return "unavailable";
}

function globallyLimited(kind: "login" | "register") {
  return !consume(`${kind}:global`, GLOBAL_LIMIT, Date.now());
}

function emailLimited(kind: "login" | "register", email: string) {
  return !consume(`${kind}:email:${email.trim().toLowerCase()}`, EMAIL_LIMIT, Date.now());
}

async function supabaseSignIn(request: Request, email: string, password: string): Promise<Attempt> {
  const jar: AuthCookie[] = [];
  try {
    const supabase = authClient(request, jar);
    const result = await supabase.auth.signInWithPassword({ email, password });
    if (result.error) return { ok: false, code: loginCode(result.error.code), cookies: jar };
    return { ok: true, cookies: jar };
  } catch {
    return { ok: false, code: "unavailable", cookies: [] };
  }
}

async function supabaseSignUp(request: Request, email: string, password: string): Promise<Attempt & { session: boolean }> {
  const jar: AuthCookie[] = [];
  try {
    const supabase = authClient(request, jar);
    const origin = new URL(request.url).origin;
    const result = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${origin}/auth/confirm` },
    });
    if (result.error) return { ok: false, code: registerCode(result.error.code), cookies: jar, session: false };
    return { ok: true, cookies: jar, session: result.data.session !== null };
  } catch {
    return { ok: false, code: "unavailable", cookies: [], session: false };
  }
}

export async function handleLoginPost(request: Request, signIn: typeof supabaseSignIn = supabaseSignIn) {
  const rejected = rejectPasswordPost(request, "/login");
  if (rejected) return rejected;
  if (globallyLimited("login")) return seeOther(request, "/login", { error: "limited" });
  const fields = await readFields(request);
  if (!fields || validateCredentials(fields.email, fields.password)) {
    return seeOther(request, "/login", { error: "rejected" });
  }
  const email = fields.email.trim();
  if (emailLimited("login", email)) return seeOther(request, "/login", { error: "limited", next: fields.next });
  const result = await signIn(request, email, fields.password);
  if (!result.ok) {
    const error = LOGIN_ERRORS.has(result.code) ? result.code : "unavailable";
    return withCookies(seeOther(request, "/login", { error, next: fields.next }), result.cookies);
  }
  return withCookies(seeOther(request, fields.next, {}), result.cookies);
}

export async function handleRegisterPost(request: Request, signUp: typeof supabaseSignUp = supabaseSignUp) {
  const rejected = rejectPasswordPost(request, "/register");
  if (rejected) return rejected;
  if (globallyLimited("register")) return seeOther(request, "/register", { error: "limited" });
  const fields = await readFields(request);
  if (!fields || validateCredentials(fields.email, fields.password)) {
    return seeOther(request, "/register", { error: "rejected" });
  }
  const email = fields.email.trim();
  if (emailLimited("register", email)) return seeOther(request, "/register", { error: "limited" });
  const result = await signUp(request, email, fields.password);
  if (!result.ok) {
    const error = REGISTER_ERRORS.has(result.code) ? result.code : "unavailable";
    return withCookies(seeOther(request, "/register", { error }), result.cookies);
  }
  if (!result.session) return withCookies(seeOther(request, "/register", { status: "confirm" }), result.cookies);
  return withCookies(seeOther(request, "/creator", {}), result.cookies);
}
