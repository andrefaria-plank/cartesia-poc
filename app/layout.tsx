import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "NOA Voice Mode — Sign in",
  description: "Sign in to NOA Voice Mode",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
