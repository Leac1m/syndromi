import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { Shell } from "@/components/shell";

export const metadata: Metadata = {
  title: "App",
  description: "Budgets, permissions, and approvals for onchain AI agents",
};

// The product lives under /app; the marketing page at / ships no wallet code.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <Shell>{children}</Shell>
    </Providers>
  );
}
