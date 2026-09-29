/** JSON that survives bigints (as strings), for logs, drafts, and tool results. */
export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), space);
}
