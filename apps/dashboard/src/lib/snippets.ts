import { SERVER } from "./config";

export type Client = "claude" | "cursor" | "http" | "functions";

/** Ready-to-paste connection snippets. Client syntax is from each client's docs (checked Oct 2026). */
export function snippet(
  client: Client,
  agent: string,
  token: string,
  server: string = SERVER,
): string {
  const mcp = `${server}/agent/mcp`;
  const api = `${server}/agent/v1`;
  switch (client) {
    case "claude":
      return `claude mcp add --transport http syndromi-${agent} ${mcp} \\\n  --header "Authorization: Bearer ${token}"`;
    case "cursor":
      return `// ~/.cursor/mcp.json (or .cursor/mcp.json in a project)\n${JSON.stringify(
        {
          mcpServers: {
            [`syndromi-${agent}`]: { url: mcp, headers: { Authorization: `Bearer ${token}` } },
          },
        },
        null,
        2,
      )}`;
    case "http":
      return [
        `# the agent, its rules and what is left of its allowance`,
        `curl ${api}/me -H "Authorization: Bearer ${token}"`,
        ``,
        `# the tools, with JSON Schemas`,
        `curl ${api}/tools -H "Authorization: Bearer ${token}"`,
        ``,
        `# call one (a blocked or held action is still HTTP 200: read the status in the body)`,
        `curl -X POST ${api}/tools/balances \\`,
        `  -H "Authorization: Bearer ${token}" -H "content-type: application/json" \\`,
        `  -d '{"input": {}}'`,
      ].join("\n");
    case "functions":
      return [
        `// Any model with function calling: hand it these tools, run what it asks for here.`,
        `const base = "${api}";`,
        `const headers = { authorization: "Bearer ${token}", "content-type": "application/json" };`,
        ``,
        `const { tools } = await (await fetch(\`\${base}/tools\`, { headers })).json();`,
        `// tools: [{ name, description, inputSchema }]. Map them to your provider's function format.`,
        ``,
        `async function runTool(name, input) {`,
        `  const res = await fetch(\`\${base}/tools/\${name}\`, {`,
        `    method: "POST", headers, body: JSON.stringify({ input }),`,
        `  });`,
        `  return res.text(); // give this back to the model as the tool result`,
        `}`,
        `// Results say executed, awaiting_owner_approval or blocked. Blocked and held are final:`,
        `// tell the model not to retry or split the action.`,
      ].join("\n");
  }
}
