import { Chain } from '../types';
import { chainConfigs, config } from '../config';
import axios from 'axios';

// Etherscan V2 unified endpoint for on-chain contract existence verification
const ETHERSCAN_V2_URL = 'https://api.etherscan.io/v2/api';
const EVM_CHAIN_IDS: Record<Chain, string> = {
  ethereum: '1',
  bsc: '56',
  base: '8453',
  arbitrum: '42161',
  solana: '',
  tron: '',
};

const EVM_RPC_URLS: Record<Exclude<Chain, 'solana' | 'tron'>, string[]> = {
  ethereum: [
    process.env.ETH_RPC_URL || '',
    'https://ethereum-rpc.publicnode.com',
    'https://eth.llamarpc.com',
  ].filter(Boolean),
  bsc: [
    process.env.BSC_RPC_URL || '',
    'https://bsc-dataseed.binance.org',
    'https://bsc-rpc.publicnode.com',
  ].filter(Boolean),
  base: [
    process.env.BASE_RPC_URL || '',
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
  ].filter(Boolean),
  arbitrum: [
    process.env.ARBITRUM_RPC_URL || '',
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
  ].filter(Boolean),
};

type AddressDetection = { chain: Chain; address: string; needsAutoDetect?: boolean };

const CHAIN_ALIASES: Record<string, Chain> = {
  eth: 'ethereum',
  ethereum: 'ethereum',
  erc20: 'ethereum',
  '以太坊': 'ethereum',
  bsc: 'bsc',
  bnb: 'bsc',
  binance: 'bsc',
  '币安': 'bsc',
  '币安链': 'bsc',
  base: 'base',
  arb: 'arbitrum',
  arbitrum: 'arbitrum',
  sol: 'solana',
  solana: 'solana',
  '索拉纳': 'solana',
  tron: 'tron',
  trx: 'tron',
  '波场': 'tron',
};

const EVM_CONTEXT_HINTS: Array<{ chain: Chain; patterns: RegExp[] }> = [
  { chain: 'bsc', patterns: [/\bbsc\b/i, /\bbnb\b/i, /binance/i, /币安/i] },
  { chain: 'base', patterns: [/\bbase\b/i, /basescan/i] },
  { chain: 'arbitrum', patterns: [/\barb\b/i, /arbitrum/i, /arbiscan/i] },
  { chain: 'ethereum', patterns: [/\beth\b/i, /ethereum/i, /etherscan/i, /以太坊/i] },
];

const EXPLORER_PATTERNS: Array<{ chain: Chain; pattern: RegExp }> = [
  { chain: 'ethereum', pattern: /https?:\/\/(?:www\.)?etherscan\.io\/(?:address|token)\/(0x[a-fA-F0-9]{40})/gi },
  { chain: 'bsc', pattern: /https?:\/\/(?:www\.)?bscscan\.com\/(?:address|token)\/(0x[a-fA-F0-9]{40})/gi },
  { chain: 'base', pattern: /https?:\/\/(?:www\.)?basescan\.org\/(?:address|token)\/(0x[a-fA-F0-9]{40})/gi },
  { chain: 'arbitrum', pattern: /https?:\/\/(?:www\.)?arbiscan\.io\/(?:address|token)\/(0x[a-fA-F0-9]{40})/gi },
  { chain: 'solana', pattern: /https?:\/\/(?:www\.)?solscan\.io\/(?:token|account|address)\/([1-9A-HJ-NP-Za-km-z]{32,44})/gi },
  { chain: 'tron', pattern: /https?:\/\/(?:www\.)?tronscan\.org\/#\/(?:address|token20)\/(T[1-9A-HJ-NP-Za-km-z]{33})/gi },
];

/**
 * Detect chain from address format or user-specified prefix
 * Supported formats:
 *   - "eth:0x1234..." or "bsc:0x1234..." (explicit)
 *   - "0x1234..." (auto-detect via DexScreener API)
 *   - "So1ana..." (Solana base58 address)
 *   - "T..." (Tron address)
 */
export function detectChainAndAddress(input: string): AddressDetection | null {
  const trimmed = input.trim();

  // Check explicit chain prefix (e.g., "bsc:0x1234...")
  const prefixMatch = trimmed.match(/^([a-zA-Z\u4e00-\u9fa5]+)\s*:\s*(.+)$/i);
  if (prefixMatch) {
    const chainAlias = prefixMatch[1].toLowerCase();
    const address = prefixMatch[2].trim();
    const chain = resolveChainAlias(chainAlias);
    if (chain && isValidAddress(chain, address)) {
      return { chain, address };
    }
  }

  // Tron: starts with T, 34 chars
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) {
    return { chain: 'tron', address: trimmed };
  }

  // Solana: base58, 32-44 chars, no 0x prefix
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) && !trimmed.startsWith('0x')) {
    return { chain: 'solana', address: trimmed };
  }

  // EVM: 0x + 40 hex chars - mark for auto-detection
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    return { chain: 'ethereum', address: trimmed, needsAutoDetect: true };
  }

  return null;
}

