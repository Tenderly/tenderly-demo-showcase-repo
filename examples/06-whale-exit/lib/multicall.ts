/**
 * Batch contract reads through Multicall3 (same address on every EVM chain): many views in one eth_call.
 *
 * aggregate3 runs the calls in order and may also call state-changing functions (e.g. Morpho.accrueInterest); in an
 * eth_call their effects last until the end of the call, so later reads in the same batch see them.
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
  /** Keep going when this call reverts; its value is then undefined. Default false: one revert fails the batch. */
  allowFailure?: boolean;
}

/** Run the calls in one eth_call and decode each result (undefined for an allowed failure). */
export async function multicall(p: JsonRpcProvider, calls: ContractCall[]): Promise<Array<Result | undefined>> {
  if (!calls.length) return [];
  const data = multicallI.encodeFunctionData("aggregate3", [calls.map((c) => ({
    target: getAddress(c.target), allowFailure: c.allowFailure ?? false, callData: c.iface.encodeFunctionData(c.fn, c.args ?? []),
  }))]);
  const [rows] = multicallI.decodeFunctionResult("aggregate3", await p.call({ to: MULTICALL3, data })) as unknown as [Array<[boolean, string]>];
  return calls.map((c, i) => {
    const [success, out] = rows[i];
    if (!success || out === "0x") return undefined;
    try {
      return c.iface.decodeFunctionResult(c.fn, out);
    } catch {
      return undefined;
    }
  });
}
