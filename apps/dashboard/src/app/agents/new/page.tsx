"use client";
// Create-agent wizard: template → edit budget and rules → rule card → hosted: create and fund;
// local: copy the CLI command, wait for the agent to register, then fund.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ActionPanel } from "@/components/action-panel";
import { useApp } from "@/components/providers";
import { Card, RuleCard } from "@/components/ui";
import { type AgentView, api, type Template } from "@/lib/api";
import { SERVER } from "@/lib/config";
import { usePoll } from "@/lib/use-poll";

type Draft = Template["manifest"];

export default function NewAgent() {
  const app = useApp();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [template, setTemplate] = useState<Template>();
  const [manifest, setManifest] = useState<Draft>();
  const [runtime, setRuntime] = useState<"hosted" | "local" | "external">("external");
  const [preview, setPreview] = useState<{ ok: boolean; errors?: string[]; ruleCard?: string[] }>();
  const [created, setCreated] = useState<AgentView>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    // The server lists the default template (mcp-agent) first; start with it selected.
    api.templates().then(
      (list) => {
        setTemplates(list);
        const first = list[0];
        if (first) {
          setTemplate(first);
          setManifest(structuredClone(first.manifest));
          setRuntime(first.manifest.runtime);
        }
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  function pick(t: Template) {
    setTemplate(t);
    setManifest(structuredClone(t.manifest));
    setRuntime(t.manifest.runtime);
    setCreated(undefined);
  }

  useEffect(() => {
    if (!manifest) return;
    const timer = setTimeout(() => {
      api.preview(manifest, runtime).then(setPreview, (e: Error) => setError(e.message));
    }, 250);
    return () => clearTimeout(timer);
  }, [manifest, runtime]);

  const set = (patch: (m: Draft) => void) =>
    setManifest((m) => {
      if (!m) return m;
      const next = structuredClone(m);
      patch(next);
      return next;
    });

  async function createHosted() {
    if (!template || !manifest) return;
    setError(undefined);
    try {
      setCreated(await api.createHosted(template.name, app.network, manifest));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="1. Template">
        <div className="grid gap-2">
          {templates.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => pick(t)}
              className={`rounded-xl border p-3 text-left ${template?.name === t.name ? "border-accent" : "border-line"}`}
            >
              <span className="font-medium">{t.name}</span>
              <span className="block text-sm text-muted">{t.ruleCard[0]}</span>
            </button>
          ))}
        </div>
      </Card>

      {manifest && (
        <Card title="2. Budget and rules">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Name" wide>
              <input
                value={manifest.name}
                onChange={(e) =>
                  set((m) => {
                    m.name = e.target.value;
                  })
                }
              />
            </Field>
            <Field label={`Allowance (${manifest.allowance.mint})`}>
              <input
                type="number"
                min={0}
                value={manifest.allowance.amount}
                onChange={(e) =>
                  set((m) => {
                    m.allowance.amount = Number(e.target.value);
                  })
                }
              />
            </Field>
            <Field label="Per">
              <select
                value={manifest.allowance.period}
                onChange={(e) =>
                  set((m) => {
                    m.allowance.period = e.target.value;
                  })
                }
              >
                <option value="daily">day</option>
                <option value="weekly">week</option>
                <option value="monthly">month</option>
              </select>
            </Field>
            <Field label="Max per transaction ($)">
              <input
                type="number"
                min={0}
                value={manifest.permissions.max_tx_usd}
                onChange={(e) =>
                  set((m) => {
                    m.permissions.max_tx_usd = Number(e.target.value);
                  })
                }
              />
            </Field>
            <Field label="Ask me above ($)">
              <input
                type="number"
                min={0}
                value={manifest.permissions.approve_above_usd}
                onChange={(e) =>
                  set((m) => {
                    m.permissions.approve_above_usd = Number(e.target.value);
                  })
                }
              />
            </Field>
            {template?.manifest.runtime !== "external" && (
              <Field label="Runs" wide>
                <select
                  value={runtime}
                  onChange={(e) => setRuntime(e.target.value as "hosted" | "local")}
                >
                  <option value="hosted">hosted by syndromi</option>
                  <option value="local">on my machine (CLI)</option>
                </select>
              </Field>
            )}
          </div>
        </Card>
      )}

      {manifest && (
        <Card title="3. Rule card">
          {preview?.ok && preview.ruleCard ? (
            <RuleCard lines={preview.ruleCard} />
          ) : (
            <ul className="space-y-1 text-sm text-bad">
              {preview?.errors?.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {manifest && (
        <Card title="4. Create and fund">
          {runtime === "hosted" ? (
            created ? (
              <ActionPanel path={`/actions/fund-agent/${encodeURIComponent(created.name)}`} />
            ) : (
              <button
                type="button"
                disabled={!preview?.ok}
                onClick={() => void createHosted()}
                className="w-full rounded-lg bg-accent px-4 py-2.5 font-semibold text-accent-fg disabled:opacity-50"
              >
                Create {manifest.name}
              </button>
            )
          ) : (
            <LocalSetup
              name={manifest.name}
              template={template?.name ?? manifest.name}
              external={runtime === "external"}
            />
          )}
          {error && <p className="mt-2 text-sm text-bad">{error}</p>}
          {created && (
            <p className="mt-3 text-sm text-muted">
              Created. After funding, see it on the{" "}
              <Link className="underline" href="/">
                overview
              </Link>
              .
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

function LocalSetup({
  name,
  template,
  external,
}: {
  name: string;
  template: string;
  external?: boolean;
}) {
  const app = useApp();
  const command = `pnpm syndromi init templates/${template} --server ${SERVER} --owner ${app.owner ?? "<your address>"}${app.network === "mainnet" ? " --mainnet" : app.network === "fork" ? " --fork" : ""}`;
  const { data } = usePoll(() => api.overview(app.network), 3000, [app.network]);
  const registered = useMemo(() => data?.agents.find((a) => a.name === name), [data, name]);
  if (registered) {
    return registered.funded ? (
      external ? (
        <div className="space-y-2 text-sm">
          <p className="text-good">{name} is funded. Connect Claude Code (or any MCP client):</p>
          <pre className="overflow-x-auto rounded-lg bg-line p-3 text-xs">{`claude mcp add syndromi-${name} -e SYNDROMI_PASSPHRASE=<your key passphrase> -e SYNDROMI_SERVER_TOKEN=<from .env> -- pnpm --silent --dir <path to the syndromi repo> syndromi mcp templates/${template} --server ${SERVER}${app.network === "devnet" ? "" : ` --${app.network}`}`}</pre>
          <p className="text-muted">
            The client can use only this agent's tools, inside the rules above. Anything over the
            approval limit comes to you to sign.
          </p>
        </div>
      ) : (
        <p className="text-sm text-good">
          {name} is funded. Run it with: pnpm syndromi run templates/{template} --server {SERVER}
        </p>
      )
    ) : (
      <ActionPanel path={`/actions/fund-agent/${encodeURIComponent(name)}`} />
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <p>Create the agent's key on your machine (it never leaves it):</p>
      <pre className="overflow-x-auto rounded-lg bg-line p-3 text-xs">{command}</pre>
      <p className="text-muted">Waiting for {name} to register…</p>
    </div>
  );
}

function Field({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the input is passed in as children
    <label className={`grid gap-1 ${wide ? "col-span-2" : ""}`}>
      <span className="text-muted">{label}</span>
      <span className="[&>*]:w-full [&>*]:rounded-lg [&>*]:border [&>*]:border-line [&>*]:bg-card [&>*]:px-3 [&>*]:py-2">
        {children}
      </span>
    </label>
  );
}