/**
 * Auto-detect which EVM chain a contract is on.
 *
 * Strategy (multi-layer, parallel where possible):
 *   1. DexScreener search (cross-chain, baseToken match + highest liquidity)
 *   2. DexScreener token-pairs on ALL chains in PARALLEL (pick chain with most liquidity)
 *   3. Etherscan V2 contract existence check in PARALLEL (definitive on-chain proof)
 *   4. GeckoTerminal token lookup in PARALLEL
 *   5. Public RPC eth_getCode check for arbitrary non-token contracts
 *   6. Return null if the chain cannot be detected confidently
 */
export async function autoDetectEVMChain(address: string): Promise<Chain | null> {
  const chainsToTry: Array<Exclude<Chain, 'solana' | 'tron'>> = ['ethereum', 'bsc', 'base', 'arbitrum'];
  const addressLower = address.toLowerCase();

  const chainMap: Record<string, Chain> = {
    ethereum: 'ethereum',
    eth: 'ethereum',
    bsc: 'bsc',
    binance: 'bsc',
    base: 'base',
    arbitrum: 'arbitrum',
    solana: 'solana',
    tron: 'tron',
  };

  // ─── Strategy 1: DexScreener search (cross-chain discovery) ───
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${address}`, {
      timeout: 8000,
    });

    const pairs = res.data?.pairs;
    if (pairs && pairs.length > 0) {
      // Filter pairs where baseToken.address matches our queried address
      const matchingPairs = pairs.filter(
        (p: any) => p.baseToken?.address?.toLowerCase() === addressLower
      );

      if (matchingPairs.length > 0) {
        // Sort by liquidity descending to get the most relevant chain
        matchingPairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const chainId = matchingPairs[0].chainId?.toLowerCase();
        if (chainMap[chainId]) {
          console.log(`[ChainDetector] DexScreener search matched: ${chainId} (liquidity: $${matchingPairs[0].liquidity?.usd || 0})`);
          return chainMap[chainId];
        }
      }

      // If no baseToken match but pairs exist, only use if ALL pairs agree on the same chain
      const chainIds: string[] = [...new Set(pairs.map((p: any) => p.chainId?.toLowerCase()).filter(Boolean))] as string[];
      if (chainIds.length === 1 && chainMap[chainIds[0]]) {
        console.log(`[ChainDetector] DexScreener search fallback (all pairs on same chain): ${chainIds[0]}`);
        return chainMap[chainIds[0]];
      }
    }
  } catch (error: any) {
    console.error('[ChainDetector] DexScreener search failed:', error?.message || error);
  }

  // ─── Strategy 2: DexScreener token-pairs on ALL chains in PARALLEL ───
  try {
    const tokenPairsResults = await Promise.allSettled(
      chainsToTry.map(async (chain) => {
        const res = await axios.get(
          `https://api.dexscreener.com/token-pairs/v1/${chain}/${address}`,
          { timeout: 6000 }
        );
        const data = res.data;
        if (Array.isArray(data) && data.length > 0) {
          // Calculate total liquidity on this chain
          const totalLiquidity = data.reduce((sum: number, p: any) => sum + (p.liquidity?.usd || 0), 0);
          return { chain, pairCount: data.length, liquidity: totalLiquidity };
        }
        return null;
      })
    );

    // Collect successful results that found pairs
    const found: Array<{ chain: Chain; pairCount: number; liquidity: number }> = [];
    for (const result of tokenPairsResults) {
      if (result.status === 'fulfilled' && result.value) {
        found.push(result.value);
      }
    }

    if (found.length > 0) {
      // Pick the chain with the highest liquidity (most authoritative signal)
      found.sort((a, b) => b.liquidity - a.liquidity);
      console.log(`[ChainDetector] DexScreener token-pairs parallel: found on ${found.map(f => `${f.chain}($${f.liquidity})`).join(', ')} → picked ${found[0].chain}`);
      return found[0].chain;
    }
  } catch (error: any) {
    console.error('[ChainDetector] DexScreener token-pairs parallel failed:', error?.message || error);
  }

  // ─── Strategy 3: Public RPC bytecode check in PARALLEL ───
  // This is the key fallback for arbitrary non-token contracts.
  try {
    const rpcResults = await Promise.allSettled(
      chainsToTry.map(async (chain) => {
        const hasCode = await hasRuntimeCodeViaRPC(chain, address);
        return hasCode ? chain : null;
      })
    );

    const found: Chain[] = [];
    for (const result of rpcResults) {
      if (result.status === 'fulfilled' && result.value) {
        found.push(result.value);
      }
    }

    if (found.length === 1) {
      console.log(`[ChainDetector] Public RPC confirmed contract code on ${found[0]}`);
      return found[0];
    }

    if (found.length > 1) {
      console.warn(`[ChainDetector] Address has code on multiple chains (${found.join(', ')}), chain prefix required`);
      return null;
    }
  } catch (error: any) {
    console.error('[ChainDetector] Public RPC bytecode check failed:', error?.message || error);
  }

  // ─── Strategy 4: Etherscan V2 contract existence check in PARALLEL ───
  // This is the definitive on-chain check — if the contract was created on a chain, it exists there
  if (config.etherscan.apiKey) {
    try {
      const etherscanResults = await Promise.allSettled(
        chainsToTry.map(async (chain) => {
          const chainId = EVM_CHAIN_IDS[chain];
          if (!chainId) return null;
          const res = await axios.get(ETHERSCAN_V2_URL, {
            params: {
              chainid: chainId,
              module: 'contract',
              action: 'getcontractcreation',
              contractaddresses: address,
              apikey: config.etherscan.apiKey,
            },
            timeout: 8000,
          });
          // If result contains contract creation data, the contract exists on this chain
          if (res.data?.status === '1' && res.data?.result?.[0]?.contractCreator) {
            return { chain, creator: res.data.result[0].contractCreator };
          }
          return null;
        })
      );

      for (const result of etherscanResults) {
        if (result.status === 'fulfilled' && result.value) {
          console.log(`[ChainDetector] Etherscan V2 confirmed: contract exists on ${result.value.chain} (creator: ${result.value.creator})`);
          return result.value.chain;
        }
      }
    } catch (error: any) {
      console.error('[ChainDetector] Etherscan V2 check failed:', error?.message || error);
    }
  }

  // ─── Strategy 5: GeckoTerminal token lookup in PARALLEL ───
  try {
    const geckoResults = await Promise.allSettled(
      chainsToTry.map(async (chain) => {
        const network = chainConfigs[chain].geckoNetwork;
        const res = await axios.get(
          `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}`,
          { timeout: 6000 }
        );
        if (res.data?.data?.attributes?.name) {
          return { chain, name: res.data.data.attributes.name };
        }
        return null;
      })
    );

    for (const result of geckoResults) {
      if (result.status === 'fulfilled' && result.value) {
        console.log(`[ChainDetector] GeckoTerminal confirmed: ${result.value.name} on ${result.value.chain}`);
        return result.value.chain;
      }
    }
  } catch (error: any) {
    console.error('[ChainDetector] GeckoTerminal parallel check failed:', error?.message || error);
  }

  // ─── Last resort: do not guess. A wrong chain creates a misleading audit. ───
  console.warn(`[ChainDetector] Could not detect chain for ${address}`);
  return null;
}

