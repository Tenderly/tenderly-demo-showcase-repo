/**
 * Safe helpers: read a Safe, build a Safe transaction the way Safe{Wallet} does, compute the safeTxHash owners sign,
 * execute it with impersonated owners (approveHash, execTransaction), and ask the Safe Transaction Service for the nonce.
 */
import {
  Interface, TypedDataEncoder, ZeroAddress, ZeroHash, concat, getAddress, solidityPacked, zeroPadValue, type JsonRpcProvider,
  type TransactionReceipt,
} from "ethers";

export const safeI = new Interface([
  "function VERSION() view returns (string)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function nonce() view returns (uint256)",
  "function approveHash(bytes32 hashToApprove)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, "
    + "uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
  // txHash is indexed from Safe 1.4.0 on and part of the data before; the topic is the same.
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
]);
const multiSendI = new Interface(["function multiSend(bytes transactions)"]);

/** Safe's revert codes (safe-smart-account docs/error_codes.md) that execTransaction and approveHash can return. */
const SAFE_ERRORS: Record<string, string> = {
  GS010: "not enough gas to execute the Safe transaction",
  GS013: "the inner call reverted",
  GS020: "signatures data too short",
  GS024: "invalid contract signature",
  GS025: "hash not approved",
  GS026: "invalid owner, or signatures not sorted by owner",
  GS030: "only owners can approve a hash",
};
export const safeError = (code: string): string => (SAFE_ERRORS[code] ? `${code} (${SAFE_ERRORS[code]})` : code);

/** MultiSendCallOnly per Safe version and deployment (safe-deployments), picked from the Safe's singleton. */
const SINGLETONS: Record<string, string> = {
  "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552": "1.3.0 canonical",
  "0x3E5c63644E683549055b9Be8653de26E0B4CD36E": "1.3.0 canonical",
  "0x69f4D1788e39c87893C980c06EdF4b7f686e2938": "1.3.0 eip155",
  "0xfb1bffC9d739B8D520DaF37dF666da4C687191EA": "1.3.0 eip155",
  "0x41675C099F32341bf84BFc5382aF534df5C7461a": "1.4.1 canonical",
  "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762": "1.4.1 canonical",
};
const MULTISEND_CALL_ONLY: Record<string, string> = {
  "1.3.0 canonical": "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D",
  "1.3.0 eip155": "0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B",
  "1.4.1 canonical": "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
};

export interface SafeInfo {
  address: string;
  version: string;
  threshold: number;
  owners: string[];
  nonce: bigint;
  multiSendCallOnly: string;
}

/** Read a Safe on the latest block. */
export async function readSafe(p: JsonRpcProvider, address: string): Promise<SafeInfo> {
  const safe = getAddress(address);
  const view = async (fn: string) =>
    safeI.decodeFunctionResult(fn, await p.call({ to: safe, data: safeI.encodeFunctionData(fn) }));
  const version = await view("VERSION").then((r) => r[0] as string, () => {
    throw new Error(`${safe} is not a Safe (VERSION() doesn't answer)`);
  });
  const [[threshold], [owners], [nonce], slot0] = await Promise.all([
    view("getThreshold"), view("getOwners"), view("nonce"), p.getStorage(safe, 0),
  ]);
  const singleton = getAddress(`0x${slot0.slice(26)}`);
  const multiSendCallOnly = MULTISEND_CALL_ONLY[SINGLETONS[singleton] ?? `${version} canonical`];
  if (!multiSendCallOnly) throw new Error(`Safe ${safe} runs version ${version}; add its MultiSendCallOnly to lib/safe.ts`);
  const ownerList = (owners as string[]).map((o) => getAddress(o));
  return { address: safe, version, threshold: Number(threshold), owners: ownerList, nonce, multiSendCallOnly };
}

/** The owners who sign in a rehearsal: the lowest `threshold` by address, the order execTransaction needs. */
export const signersOf = (safe: SafeInfo): string[] =>
  [...safe.owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).slice(0, safe.threshold);

export interface Call {
  to: string;
  data: string;
}

export interface SafeTx {
  to: string;
  value: bigint;
  data: string;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: string;
  refundReceiver: string;
}

/**
 * One Safe transaction for the calls, the way Safe{Wallet} builds it: one call goes direct (operation 0), several go
 * through MultiSendCallOnly (operation 1, a delegatecall). With the gas fields at 0, a failing call reverts the whole
 * Safe transaction with GS013.
 */
export function buildSafeTx(calls: Call[], safe: SafeInfo): SafeTx {
  const gas = { safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZeroAddress, refundReceiver: ZeroAddress };
  if (calls.length === 1) return { to: getAddress(calls[0].to), value: 0n, data: calls[0].data, operation: 0, ...gas };
  // MultiSend's packed encoding per call: operation (uint8), to, value, data length, data.
  const packed = concat(calls.map((c) => solidityPacked(
    ["uint8", "address", "uint256", "uint256", "bytes"], [0, getAddress(c.to), 0n, (c.data.length - 2) / 2, c.data],
  )));
  const data = multiSendI.encodeFunctionData("multiSend", [packed]);
  return { to: safe.multiSendCallOnly, value: 0n, data, operation: 1, ...gas };
}

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

