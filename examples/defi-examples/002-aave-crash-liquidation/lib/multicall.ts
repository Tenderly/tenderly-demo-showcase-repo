/**
 * Multicall3 through eth_call: many view calls per request, a few requests at a time. One failing call returns
 * null for that call instead of failing the batch.
 */
import { Interface, type JsonRpcProvider } from "ethers";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const mc = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

export interface Call {
  target: string;
  data: string;
}

/** Return data for each call, or null where the call reverted. */
export async function multicall(
  p: JsonRpcProvider,
  calls: Call[],
  opts: { chunk?: number; parallel?: number } = {},
): Promise<Array<string | null>> {
  const chunk = opts.chunk ?? 100;
  const out: Array<string | null> = new Array(calls.length).fill(null);
  const starts = Array.from({ length: Math.ceil(calls.length / chunk) }, (_, i) => i * chunk);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < starts.length) {
      const start = starts[next++];
      const batch = calls.slice(start, start + chunk).map((c) => ({ target: c.target, allowFailure: true, callData: c.data }));
      const raw = await retry(() => p.call({ to: MULTICALL3, data: mc.encodeFunctionData("aggregate3", [batch]) }));
      const results = mc.decodeFunctionResult("aggregate3", raw)[0] as Array<{ success: boolean; returnData: string }>;
      results.forEach((r, i) => {
        out[start + i] = r.success ? r.returnData : null;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.parallel ?? 8, starts.length) }, worker));
  return out;
}

/** One more try after a short pause: the RPC drops a connection now and then. */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, 1_000));
    return fn();
  }
}