async function hasRuntimeCodeViaRPC(chain: Exclude<Chain, 'solana' | 'tron'>, address: string): Promise<boolean | null> {
  for (const rpcUrl of EVM_RPC_URLS[chain]) {
    try {
      const res = await axios.post(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [address, 'latest'],
      }, {
        timeout: 6000,
        headers: { 'Content-Type': 'application/json' },
      });

      const code = res.data?.result;
      if (typeof code === 'string') {
        return code !== '0x' && code !== '0x0';
      }
    } catch (error: any) {
      console.warn(`[ChainDetector] RPC ${chain} ${rpcUrl} failed: ${error?.message || error}`);
    }
  }

  return null;
}

function resolveChainAlias(alias: string): Chain | null {
  return CHAIN_ALIASES[alias.toLowerCase()] || null;
}

function isValidAddress(chain: Chain, address: string): boolean {
  const config = chainConfigs[chain];
  return config.addressPattern.test(address);
}

function findEVMChainHint(text: string, start: number, end: number): Chain | null {
  const before = text.slice(Math.max(0, start - 48), start);
  const after = text.slice(end, Math.min(text.length, end + 48));
  const context = `${before} ${after}`;

  for (const hint of EVM_CONTEXT_HINTS) {
    if (hint.patterns.some(pattern => pattern.test(context))) {
      return hint.chain;
    }
  }

  return null;
}

