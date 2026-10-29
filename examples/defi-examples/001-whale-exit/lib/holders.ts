/**
 * Who holds a token: every address's balance from the token's Transfer logs, checked against totalSupply, and what
 * each of the largest holders is (an EOA, a Safe, a vault that wraps the token for its own depositors, or another
 * contract).
 */
import { Interface, ZeroAddress, getAddress, id as topicId, type JsonRpcProvider } from "ethers";
import { multicall, type ContractCall } from "./multicall.js";
import { getLogsChunked } from "./logs.js";

const TRANSFER = topicId("Transfer(address,address,uint256)");
const tokenI = new Interface(["function totalSupply() view returns (uint256)"]);

export interface Holder {
  address: string;
  balance: bigint;
}

/**
 * Balances from Transfer logs between two blocks, largest first. `complete` is true when they add up to totalSupply
 * exactly, which proves nobody is missing.
 */
export async function holdersFromTransfers(
  p: JsonRpcProvider, token: string, fromBlock: number, toBlock: number,
): Promise<{ holders: Holder[]; logs: number; totalSupply: bigint; complete: boolean }> {
  const [logs, supply] = await Promise.all([
    getLogsChunked(p, { address: token, topics: [TRANSFER] }, fromBlock, toBlock),
    multicall(p, [{ target: token, iface: tokenI, fn: "totalSupply" }]),
  ]);
  const balances = new Map<string, bigint>();
  for (const l of logs) {
    const value = BigInt(l.data);
    const from = getAddress(`0x${l.topics[1].slice(26)}`);
    const to = getAddress(`0x${l.topics[2].slice(26)}`);
    balances.set(from, (balances.get(from) ?? 0n) - value);
    balances.set(to, (balances.get(to) ?? 0n) + value);
  }
  balances.delete(ZeroAddress);
  const holders = [...balances].filter(([, b]) => b > 0n).map(([address, balance]) => ({ address, balance }))
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  const totalSupply = supply[0]![0] as bigint;
  const sum = holders.reduce((s, h) => s + h.balance, 0n);
  return { holders, logs: logs.length, totalSupply, complete: sum === totalSupply };
}

const kindI = new Interface([
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
  "function asset() view returns (address)",
  "function name() view returns (string)",
]);
const KIND_FNS = ["getThreshold", "getOwners", "VERSION", "asset", "name"];

/** What each address is, from its code and the views it answers: "EOA", "Safe 1.4.1, 3 of 5", a vault's name, or "contract". */
export async function holderLabels(p: JsonRpcProvider, addresses: string[]): Promise<string[]> {
  const codes = await Promise.all(addresses.map((a) => p.getCode(a)));
  // An EIP-7702 delegation (code starting 0xef0100) is still an EOA.
  const isContract = codes.map((c) => c.length > 2 && !c.startsWith("0xef0100"));
  const contracts = addresses.filter((_, i) => isContract[i]);
  const r = await multicall(p, contracts.flatMap((a) => KIND_FNS.map((fn): ContractCall => ({ target: a, iface: kindI, fn, allowFailure: true }))));
  const labelOf = new Map(contracts.map((a, i) => {
    const [threshold, owners, version, asset, name] = KIND_FNS.map((_, k) => r[i * KIND_FNS.length + k]?.[0]);
    if (threshold !== undefined && version !== undefined) return [a, `Safe ${version}, ${threshold} of ${(owners as string[] | undefined)?.length ?? "?"}`];
    if (asset !== undefined && name !== undefined) return [a, `vault: ${String(name)}`];
    return [a, "contract"];
  }));
  return addresses.map((a, i) => (isContract[i] ? labelOf.get(a)! : "EOA"));
}
