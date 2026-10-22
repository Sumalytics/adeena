import { Suspense } from "react";
import type { Metadata } from "next";
import { registerFailureMessage, registerStatusMessage } from "@/auth/password-post";
import page from "../page.module.css";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Create account" };

export default function RegisterPage({ searchParams }: { searchParams: Promise<{ error?: string; status?: string }> }) {
  return (
    <main id="content" className={page.main}>
      <p className={page.brand}>adeena</p>
      <h1 className={page.title}>Create account</h1>
      <p className={page.lead}>Register with email. Adeena does not keep a separate password.</p>
      <Suspense fallback={<p className={page.lead}>Checking your session…</p>}>
        <RegisterFields searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function RegisterFields({ searchParams }: { searchParams: Promise<{ error?: string; status?: string }> }) {
  const params = await searchParams;
  return <RegisterForm errorMessage={registerFailureMessage(params.error)} statusMessage={registerStatusMessage(params.status)} />;
}
