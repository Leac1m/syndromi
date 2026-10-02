// Node's fetch reports every network failure as a bare "fetch failed"; the useful part (ECONNRESET,
// ENOTFOUND, a timeout…) is on `cause`. These helpers surface it and recognise the failures that
// are worth another attempt.

const TRANSIENT =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|socket|network|timed? ?out/i;

/** An error's message followed by its causes, e.g. "fetch failed (ECONNRESET: read ECONNRESET)". */
export function errorDetail(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
    const { message, code, cause } = e as { message?: unknown; code?: unknown; cause?: unknown };
    const text = [code, message].filter((x) => typeof x === "string" && x).join(": ");
    if (text && !parts.includes(text)) parts.push(text);
    e = cause;
  }
  const [first, ...causes] = parts;
  if (!first) return String(error);
  return causes.length ? `${first} (${causes.join("; ")})` : first;
}

/** A network hiccup (as opposed to a refusal): safe to retry when the call has no side effects. */
export function isTransientNetworkError(error: unknown): boolean {
  return TRANSIENT.test(errorDetail(error));
}
