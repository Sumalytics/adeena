import { NextResponse } from "next/server";
import { finishEmailConfirmation } from "@/auth/callback";

export async function GET(request: Request) {
  const result = await finishEmailConfirmation(request.url);
  const destination = new URL(result.ok ? result.next : "/login", request.url);
  if (!result.ok) destination.searchParams.set("error", "confirm");
  return NextResponse.redirect(destination);
}
