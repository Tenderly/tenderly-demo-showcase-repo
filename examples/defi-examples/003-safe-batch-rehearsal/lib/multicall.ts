/**
 * Multicall3 (same address on every EVM chain): many contract calls in one eth_call or one bundle step. aggregate3 may
 * also call state-changing functions such as Morpho's accrueInterest; later calls in the same batch see their effects.
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
  /** Keep going when this call reverts; its result is then undefined. */
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
    if (!success || data === "0x") return undefined;
    try {
      return c.iface.decodeFunctionResult(c.fn, data);
    } catch (err) {
      // e.g. a token whose symbol() returns bytes32
      if (c.allowFailure) return undefined;
      throw err;
    }
  });
}

/** Run the calls in one eth_call on the latest block. */
export async function multicall(p: JsonRpcProvider, calls: ContractCall[]): Promise<Array<Result | undefined>> {
  if (!calls.length) return [];
  return decodeCalls(calls, await p.call({ to: MULTICALL3, data: encodeCalls(calls) }));
}