/** The EIP-712 hash owners sign (Safe 1.3.0 and later). It covers the chain id, so it differs per chain. */
export const safeTxHash = (tx: SafeTx, safe: string, chainId: number, nonce: bigint): string =>
  TypedDataEncoder.hash({ chainId, verifyingContract: getAddress(safe) }, SAFE_TX_TYPES, { ...tx, nonce });

export interface SafeExecution {
  /** The hash the owners approved: the environment's chain id and the Safe's nonce there. */
  safeTxHash: string;
  /** The owners who signed, sorted by address; the last one executed. */
  signers: string[];
  execHash?: string;
  /** execTransaction succeeded and the Safe emitted ExecutionSuccess for safeTxHash. */
  ok: boolean;
  error?: string;
}

/** An impersonated send (eth_sendTransaction from the owner's address) that returns the hash and the receipt. */
export type Send = (tx: { from: string; to: string; data: string; gas?: number }) =>
  Promise<{ hash: string; receipt: TransactionReceipt }>;

/**
 * Execute a Safe transaction through the path owners use, with impersonated owners: threshold - 1 owners call
 * approveHash, then the next owner calls execTransaction with pre-validated signatures (r = owner, s = 0, v = 1,
 * sorted by owner). The executor's own signature passes because it is msg.sender.
 */
export async function executeThroughSafe(
  p: JsonRpcProvider, safe: SafeInfo, tx: SafeTx,
  opts: { chainId: number; send: Send; decode: (revertData: string) => string },
): Promise<SafeExecution> {
  const signers = signersOf(safe);
  const executor = signers[signers.length - 1];
  const nonceData = await p.call({ to: safe.address, data: safeI.encodeFunctionData("nonce") });
  const hash = safeTxHash(tx, safe.address, opts.chainId, safeI.decodeFunctionResult("nonce", nonceData)[0] as bigint);
  // One send at a time, so each block gets the time the caller pins for it. Each owner gets its own gas limit: an
  // impersonated send's hash doesn't cover `from`, so equal sends would collide.
  for (const [i, owner] of signers.slice(0, -1).entries()) {
    const data = safeI.encodeFunctionData("approveHash", [hash]);
    const approval = await opts.send({ from: owner, to: safe.address, data, gas: 100_000 + i });
    if (approval.receipt.status !== 1) {
      return { safeTxHash: hash, signers, ok: false, error: "an owner's approval reverted" };
    }
  }
  const signatures = concat(signers.map((owner) => concat([zeroPadValue(owner, 32), ZeroHash, "0x01"])));
  const data = safeI.encodeFunctionData("execTransaction", [
    tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signatures,
  ]);
  const exec = await opts.send({ from: executor, to: safe.address, data });
  const topic = safeI.getEvent("ExecutionSuccess")!.topicHash;
  const ok = exec.receipt.status === 1 && exec.receipt.logs.some((l) =>
    getAddress(l.address) === safe.address && l.topics[0] === topic && (l.topics[1] === hash || l.data.startsWith(hash)));
  if (ok) return { safeTxHash: hash, signers, execHash: exec.hash, ok };
  // The failed transaction changed nothing, so the same call on the same state returns its revert data.
  let error = "the Safe reported no success";
  try {
    await p.call({ from: executor, to: safe.address, data });
  } catch (err) {
    const e = err as { data?: string; info?: { error?: { data?: string } } };
    const revert = [e.data, e.info?.error?.data].find((d) => typeof d === "string" && d.startsWith("0x"));
    error = revert ? opts.decode(revert) : String((err as Error).message ?? err);
  }
  return { safeTxHash: hash, signers, execHash: exec.hash, ok: false, error };
}

export interface NextNonce {
  nonce: bigint;
  /** Nonces of transactions already queued in Safe{Wallet}, at or after the current nonce. */
  queued: bigint[];
  /** Why the Safe Transaction Service wasn't used: "answered HTTP 429", "didn't answer in 6 s", "gave no usable answer". */
  fallback?: string;
}

/**
 * The nonce Safe{Wallet} proposes for a new transaction on Ethereum: after the Safe's current nonce and after anything
 * already queued (signing at a queued nonce would replace that transaction). The Safe Transaction Service is a
 * third-party API; when it doesn't answer, the nonce passed in is used.
 */
export async function nextNonce(safe: string, onChain: bigint): Promise<NextNonce> {
  const base = "https://api.safe.global/tx-service/eth/api";
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  try {
    const info = await get<{ nonce: string | number }>(`/v1/safes/${getAddress(safe)}/`);
    const current = BigInt(info.nonce) > onChain ? BigInt(info.nonce) : onChain;
    const query = `executed=false&nonce__gte=${current}&ordering=nonce&limit=100`;
    const path = `/v2/safes/${getAddress(safe)}/multisig-transactions/?${query}`;
    const queue = await get<{ results?: Array<{ nonce: string | number }> }>(path);
    const queued = [...new Set((queue.results ?? []).map((r) => BigInt(r.nonce)))].sort((a, b) => (a < b ? -1 : 1));
    return { nonce: queued.reduce((n, q) => (q >= n ? q + 1n : n), current), queued };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const why = err instanceof Error && err.name === "TimeoutError" ? "didn't answer in 6 s"
      : /^HTTP \d+$/.test(message) ? `answered ${message}` : "gave no usable answer";
    return { nonce: onChain, queued: [], fallback: why };
  }
}
