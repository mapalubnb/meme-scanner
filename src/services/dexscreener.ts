import axios from 'axios';
import { Chain } from '../types';

const BASE_URL = 'https://api.dexscreener.com';
const client = axios.create({ baseURL: BASE_URL, timeout: 10000 });

// DexScreener chain IDs mapping
const CHAIN_MAP: Record<Chain, string> = {
  ethereum: 'ethereum',
  bsc: 'bsc',
  base: 'base',
  arbitrum: 'arbitrum',
  solana: 'solana',
  tron: 'tron',
};

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  liquidity: { usd: number; base: number; quote: number };
  fdv: number;
  marketCap: number;
  volume: { h24: number; h6: number; h1: number; m5: number };
  priceChange: { h24: number; h6: number; h1: number; m5: number };
  txns: {
    h24: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    m5: { buys: number; sells: number };
  };
  pairCreatedAt: number;
}

export interface DexScreenerTokenInfo {
  pairs: DexScreenerPair[];
  tokenName?: string;
  tokenSymbol?: string;
  tokenImageUrl?: string;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: number;
  liquidityBase?: number;
  liquidityQuote?: number;
  volume24h?: number;
  volume1h?: number;
  volume5m?: number;
  pairCreatedAt?: string;
  buyCount24h?: number;
  sellCount24h?: number;
  buyCount1h?: number;
  sellCount1h?: number;
  priceChange24h?: number;
  priceChange1h?: number;
  priceChange5m?: number;
  dexUrl?: string;
  dexName?: string;
  dexVersion?: string;        // Pool version: "V2", "V3", "V4", "CLAMM", etc.
  dexFullName?: string;       // Combined: "PancakeSwap V2", "Uniswap V3", etc.
  pairAddress?: string;
  quoteTokenSymbol?: string;
  quoteTokenName?: string;
  priceNative?: string;
  // Social links
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  description?: string;
}

export class DexScreenerService {
  /**
   * Get token pairs by chain and token address
   * Primary endpoint for token data
   */
  async getTokenPairs(chain: Chain, tokenAddress: string): Promise<DexScreenerTokenInfo | null> {
    const chainId = CHAIN_MAP[chain];
    try {
      const res = await client.get(`/token-pairs/v1/${chainId}/${tokenAddress}`);
      const pairs: DexScreenerPair[] = res.data || [];

      if (!pairs.length) return null;

      // Sort by liquidity (highest first)
      pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const topPair = pairs[0];

      // Extract social links from pair info
      const info = (topPair as any).info;
      const socials: any[] = info?.socials || [];
      const websites: any[] = info?.websites || [];

      // Extract pool version from labels array (e.g., ["v2"], ["v3"], ["v4"], ["CLAMM"])
      const pairLabels: string[] = (topPair as any).labels || [];
      const versionLabel = pairLabels.find((l: string) => /^v\d+$/i.test(l) || /^CLAMM$/i.test(l));
      const dexVersion = versionLabel ? versionLabel.toUpperCase() : undefined;

      // Build full DEX name (e.g., "PancakeSwap V2", "Uniswap V3")
      const dexNameRaw = topPair.dexId || '';
      const dexDisplayName = this.formatDexName(dexNameRaw);
      const dexFullName = dexVersion ? `${dexDisplayName} ${dexVersion}` : dexDisplayName;

      return {
        pairs,
        tokenName: topPair.baseToken.name,
        tokenSymbol: topPair.baseToken.symbol,
        tokenImageUrl: info?.imageUrl || (topPair.baseToken as any).imageUrl || undefined,
        priceUsd: topPair.priceUsd,
        marketCap: topPair.marketCap,
        fdv: topPair.fdv,
        liquidity: topPair.liquidity?.usd,
        liquidityBase: topPair.liquidity?.base,
        liquidityQuote: topPair.liquidity?.quote,
        volume24h: topPair.volume?.h24,
        volume1h: topPair.volume?.h1,
        volume5m: topPair.volume?.m5,
        pairCreatedAt: topPair.pairCreatedAt
          ? new Date(topPair.pairCreatedAt).toISOString()
          : undefined,
        buyCount24h: topPair.txns?.h24?.buys,
        sellCount24h: topPair.txns?.h24?.sells,
        buyCount1h: topPair.txns?.h1?.buys,
        sellCount1h: topPair.txns?.h1?.sells,
        priceChange24h: topPair.priceChange?.h24,
        priceChange1h: topPair.priceChange?.h1,
        priceChange5m: topPair.priceChange?.m5,
        dexUrl: topPair.url,
        dexName: topPair.dexId,
        dexVersion,
        dexFullName,
        pairAddress: topPair.pairAddress,
        quoteTokenSymbol: topPair.quoteToken.symbol,
        quoteTokenName: topPair.quoteToken.name,
        priceNative: topPair.priceNative,
        // Socials
        website: websites[0]?.url || undefined,
        twitter: socials.find((s: any) => s.type === 'twitter')?.url || undefined,
        telegram: socials.find((s: any) => s.type === 'telegram')?.url || undefined,
        discord: socials.find((s: any) => s.type === 'discord')?.url || undefined,
        description: info?.description || undefined,
      };
    } catch (error) {
      console.error('[DexScreener] getTokenPairs error:', error);
      return null;
    }
  }


  /**
   * Format dexId into human-readable display name
   */
  private formatDexName(dexId: string): string {
    const nameMap: Record<string, string> = {
      uniswap: 'Uniswap',
      pancakeswap: 'PancakeSwap',
      sushiswap: 'SushiSwap',
      raydium: 'Raydium',
      orca: 'Orca',
      aerodrome: 'Aerodrome',
      baseswap: 'BaseSwap',
      camelot: 'Camelot',
      quickswap: 'QuickSwap',
      balancer: 'Balancer',
      curve: 'Curve',
      trader_joe: 'Trader Joe',
      fourmeme: 'Four.meme',
      pumpfun: 'Pump.fun',
      pumpswap: 'PumpSwap',
      moonshot: 'Moonshot',
      clanker: 'Clanker',
      'alien-base': 'Alien Base',
      thena: 'Thena',
      biswap: 'BiSwap',
      mdex: 'MDEX',
      julswap: 'JulSwap',
      meteora: 'Meteora',
      jupiter: 'Jupiter',
    };
    return nameMap[dexId.toLowerCase()] || dexId.charAt(0).toUpperCase() + dexId.slice(1);
  }
}
