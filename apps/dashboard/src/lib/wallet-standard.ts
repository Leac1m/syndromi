// Signing transactions through the Wallet Standard (`solana:signTransaction`), which takes raw
// bytes. The Phantom React SDK routes signTransaction through Phantom's older injected API,
// which expects a web3.js object (`r.serialize is not a function` with kit transactions).
type StandardAccount = { address: string };
type StandardWallet = {
  name: string;
  chains: readonly string[];
  accounts: readonly StandardAccount[];
  features: Record<string, unknown>;
};
type Connect = { connect(): Promise<{ accounts: readonly StandardAccount[] }> };
type SignTransaction = {
  signTransaction(
    ...inputs: { account: StandardAccount; chain?: string; transaction: Uint8Array }[]
  ): Promise<readonly { signedTransaction: Uint8Array }[]>;
};

const wallets: StandardWallet[] = [];
let listening = false;

function discover() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const api = {
    register: (...ws: StandardWallet[]) => {
      wallets.push(...ws);
      return () => undefined;
    },
  };
  window.addEventListener("wallet-standard:register-wallet", (e) =>
    (e as CustomEvent<(a: typeof api) => void>).detail(api),
  );
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
}

export async function signTransactionBytes(owner: string, transaction: Uint8Array, chain: string) {
  discover();
  const candidates = wallets.filter(
    (w) => w.features["solana:signTransaction"] && w.features["standard:connect"],
  );
  const wallet = candidates.find((w) => /phantom/i.test(w.name)) ?? candidates[0];
  if (!wallet)
    throw new Error("No Solana wallet with transaction signing found. Unlock Phantom and reload.");
  let account = wallet.accounts.find((a) => a.address === owner);
  if (!account) {
    const { accounts } = await (wallet.features["standard:connect"] as Connect).connect();
    account = accounts.find((a) => a.address === owner);
  }
  if (!account)
    throw new Error(`Switch ${wallet.name} to the account you signed in with (${owner}).`);
  const [out] = await (
    wallet.features["solana:signTransaction"] as SignTransaction
  ).signTransaction({
    account,
    chain,
    transaction,
  });
  if (!out?.signedTransaction) throw new Error(`${wallet.name} returned no signed transaction.`);
  return out.signedTransaction;
}
