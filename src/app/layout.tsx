import type { ReactNode } from "react";
import type { Metadata } from "next";
import "../styles/brand.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "adeena",
    template: "%s · adeena",
  },
  description: "Living Knowledge. Create a source-backed learning experience.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#content">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
