import type { Metadata } from "next";
import { Landing } from "@/components/landing";

export const metadata: Metadata = {
  openGraph: {
    title: "syndromí: budgets for AI agents on Solana",
    description: "Give your AI agents an allowance, not your wallet.",
    type: "website",
  },
};

export default function Home() {
  return <Landing />;
}
