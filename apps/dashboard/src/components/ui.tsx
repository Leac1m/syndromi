import type { ReactNode } from "react";

export function Card({
  title,
  action,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-card p-5 shadow-sm">
      {(title || action) && (
        <div className="mb-3 flex items-center gap-3">
          <h2 className="mr-auto text-base font-semibold">{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function RuleCard({ lines }: { lines: string[] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {lines.map((line) => (
        <li key={line} className="flex gap-2">
          <span className="text-accent">•</span>
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

export const tone = {
  neutral: "text-fg",
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad font-semibold",
} as const;
