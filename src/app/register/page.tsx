import type { Metadata } from "next";
import page from "../page.module.css";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Create account" };

export default function RegisterPage() {
  return (
    <main id="content" className={page.main}>
      <p className={page.brand}>adeena</p>
      <h1 className={page.title}>Create account</h1>
      <p className={page.lead}>Register with email. Adeena does not keep a separate password.</p>
      <RegisterForm />
    </main>
  );
}
