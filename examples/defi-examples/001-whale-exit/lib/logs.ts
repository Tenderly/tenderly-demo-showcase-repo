/**
 * eth_getLogs over a block range. A Virtual Environment answers for its parent chain's history before the fork,
 * so no mainnet RPC is needed. If the node refuses the range, it is split in halves until it answers.
 */
import type { JsonRpcProvider, Log } from "ethers";

export async function getLogsChunked(
  p: JsonRpcProvider, filter: { address: string; topics: Array<string | null> }, fromBlock: number, toBlock: number, depth = 0,
): Promise<Log[]> {
  try {
    return await p.getLogs({ ...filter, fromBlock, toBlock });
  } catch (err) {
    if (depth >= 10 || toBlock <= fromBlock) throw err;
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const [a, b] = await Promise.all([
      getLogsChunked(p, filter, fromBlock, mid, depth + 1),
      getLogsChunked(p, filter, mid + 1, toBlock, depth + 1),
    ]);
    return [...a, ...b];
  }
}
