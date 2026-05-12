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

/**
 * Detect chain from address format or user-specified prefix
 * Supported formats:
 *   - "eth:0x1234..." or "bsc:0x1234..." (explicit)
 *   - "0x1234..." (auto-detect via DexScreener API)
 *   - "So1ana..." (Solana base58 address)
 *   - "T..." (Tron address)
 */
export function detectChainAndAddress(input: string): { chain: Chain; address: string; needsAutoDetect?: boolean } | null {
  const trimmed = input.trim();

  // Check explicit chain prefix (e.g., "bsc:0x1234...")
  const prefixMatch = trimmed.match(/^(eth|ethereum|bsc|base|arb|arbitrum|sol|solana|tron):(.+)$/i);
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
 *   5. Default to 'ethereum' only if all methods fail
 */
export async function autoDetectEVMChain(address: string): Promise<Chain> {
  const chainsToTry: Chain[] = ['ethereum', 'bsc', 'base', 'arbitrum'];
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

  // ─── Strategy 3: Etherscan V2 contract existence check in PARALLEL ───
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

  // ─── Strategy 4: GeckoTerminal token lookup in PARALLEL ───
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

  // ─── Last resort: default to ethereum ───
  console.warn(`[ChainDetector] Could not detect chain for ${address}, defaulting to ethereum`);
  return 'ethereum';
}

function resolveChainAlias(alias: string): Chain | null {
  const map: Record<string, Chain> = {
    eth: 'ethereum',
    ethereum: 'ethereum',
    bsc: 'bsc',
    base: 'base',
    arb: 'arbitrum',
    arbitrum: 'arbitrum',
    sol: 'solana',
    solana: 'solana',
    tron: 'tron',
  };
  return map[alias] || null;
}

function isValidAddress(chain: Chain, address: string): boolean {
  const config = chainConfigs[chain];
  return config.addressPattern.test(address);
}

/**
 * Extract all contract addresses from a message text
 */
export function extractAddresses(text: string): Array<{ chain: Chain; address: string; needsAutoDetect?: boolean }> {
  const results: Array<{ chain: Chain; address: string; needsAutoDetect?: boolean }> = [];

  // Match explicit prefixed addresses (chain:0xAddress or chain:SolanaAddr)
  const prefixedPattern = /(?:eth|ethereum|bsc|base|arb|arbitrum|sol|solana|tron):[a-zA-Z0-9]{32,66}/gi;
  let match;
  while ((match = prefixedPattern.exec(text)) !== null) {
    const detected = detectChainAndAddress(match[0]);
    if (detected) results.push(detected);
  }

  // Match EVM addresses
  const evmPattern = /0x[a-fA-F0-9]{40}/g;
  while ((match = evmPattern.exec(text)) !== null) {
    if (!results.find(r => r.address.toLowerCase() === match![0].toLowerCase())) {
      const detected = detectChainAndAddress(match[0]);
      if (detected) results.push(detected);
    }
  }

  // Match Solana addresses (standalone base58 strings)
  const solPattern = /(?<![a-zA-Z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![a-zA-Z0-9])/g;
  while ((match = solPattern.exec(text)) !== null) {
    if (!match[0].startsWith('0x') && !results.find(r => r.address === match![0])) {
      const detected = detectChainAndAddress(match[0]);
      if (detected) results.push(detected);
    }
  }

  return results;
}