function addDetection(results: AddressDetection[], detection: AddressDetection | null) {
  if (!detection) return;
  const key = `${detection.chain}:${detection.address.toLowerCase()}`;
  const exists = results.some(r => `${r.chain}:${r.address.toLowerCase()}` === key);
  if (!exists) results.push(detection);
}

function hasAnyChainForAddress(results: AddressDetection[], address: string): boolean {
  return results.some(r => r.address.toLowerCase() === address.toLowerCase());
}

/**
 * Extract all contract addresses from a message text
 */
export function extractAddresses(text: string): AddressDetection[] {
  const results: AddressDetection[] = [];

  // Match explicit prefixed addresses (chain:0xAddress or chain:SolanaAddr)
  const prefixedPattern = /(?:eth|ethereum|erc20|bsc|bnb|binance|base|arb|arbitrum|sol|solana|tron|trx|以太坊|币安|币安链|索拉纳|波场)\s*:\s*[a-zA-Z0-9]{32,66}/gi;
  let match;
  while ((match = prefixedPattern.exec(text)) !== null) {
    const detected = detectChainAndAddress(match[0]);
    addDetection(results, detected);
  }

  // Match common explorer links and bind the address to the explorer's chain.
  for (const { chain, pattern } of EXPLORER_PATTERNS) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      addDetection(results, { chain, address: match[1] });
    }
  }

  // Match EVM addresses
  const evmPattern = /0x[a-fA-F0-9]{40}/g;
  while ((match = evmPattern.exec(text)) !== null) {
    const address = match[0];
    const hintedChain = findEVMChainHint(text, match.index, match.index + address.length);
    if (hintedChain) {
      addDetection(results, { chain: hintedChain, address });
    } else if (!hasAnyChainForAddress(results, address)) {
      addDetection(results, detectChainAndAddress(address));
    }
  }

  // Match Tron addresses before Solana because Tron base58 addresses also look like Solana addresses.
  const tronPattern = /(?<![a-zA-Z0-9])T[1-9A-HJ-NP-Za-km-z]{33}(?![a-zA-Z0-9])/g;
  while ((match = tronPattern.exec(text)) !== null) {
    if (!hasAnyChainForAddress(results, match[0])) {
      addDetection(results, { chain: 'tron', address: match[0] });
    }
  }

  // Match Solana addresses (standalone base58 strings)
  const solPattern = /(?<![a-zA-Z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![a-zA-Z0-9])/g;
  while ((match = solPattern.exec(text)) !== null) {
    if (!match[0].startsWith('0x') && !hasAnyChainForAddress(results, match[0])) {
      const detected = detectChainAndAddress(match[0]);
      addDetection(results, detected);
    }
  }

  return results.sort((a, b) => text.indexOf(a.address) - text.indexOf(b.address));
}
