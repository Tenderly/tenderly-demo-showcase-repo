/**
 * Multicall3 (same address on every EVM chain): many contract calls in one eth_call or one bundle step.
 *
 * aggregate3 runs the calls in order and may also call state-changing functions such as Morpho's accrueInterest; in
 * an eth_call their effects last until the end of the call, so later calls in the same batch see them. Split a batch
 * with `chunk` only when no call depends on an earlier one.
 */
import { Interface, getAddress, type JsonRpcProvider, type Result } from "ethers";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicallI = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

export interface ContractCall {
  target: string;
  iface: Interface;
  fn: string;
  args?: unknown[];
  /** Keep going when this call reverts or its result doesn't decode; its result is then undefined. Default false. */
  allowFailure?: boolean;
}

/** aggregate3 calldata for the calls, to send to MULTICALL3 from any address. */
export const encodeCalls = (calls: ContractCall[]): string =>
  multicallI.encodeFunctionData("aggregate3", [calls.map((c) => ({
    target: getAddress(c.target),
    allowFailure: c.allowFailure ?? false,
    callData: c.iface.encodeFunctionData(c.fn, c.args ?? []),
  }))]);

/** Each call's decoded result from aggregate3 return data (undefined for an allowed failure). */
export function decodeCalls(calls: ContractCall[], output: string): Array<Result | undefined> {
  const [rows] = multicallI.decodeFunctionResult("aggregate3", output) as unknown as [Array<[boolean, string]>];
  return calls.map((c, i) => {
    const [success, data] = rows[i];
    if (!success) return undefined; // only an allowed failure gets here: any other revert reverts aggregate3
    try {
      // A function with no outputs (accrueInterest) decodes "0x" to an empty Result.
      return c.iface.decodeFunctionResult(c.fn, data);
    } catch (err) {
      // e.g. no code at the target, or a token whose symbol() returns bytes32
      if (c.allowFailure) return undefined;
      throw new Error(`${c.fn} on ${c.target}: ${data === "0x" ? "no return data" : (err as Error).message}`);
    }
  });
}

/**
 * Run the calls on the latest block: one eth_call, or with `chunk` set, batches of that many calls with up to
 * `parallel` (default 8) in flight. A failed request is tried once more after a second, since RPCs drop a connection
 * now and then.
 */
export async function multicall(
  p: JsonRpcProvider,
  calls: ContractCall[],
  opts: { chunk?: number; parallel?: number } = {},
): Promise<Array<Result | undefined>> {
  const chunk = opts.chunk ?? calls.length;
  const out: Array<Result | undefined> = new Array(calls.length);
  const starts = Array.from({ length: Math.ceil(calls.length / chunk) }, (_, i) => i * chunk);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < starts.length) {
      const start = starts[next++];
      const batch = calls.slice(start, start + chunk);
      const raw = await retry(() => p.call({ to: MULTICALL3, data: encodeCalls(batch) }));
      decodeCalls(batch, raw).forEach((r, i) => (out[start + i] = r));
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.parallel ?? 8, starts.length) }, worker));
  return out;
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, 1_000));
    return fn();
  }
}
