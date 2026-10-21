import { Suspense } from "react";
import type { Metadata } from "next";
import { safeNextPath } from "@/auth/paths";
import page from "../page.module.css";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  return (
    <main id="content" className={page.main}>
      <p className={page.brand}>adeena</p>
      <h1 className={page.title}>Sign in</h1>
      <p className={page.lead}>Use the email and password for your creator account.</p>
      <Suspense fallback={<LoginForm nextPath={safeNextPath(null)} confirmError={false} />}>
        <LoginFields searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function LoginFields({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams;
  return <LoginForm nextPath={safeNextPath(params.next ?? null)} confirmError={params.error === "confirm"} />;
}
