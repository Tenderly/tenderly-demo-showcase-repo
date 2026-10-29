// Web3 Action run by the "Morpho bad debt" alert. It checks steakUSDC's two invariants on the alerted
// transaction and logs one verdict line. One CommonJS file: the Web3 Actions runtime provides ethers v5 and
// @tenderly/actions, and reads Ethereum through Tenderly's node (context.gateways), so it needs no secrets.
const { ethers } = require("ethers");
const { Network } = require("@tenderly/actions");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"; // Morpho Blue
const VAULT = "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB"; // steakUSDC: shares have 18 decimals, assets are USDC
const ONE_SHARE = ethers.constants.WeiPerEther;
const USDC_DECIMALS = 6;

const morpho = new ethers.utils.Interface([
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
]);
const vaultAbi = [
  "function withdrawQueueLength() view returns (uint256)",
  "function withdrawQueue(uint256 index) view returns (bytes32)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
];
const erc20Abi = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];
const LIQUIDATE = morpho.getEventTopic("Liquidate");

// Every Liquidate in these logs that booked bad debt.
const badDebtIn = (logs) =>
  logs
    .filter((l) => String(l.address).toLowerCase() === MORPHO.toLowerCase())
    .filter((l) => String((l.topics || [])[0]).toLowerCase() === LIQUIDATE)
    .map((l) => morpho.parseLog(l).args)
    .filter((e) => e.badDebtAssets.gt(0));

const actionFn = async (context, alertEvent) => {
  const provider = new ethers.providers.JsonRpcProvider(context.gateways.getGateway(Network.MAINNET));
  const hash = alertEvent.hash || alertEvent.transactionHash;
  let block = Number(alertEvent.blockNumber);
  let liquidations = badDebtIn(alertEvent.logs || []);
  if (liquidations.length === 0 || !block) {
    // Not in the alert's payload: read the transaction receipt instead.
    const receipt = await provider.getTransactionReceipt(hash);
    block = receipt.blockNumber;
    liquidations = badDebtIn(receipt.logs);
  }
  if (liquidations.length === 0) {
    console.log(`steakUSDC invariants not checked: tx ${hash} has no Morpho Blue Liquidate with bad debt`);
    return;
  }

  // Invariant 1: markets steakUSDC lends to (its withdraw queue, before this block) never book bad debt.
  const vault = new ethers.Contract(VAULT, vaultAbi, provider);
  const before = { blockTag: block - 1 };
  const length = (await vault.withdrawQueueLength(before)).toNumber();
  const queue = await Promise.all([...Array(length).keys()].map((i) => vault.withdrawQueue(i, before)));
  const lendsTo = new Set(queue.map((id) => id.toLowerCase()));
  const markets = await Promise.all(liquidations.map((e) => describe(provider, e, lendsTo)));

  // Invariant 2: steakUSDC's share price never falls. One share in USDC at the end of block N-1 and of block N.
  const [p0, p1] = await Promise.all([
    vault.convertToAssets(ONE_SHARE, before),
    vault.convertToAssets(ONE_SHARE, { blockTag: block }),
  ]);

  const broken = [];
  if (markets.some((m) => m.lent)) broken.push("bad debt in a market steakUSDC lends to");
  if (p1.lt(p0)) broken.push("share price fell");
  const verdict = broken.length ? `BROKEN (${broken.join(", ")})` : "HOLD";
  const debt = markets.map((m) => `${m.amount} in ${m.pair} (${m.id}${m.lent ? ", in steakUSDC's withdraw queue" : ""})`);
  const price = `${ethers.utils.formatUnits(p0, USDC_DECIMALS)} → ${ethers.utils.formatUnits(p1, USDC_DECIMALS)} USDC`;
  console.log(
    `steakUSDC invariants ${verdict}. Tx ${hash} at block ${block.toLocaleString("en-US")}: ` +
      `bad debt ${debt.join(", ")}. Share price ${price}.`,
  );
};

// One bad-debt liquidation: "0.002121 USDC", "cbBTC/USDC", "0x64d65c…" and whether steakUSDC lends there.
async function describe(provider, e, lendsTo) {
  const params = await new ethers.Contract(MORPHO, morpho, provider).idToMarketParams(e.id);
  const [loan, collateral, decimals] = await Promise.all([
    symbol(provider, params.loanToken),
    symbol(provider, params.collateralToken),
    new ethers.Contract(params.loanToken, erc20Abi, provider).decimals(),
  ]);
  return {
    amount: `${ethers.utils.commify(ethers.utils.formatUnits(e.badDebtAssets, decimals))} ${loan}`,
    pair: `${collateral}/${loan}`,
    id: `${e.id.slice(0, 8)}…`,
    lent: lendsTo.has(e.id.toLowerCase()),
  };
}

async function symbol(provider, token) {
  try {
    return await new ethers.Contract(token, erc20Abi, provider).symbol();
  } catch {
    return `${token.slice(0, 6)}…`; // no symbol(), or a bytes32 one
  }
}

module.exports = { actionFn };
