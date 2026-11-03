/**
 * A provider whose eth_call reads the pending block: the latest state at the next block's time. Once
 * tenderly_setNextBlockTimestamp pins that time, these reads see what the next transaction will see.
 */
import { JsonRpcProvider, type TransactionRequest } from "ethers";

export class PendingReads extends JsonRpcProvider {
  constructor(rpcUrl: string, chainId: number) {
    super(rpcUrl, chainId, { staticNetwork: true, batchMaxCount: 1 });
  }

  override call(tx: TransactionRequest): Promise<string> {
    return super.call({ ...tx, blockTag: tx.blockTag ?? "pending" });
  }
}
