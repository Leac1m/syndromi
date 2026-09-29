// Our own Blink viewer: GET /approve/:id renders the Action behind a draft or top-up and walks
// the owner's wallet through it via the Wallet Standard (no web3.js, no third-party host).
// It speaks the same Actions endpoints any Blink client would, so dial.to and wallets with
// native Blink support keep working when available.
import type { Hono } from "hono";
import type { ServerContext } from "./context.js";

const CHAINS = { devnet: "solana:devnet", mainnet: "solana:mainnet", fork: "solana:mainnet" };

export function mountApprovePage(app: Hono, ctx: ServerContext) {
  app.get("/approve/:id", (c) => {
    const id = c.req.param("id");
    const record = id.startsWith("d_")
      ? ctx.store.draft(id)
      : id.startsWith("t_")
        ? ctx.store.topUp(id)
        : undefined;
    if (!record) return c.text("No such approval request.", 404);
    const kind = id.startsWith("d_") ? "draft" : "topup";
    return c.html(
      page({
        actionPath: `/actions/approve-${kind}/${id}`,
        chain: CHAINS[record.cluster],
        owner: record.owner,
      }),
    );
  });
}

const page = (cfg: { actionPath: string; chain: string; owner: string }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>syndromi approval</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#111827; --muted:#6b7280; --accent:#059669; --err:#dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0f17; --card:#111827; --fg:#f3f4f6; --muted:#9ca3af; } }
  body { margin:0; font:16px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--fg); display:grid; place-items:center; min-height:100vh; padding:16px; box-sizing:border-box; }
  .card { background:var(--card); border-radius:16px; padding:24px; max-width:460px; width:100%; box-shadow:0 8px 30px rgba(0,0,0,.12); }
  .head { display:flex; gap:12px; align-items:center; } .head img { width:44px; height:44px; border-radius:10px; }
  h1 { font-size:20px; margin:0; } p { white-space:pre-line; color:var(--muted); }
  button { width:100%; padding:12px; border:0; border-radius:10px; background:var(--accent); color:#fff; font-size:16px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  pre { white-space:pre-wrap; font-size:12px; background:rgba(127,127,127,.12); padding:10px; border-radius:8px; }
  .status { margin-top:12px; font-size:14px; } .err { color:var(--err); }
</style></head>
<body><main class="card">
  <div class="head"><img id="icon" alt=""><h1 id="title">Loading…</h1></div>
  <p id="desc"></p>
  <p id="network" hidden></p>
  <pre id="signing" hidden></pre>
  <button id="go" disabled>…</button>
  <div class="status" id="status"></div>
</main>
<script>
const ACTION = ${JSON.stringify(cfg.actionPath)}, CHAIN = ${JSON.stringify(cfg.chain)}, OWNER = ${JSON.stringify(cfg.owner)};
const $ = (id) => document.getElementById(id);
const status = (text, err) => { $("status").textContent = text; $("status").className = "status" + (err ? " err" : ""); };

// Minimal Wallet Standard discovery (https://github.com/wallet-standard/wallet-standard).
const wallets = [];
const api = { register: (...ws) => { wallets.push(...ws); return () => {}; } };
window.addEventListener("wallet-standard:register-wallet", (e) => e.detail(api));
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ""; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toBase64 = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));

async function post(href, body) {
  const res = await fetch(href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || "HTTP " + res.status);
  return json;
}

function pickWallet() {
  const ok = wallets.filter((w) => w.features["standard:connect"] && w.chains.some((c) => c.startsWith("solana:")));
  return ok.find((w) => /phantom/i.test(w.name)) || ok[0];
}

async function load() {
  const res = await fetch(ACTION);
  const a = await res.json();
  if (!res.ok) { $("title").textContent = "Unavailable"; status(a.message || "Not found", true); return; }
  $("icon").src = a.icon; $("title").textContent = a.title; $("desc").textContent = a.description;
  const link = (a.links && a.links.actions && a.links.actions[0]) || { href: ACTION, label: a.label };
  // Wallets sign and send on their own selected network, whatever chain the page asks for.
  if (link.type === "transaction" && CHAIN !== "solana:mainnet") {
    $("network").hidden = false;
    $("network").textContent = "Devnet transaction: your wallet only signs it and syndromi sends it to devnet. If the wallet's preview simulates on mainnet it may warn about fees; the fee is paid on devnet.";
  }
  $("go").textContent = a.disabled ? a.label : link.label;
  $("go").disabled = !!a.disabled;
  $("go").onclick = () => approve(link.href).catch((e) => { status(e.message || String(e), true); $("go").disabled = false; });
}

async function approve(href) {
  $("go").disabled = true;
  const wallet = pickWallet();
  if (!wallet) throw new Error("No Solana wallet found. Install or unlock Phantom, then reload.");
  status("Connecting " + wallet.name + "…");
  const { accounts } = await wallet.features["standard:connect"].connect();
  const account = accounts.find((acc) => acc.address === OWNER) || accounts[0];
  if (!account) throw new Error("The wallet shared no account.");
  if (account.address !== OWNER) throw new Error("Switch " + wallet.name + " to the bag owner " + OWNER + " (connected: " + account.address + ").");
  const res = await post(href, { account: account.address });
  let done;
  if (res.type === "message") {
    $("signing").hidden = false; $("signing").textContent = res.data;
    status("Sign the message in " + wallet.name + " (free, no transaction)…");
    const [out] = await wallet.features["solana:signMessage"].signMessage({ account, message: new TextEncoder().encode(res.data) });
    done = await post(res.links.next.href, { account: account.address, signature: base58(out.signature), data: res.data, state: res.state });
  } else if (res.type === "transaction" && wallet.features["solana:signTransaction"]) {
    // Sign only; the server sends it to the agent's cluster. Wallets send on their own selected
    // network, which is not always the one the page asks for.
    status("Approve the transaction in " + wallet.name + "…");
    const [out] = await wallet.features["solana:signTransaction"].signTransaction({ account, chain: CHAIN, transaction: fromBase64(res.transaction) });
    status("Signed. Sending and confirming…");
    done = await post(ACTION + "/submit", { account: account.address, transaction: toBase64(out.signedTransaction) });
  } else if (res.type === "transaction") {
    status("Approve the transaction in " + wallet.name + " (" + CHAIN + ")…");
    const [out] = await wallet.features["solana:signAndSendTransaction"].signAndSendTransaction({ account, chain: CHAIN, transaction: fromBase64(res.transaction) });
    status("Sent. Confirming…");
    done = await post(res.links.next.href, { account: account.address, signature: base58(out.signature) });
  } else {
    throw new Error("Unsupported action type: " + res.type);
  }
  $("title").textContent = done.title; $("desc").textContent = done.description;
  $("go").textContent = done.label; $("go").disabled = true; status("Done. You can close this tab.");
}

load().catch((e) => status(e.message || String(e), true));
</script></body></html>`;
