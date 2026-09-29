"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Re-runs `load` every `ms` while mounted; `refresh()` forces a run now. */
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const loader = useRef(load);
  loader.current = load;
  const refresh = useCallback(() => {
    loader.current().then(
      (value) => {
        setData(value);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, ms);
    return () => clearInterval(timer);
  }, [refresh, ms, ...deps]);
  return { data, error, refresh };
}

/** Appends new activity events (by seq) every `ms`. */
export function useActivity(
  load: (after?: number) => Promise<{ events: ({ seq: number } & Record<string, unknown>)[] }>,
  ms: number,
  key: string,
) {
  const [events, setEvents] = useState<({ seq: number } & Record<string, unknown>)[]>([]);
  const last = useRef<number | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart only when the key changes
  useEffect(() => {
    let alive = true;
    last.current = undefined;
    setEvents([]);
    const tick = async () => {
      try {
        const { events: fresh } = await load(last.current);
        if (!alive || fresh.length === 0) return;
        // First load returns newest-first; later loads return newer events oldest-first.
        const ordered = last.current === undefined ? [...fresh].reverse() : fresh;
        last.current = Math.max(...ordered.map((e) => e.seq), last.current ?? 0);
        setEvents((prev) => [...prev, ...ordered].slice(-300));
      } catch {
        // keep the last good feed; the overview shows connection errors
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), ms);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [key, ms]);
  return events;
}
