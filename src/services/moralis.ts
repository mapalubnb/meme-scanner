import axios from 'axios';
import { Chain } from '../types';

// Moralis EVM API
// Docs: https://docs.moralis.com/web3-data-api/evm
// Free tier: 40,000 CU/day, ~25 req/sec
const BASE_URL = 'https://deep-index.moralis.io/api/v2.2';

// Moralis chain hex IDs
const CHAIN_MAP: Record<Chain, string | null> = {
  ethereum: '0x1',
  bsc: '0x38',
  base: '0x2105',
  arbitrum: '0xa4b1',
  solana: null,   // Moralis has separate Solana API
  tron: null,     // Not supported
};

export interface TokenHolder {
  holderAddress: string;
  balance: string;
  balanceFormatted: string;
  percentageOfTotal: number;
  usdValue?: string;
  isContract?: boolean;
}

export interface HolderStats {
  totalHolders: number;
  holderChange24h?: number;
  topHolders: TokenHolder[];
  top10Concentration: number;  // percentage held by top 10
  top20Concentration: number;
  top50Concentration: number;
}

export class MoralisService {
  private client: any;

  constructor(apiKey: string) {
    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: 15000,
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json',
      },
    });
  }

  /**
   * Get token logo URL from Moralis metadata
   */
  async getTokenLogo(chain: Chain, tokenAddress: string): Promise<string | null> {
    const chainHex = CHAIN_MAP[chain];
    if (!chainHex) return null;

    try {
      const res = await this.client.get(`/erc20/metadata`, {
        params: {
          chain: chainHex,
          addresses: [tokenAddress],
        },
      });
      const meta = res.data?.[0];
      return meta?.logo || meta?.thumbnail || null;
    } catch {
      return null;
    }
  }

  /**
   * Get token total supply via Moralis metadata endpoint
   */
  private async getTokenTotalSupply(chain: Chain, tokenAddress: string): Promise<number | null> {
    const chainHex = CHAIN_MAP[chain];
    if (!chainHex) return null;

    try {
      const res = await this.client.get(`/erc20/metadata`, {
        params: {
          chain: chainHex,
          addresses: [tokenAddress],
        },
      });

      const meta = res.data?.[0];
      if (meta?.total_supply && meta?.decimals) {
        const decimals = parseInt(meta.decimals);
        const rawSupply = meta.total_supply;
        // Convert raw supply to human-readable using decimals
        const supply = parseFloat(rawSupply) / Math.pow(10, decimals);
        console.log(`[Moralis] Total supply for ${tokenAddress}: ${supply} (decimals: ${decimals})`);
        return supply;
      }
      // Try total_supply_formatted if available
      if (meta?.total_supply_formatted) {
        return parseFloat(meta.total_supply_formatted);
      }
      return null;
    } catch (error: any) {
      console.error('[Moralis] getTokenTotalSupply error:', error?.response?.data || error.message);
      return null;
    }
  }

  /**
   * Get top token holders with concentration analysis
   * Uses total supply as denominator for accurate percentage calculation
   */
  async getTokenHolders(chain: Chain, tokenAddress: string, limit: number = 50): Promise<HolderStats | null> {
    const chainHex = CHAIN_MAP[chain];
    if (!chainHex) {
      console.log(`[Moralis] Chain ${chain} not supported for holder analysis`);
      return null;
    }

    try {
      // Fetch holders and total supply in parallel
      // getHolderStats is called separately to avoid breaking Promise.all if it fails
      const [holdersRes, totalSupply] = await Promise.all([
        this.client.get(`/erc20/${tokenAddress}/owners`, {
          params: {
            chain: chainHex,
            limit,
            order: 'DESC',
          },
        }),
        this.getTokenTotalSupply(chain, tokenAddress),
      ]);

      // Try to get holder stats (non-critical, won't break if fails)
      let holderStats: { totalHolders: number; change24h?: number } | null = null;
      try {
        holderStats = await this.getHolderStats(chain, tokenAddress);
      } catch (e: any) {
        console.warn('[Moralis] getHolderStats failed (non-critical):', e?.message);
      }

      console.log('[Moralis] Raw holder sample:', JSON.stringify(holdersRes.data?.result?.[0] || null).slice(0, 300));
      console.log('[Moralis] Total supply:', totalSupply);

      const holders: any[] = holdersRes.data?.result || [];
      if (!holders.length) return null;

      const topHolders: TokenHolder[] = holders.map((h: any) => {
        // Try Moralis's built-in percentage field first
        let pct = 0;
        if (h.percentage_relative_to_total_supply) {
          pct = parseFloat(h.percentage_relative_to_total_supply);
          // Moralis returns this as a percentage already (e.g., 5.23 means 5.23%)
          // But some versions return as decimal (0.0523 means 5.23%)
          // Detect: if all values < 1 and we have totalSupply, it's likely decimal form
        } else if (h.percentage) {
          pct = parseFloat(h.percentage);
        }

        return {
          holderAddress: h.owner_address,
          balance: h.balance,
          balanceFormatted: h.balance_formatted,
          percentageOfTotal: pct,
          usdValue: h.usd_value,
          isContract: h.is_contract,
        };
      });

      // Validate: if percentages look wrong (sum > 100% for top holders), recalculate
      const sumTop10 = topHolders.slice(0, 10).reduce((sum, h) => sum + h.percentageOfTotal, 0);
      const needsRecalculation = topHolders.every(h => h.percentageOfTotal === 0) || sumTop10 > 100;

      if (needsRecalculation) {
        console.log(`[Moralis] Percentage data invalid (sum top10=${sumTop10.toFixed(2)}%), recalculating from balances...`);

        // Use total supply from metadata API as the correct denominator
        let denominator = totalSupply;

        if (!denominator || denominator <= 0) {
          // Last resort: estimate total from holder count ratio
          // If we have 30 holders out of N total, the returned holders represent a portion
          // This is still inaccurate but better than summing only returned holders
          console.warn('[Moralis] No total supply available, using balance_formatted sum as fallback (may be inaccurate)');
          // Sum all returned holders as a rough denominator - but cap percentages at 100%
          const useFormatted = holders.some(h => h.balance_formatted && parseFloat(h.balance_formatted) > 0);
          denominator = holders.reduce((sum, h) => {
            const val = useFormatted
              ? parseFloat(h.balance_formatted || '0')
              : parseFloat(h.balance || '0');
            return sum + (isNaN(val) ? 0 : val);
          }, 0);
        }

        if (denominator && denominator > 0) {
          const useFormatted = holders.some(h => h.balance_formatted && parseFloat(h.balance_formatted) > 0);

          topHolders.forEach(h => {
            const bal = useFormatted
              ? parseFloat(h.balanceFormatted || '0')
              : parseFloat(h.balance || '0');
            const rawPct = ((isNaN(bal) ? 0 : bal) / denominator!) * 100;
            // Sanity check: no single holder should exceed 100%
            h.percentageOfTotal = Math.min(rawPct, 100);
          });
        }
      } else {
        // Check if values are in decimal form (all < 1 means they need *100)
        const allLessThanOne = topHolders.every(h => h.percentageOfTotal > 0 && h.percentageOfTotal < 1);
        if (allLessThanOne) {
          topHolders.forEach(h => {
            h.percentageOfTotal = h.percentageOfTotal * 100;
          });
        }
      }

      // Sort by percentage descending
      topHolders.sort((a, b) => b.percentageOfTotal - a.percentageOfTotal);

      // Sanity check: cap concentrations at 100%
      const top10 = Math.min(topHolders.slice(0, 10).reduce((sum, h) => sum + h.percentageOfTotal, 0), 100);
      const top20 = Math.min(topHolders.slice(0, 20).reduce((sum, h) => sum + h.percentageOfTotal, 0), 100);
      const top50 = Math.min(topHolders.reduce((sum, h) => sum + h.percentageOfTotal, 0), 100);

      // Use holder stats API for real total count
      // Do NOT fallback to holders.length as it equals the limit param (misleading)
      // If stats API doesn't return a count, use 0 as placeholder - analyzer will override with GoPlus
      const realTotal = holderStats?.totalHolders || 0;
      console.log(`[Moralis] Total holders resolved: ${realTotal} (from stats API: ${holderStats?.totalHolders || 'unavailable'})`);
      if (realTotal === 0) {
        console.log('[Moralis] Note: totalHolders=0 means stats unavailable; analyzer should use GoPlus holderCount');
      }

      return {
        totalHolders: realTotal,
        holderChange24h: holderStats?.change24h,
        topHolders,
        top10Concentration: Math.round(top10 * 100) / 100,
        top20Concentration: Math.round(top20 * 100) / 100,
        top50Concentration: Math.round(top50 * 100) / 100,
      };
    } catch (error: any) {
      console.error('[Moralis] getTokenHolders error:', error?.response?.data || error.message);
      return null;
    }
  }

  /**
   * Get token holder count and stats
   * Strategy:
   *   1. Try /erc20/{address}/owners with limit=1 to get pagination total (if available)
   *   2. Try the token analytics endpoint (Moralis Business tier)
   *   3. Fallback: return null and let GoPlus holderCount be used
   */
  async getHolderStats(chain: Chain, tokenAddress: string): Promise<{ totalHolders: number; change24h?: number } | null> {
    const chainHex = CHAIN_MAP[chain];
    if (!chainHex) return null;

    // Strategy 1: Use /owners endpoint with limit=1 to check for total in response
    try {
      const res = await this.client.get(`/erc20/${tokenAddress}/owners`, {
        params: {
          chain: chainHex,
          limit: 1,
          order: 'DESC',
        },
      });

      console.log('[Moralis] Holder stats response keys:', Object.keys(res.data || {}));

      // Some Moralis responses include a 'total' field in pagination
      if (res.data?.total) {
        const total = typeof res.data.total === 'string' ? parseInt(res.data.total) : res.data.total;
        console.log(`[Moralis] Total holders from pagination: ${total}`);
        return { totalHolders: total };
      }

      // Check if cursor exists - if so, there are more pages (at least > 1)
      // Without a total field, we can't determine exact count from this endpoint
      console.log('[Moralis] No total field in /owners response, will rely on GoPlus holderCount');
      return null;
    } catch (error: any) {
      console.error('[Moralis] getHolderStats error:', error?.response?.status, error?.response?.data?.message || error.message);
      return null;
    }
  }

}
