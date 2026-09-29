"use client";
// Wallet (Phantom SDK, extension only) and app state: network, owner session.
import {
  AddressType,
  PhantomProvider,
  useConnect,
  useDisconnect,
  usePhantom,
  useSolana,
} from "@phantom/react-sdk";
import {
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  type Transaction,
} from "@solana/kit";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Signer } from "@/lib/actions";
import { clearSession, currentSession, signIn } from "@/lib/api";
import type { Network } from "@/lib/config";
import { signTransactionBytes } from "@/lib/wallet-standard";

type AppState = {
  network: Network;
  setNetwork(n: Network): void;
  owner?: string;
  signedIn: boolean;
  connecting: boolean;
  connect(): Promise<void>;
  signOut(): Promise<void>;
  /** A signer that makes sure the wallet is on the right network first. */
  signer(): Signer | undefined;
  error?: string;
};

const Ctx = createContext<AppState | undefined>(undefined);
export const useApp = () => {
  const value = useContext(Ctx);
  if (!value) throw new Error("useApp outside <Providers>");
  return value;
};

export function Providers({ children }: { children: ReactNode }) {
  return (
    <PhantomProvider
      config={{ providers: ["injected"], addressTypes: [AddressType.solana] }}
      appName="syndromí"
    >
      <AppProvider>{children}</AppProvider>
    </PhantomProvider>
  );
}

function AppProvider({ children }: { children: ReactNode }) {
  const { addresses, isConnected } = usePhantom();
  const { connect: connectWallet, isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { solana } = useSolana();
  const [network, setNetwork] = useState<Network>("devnet");
  // Read the stored session after mount: the server render has no storage, and reading it during
  // the first render made the client's HTML differ (a hydration mismatch).
  const [session, setSession] = useState<ReturnType<typeof currentSession>>();
  useEffect(() => setSession(currentSession()), []);
  const [error, setError] = useState<string>();
  const wallet = addresses.find((a) => a.addressType === AddressType.solana)?.address;

  // A session belongs to one address; switching accounts in the wallet drops it.
  useEffect(() => {
    if (session && wallet && session.owner !== wallet) {
      clearSession();
      setSession(undefined);
    }
  }, [session, wallet]);

  const signMessage = useCallback(
    async (text: string) => {
      const out = (await solana.signMessage(text)) as { signature: Uint8Array | string };
      return typeof out.signature === "string"
        ? new Uint8Array(getBase58Encoder().encode(out.signature))
        : out.signature;
    },
    [solana],
  );

  const connect = useCallback(async () => {
    setError(undefined);
    try {
      const result = isConnected ? undefined : await connectWallet({ provider: "injected" });
      const address =
        result?.addresses.find((a) => a.addressType === AddressType.solana)?.address ?? wallet;
      if (!address) throw new Error("Phantom shared no Solana account.");
      const s = await signIn(address, async (text) => {
        const bytes = await signMessage(text);
        const { getBase58Decoder } = await import("@solana/kit");
        return getBase58Decoder().decode(bytes);
      });
      setSession(s);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [connectWallet, isConnected, signMessage, wallet]);

  const value = useMemo<AppState>(
    () => ({
      network,
      setNetwork,
      ...(session ? { owner: session.owner } : {}),
      signedIn: Boolean(session && (!wallet || wallet === session.owner)),
      connecting: isConnecting,
      connect,
      async signOut() {
        clearSession();
        setSession(undefined);
        await disconnect().catch(() => undefined);
      },
      signer() {
        if (!session) return undefined;
        return {
          account: session.owner,
          signMessage,
          async signTransaction(transaction: Transaction) {
            await solana.switchNetwork(network).catch(() => undefined);
            const wire = new Uint8Array(
              getBase64Encoder().encode(getBase64EncodedWireTransaction(transaction)),
            );
            return signTransactionBytes(session.owner, wire, `solana:${network}`);
          },
        };
      },
      ...(error ? { error } : {}),
    }),
    [network, session, wallet, isConnecting, connect, disconnect, signMessage, solana, error],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
