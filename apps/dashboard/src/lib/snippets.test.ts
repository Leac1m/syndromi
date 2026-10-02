import { describe, expect, it } from "vitest";
import { snippet } from "./snippets";

const SERVER = "https://api.example.com";

describe("connection snippets", () => {
  it("adds a remote HTTP MCP server to Claude Code with a bearer header", () => {
    expect(snippet("claude", "mcp-agent", "syn_abc", SERVER)).toBe(
      'claude mcp add --transport http syndromi-mcp-agent https://api.example.com/agent/mcp \\\n  --header "Authorization: Bearer syn_abc"',
    );
  });

  it("writes valid Cursor mcp.json with url and headers", () => {
    const text = snippet("cursor", "mcp-agent", "syn_abc", SERVER);
    const json = JSON.parse(text.split("\n").slice(1).join("\n")) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(json.mcpServers["syndromi-mcp-agent"]).toEqual({
      url: "https://api.example.com/agent/mcp",
      headers: { Authorization: "Bearer syn_abc" },
    });
  });

  it("points curl and code at the HTTP API", () => {
    expect(snippet("http", "a", "syn_abc", SERVER)).toContain(
      "curl https://api.example.com/agent/v1/me",
    );
    const code = snippet("functions", "a", "syn_abc", SERVER);
    expect(code).toContain('const base = "https://api.example.com/agent/v1"');
    expect(() => new Function(`return async () => {\n${code}\n}`)).not.toThrow();
  });
});
