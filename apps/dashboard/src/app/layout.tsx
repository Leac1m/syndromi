import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "syndromí: budgets for AI agents on Solana", template: "%s · syndromí" },
  description:
    "Give AI agents an allowance, not your wallet. Onchain budgets, a policy check on every transaction, approvals you sign, and a one-signature kill switch.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
