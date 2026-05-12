import axios from 'axios';
import { Chain, LaunchpadInfo } from '../types';
import { EtherscanService } from './etherscan';
import { launchpadFactories } from '../config';

// ═══════════════════════════════════════════════════════════════
// DexScreener dexId → Launchpad mapping (PRIMARY detection method)
// ═══════════════════════════════════════════════════════════════

const DEXID_LAUNCHPAD_MAP: Record<string, { name: string; type: LaunchpadInfo['launchpadType'] }> = {
  // BSC
  fourmeme: { name: 'Four.meme', type: 'bonding_curve' },
  // Base
  clanker: { name: 'Clanker', type: 'bonding_curve' },
  wow: { name: 'wow.xyz', type: 'bonding_curve' },
  virtuals: { name: 'Virtuals Protocol', type: 'fairlaunch' },
  // Solana
  pumpfun: { name: 'Pump.fun', type: 'bonding_curve' },
  moonshot: { name: 'Moonshot', type: 'bonding_curve' },
  raydiumlaunchlab: { name: 'Raydium LaunchLab', type: 'bonding_curve' },
  'pump.fun': { name: 'Pump.fun', type: 'bonding_curve' },
  pumpswap: { name: 'PumpSwap', type: 'bonding_curve' },
  boopfun: { name: 'Boop.fun', type: 'bonding_curve' },
  letsbonk: { name: 'LetsBonk.fun', type: 'bonding_curve' },
  believe: { name: 'Believe.app', type: 'bonding_curve' },
  // Ethereum
  uniswapv3: { name: '', type: 'unknown' }, // Not a launchpad, skip
  // Multi-chain presale
  pinksale: { name: 'PinkSale', type: 'presale' },
  unicrypt: { name: 'Unicrypt', type: 'presale' },
};

// DexScreener pair labels that indicate a launchpad
const LABEL_LAUNCHPAD_MAP: Record<string, { name: string; type: LaunchpadInfo['launchpadType'] }> = {
  'pump.fun': { name: 'Pump.fun', type: 'bonding_curve' },
  'four.meme': { name: 'Four.meme', type: 'bonding_curve' },
  'fourmeme': { name: 'Four.meme', type: 'bonding_curve' },
  'clanker': { name: 'Clanker', type: 'bonding_curve' },
  'virtuals': { name: 'Virtuals Protocol', type: 'fairlaunch' },
  'moonshot': { name: 'Moonshot', type: 'bonding_curve' },
  'launchlab': { name: 'Raydium LaunchLab', type: 'bonding_curve' },
  'believe': { name: 'Believe.app', type: 'bonding_curve' },
  'boop': { name: 'Boop.fun', type: 'bonding_curve' },
  'letsbonk': { name: 'LetsBonk.fun', type: 'bonding_curve' },
};

// DexScreener pairAddress suffix patterns
const PAIR_ADDRESS_PATTERNS: Array<{ pattern: RegExp; name: string; type: LaunchpadInfo['launchpadType'] }> = [
  { pattern: /:4meme$/i, name: 'Four.meme', type: 'bonding_curve' },
  { pattern: /:pump$/i, name: 'Pump.fun', type: 'bonding_curve' },
];

// ═══════════════════════════════════════════════════════════════
// Known deployer/factory addresses (SECONDARY - for Etherscan fallback)
// ═══════════════════════════════════════════════════════════════

const LAUNCHPAD_DEPLOYERS: Record<string, { name: string; type: LaunchpadInfo['launchpadType']; chains: Chain[] }> = {
  // Solana
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': { name: 'Pump.fun', type: 'bonding_curve', chains: ['solana'] },
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg': { name: 'Pump.fun (Migration)', type: 'bonding_curve', chains: ['solana'] },
  'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM': { name: 'Pump.fun (Migration Legacy)', type: 'bonding_curve', chains: ['solana'] },
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': { name: 'PumpSwap', type: 'bonding_curve', chains: ['solana'] },
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG': { name: 'Moonshot', type: 'bonding_curve', chains: ['solana'] },
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj': { name: 'Raydium LaunchLab', type: 'bonding_curve', chains: ['solana'] },
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN': { name: 'Believe.app (Meteora DBC)', type: 'bonding_curve', chains: ['solana'] },
  '5qWya6UjwWnGVhdSBL3hyZ7B45jbk6Byt1hwd7ohEGXE': { name: 'Believe.app', type: 'bonding_curve', chains: ['solana'] },
  'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1': { name: 'LetsBonk.fun', type: 'bonding_curve', chains: ['solana'] },
  'boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4': { name: 'Boop.fun', type: 'bonding_curve', chains: ['solana'] },
  // BSC
  '0x5c952063c7fc8610ffdb798152d69f0b9550762b': { name: 'Four.meme', type: 'bonding_curve', chains: ['bsc'] },
  // Base
  '0xe85a59c628f7d27878aceb4bf3b35733630083a9': { name: 'Clanker v4', type: 'bonding_curve', chains: ['base'] },
  '0xd9acd656a5f1b519c9e76a2a6092265a74186e58': { name: 'Clanker v3', type: 'bonding_curve', chains: ['base'] },
  '0x2a787b2362021cc3eea3c24c4748a6cd5b687382': { name: 'Clanker (Factory)', type: 'bonding_curve', chains: ['base'] },
  '0x250c9fb2b411b48273f69879007803790a6aea47': { name: 'Clanker (SocialDex)', type: 'bonding_curve', chains: ['base'] },
  '0xcf205808ed36593aa40a44f10c7f7c2f67d4a4d4': { name: 'friend.tech', type: 'bonding_curve', chains: ['base'] },
  '0x97cf38bb06da57b6418083998b09976ec40a90a3': { name: 'Virtuals Protocol', type: 'fairlaunch', chains: ['base'] },
  // Multi-chain presale
  '0x7ee058420e5937496f5a2096f04caa7721cf70cc': { name: 'PinkSale', type: 'presale', chains: ['ethereum', 'bsc', 'base', 'arbitrum'] },
  '0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214': { name: 'Unicrypt', type: 'presale', chains: ['ethereum', 'bsc'] },
  '0x81e9a68d020ff2e7e49ec5a23b3a227133ad0e74': { name: 'DxSale', type: 'presale', chains: ['ethereum', 'bsc'] },
};

export class LaunchpadService {
  private etherscanService: EtherscanService;

  constructor() {
    this.etherscanService = new EtherscanService();
  }

  /**
   * Detect if a contract was deployed from a known launchpad
   * Strategy priority:
   *   1. DexScreener dexId / labels / pairAddress patterns (free, reliable, all chains)
   *   2. GeckoTerminal launchpad_details (free, provides graduation info)
   *   3. Etherscan contract creator lookup (may fail on free tier for non-ETH chains)
   *   4. Solana: RugCheck creator/market programId
   */
  async detectLaunchpad(chain: Chain, address: string): Promise<LaunchpadInfo> {
    // Strategy 1: DexScreener-based detection (works for all chains)
    const dexResult = await this.detectViaDexScreener(chain, address);
    if (dexResult.isFromLaunchpad) {
      return dexResult;
    }

    // Strategy 2: GeckoTerminal launchpad_details
    const geckoResult = await this.detectViaGeckoTerminal(chain, address);
    if (geckoResult.isFromLaunchpad) {
      return geckoResult;
    }

    // Strategy 3: Etherscan contract creator (EVM only, may fail on free tier)
    if (chain !== 'solana' && chain !== 'tron') {
      const etherscanResult = await this.detectViaEtherscan(chain, address);
      if (etherscanResult.isFromLaunchpad) {
        return etherscanResult;
      }
    }

    // Strategy 4: Solana-specific - RugCheck
    if (chain === 'solana') {
      const rugResult = await this.detectViaSolanaRugCheck(address);
      if (rugResult.isFromLaunchpad) {
        return rugResult;
      }
    }

    return { isFromLaunchpad: false, confidence: 50 };
  }

  /**
   * Strategy 1: DexScreener dexId + labels + pairAddress pattern detection
   * Most reliable method - works across all chains without API key restrictions
   */
  private async detectViaDexScreener(chain: Chain, address: string): Promise<LaunchpadInfo> {
    const chainId: Record<Chain, string> = {
      ethereum: 'ethereum', bsc: 'bsc', base: 'base', arbitrum: 'arbitrum', solana: 'solana', tron: 'tron',
    };

    try {
      const res = await axios.get(`https://api.dexscreener.com/token-pairs/v1/${chainId[chain]}/${address}`, {
        timeout: 8000,
      });

      const pairs = res.data;
      if (!Array.isArray(pairs) || pairs.length === 0) {
        return { isFromLaunchpad: false, confidence: 30 };
      }

      // Check ALL pairs (not just the first one) — the launchpad pair might not be the highest liquidity
      for (const pair of pairs) {
        const dexId = (pair.dexId || '').toLowerCase();
        const labels: string[] = (pair.labels || []).map((l: string) => l.toLowerCase());
        const pairAddress: string = pair.pairAddress || '';

        // Method A: dexId direct match
        const dexMatch = DEXID_LAUNCHPAD_MAP[dexId];
        if (dexMatch && dexMatch.name) {
          console.log(`[Launchpad] DexScreener dexId match: "${dexId}" → ${dexMatch.name}`);
          return {
            isFromLaunchpad: true,
            launchpadName: dexMatch.name,
            launchpadType: dexMatch.type,
            confidence: 95,
          };
        }

        // Method B: labels match
        for (const label of labels) {
          const labelMatch = LABEL_LAUNCHPAD_MAP[label];
          if (labelMatch) {
            console.log(`[Launchpad] DexScreener label match: "${label}" → ${labelMatch.name}`);
            return {
              isFromLaunchpad: true,
              launchpadName: labelMatch.name,
              launchpadType: labelMatch.type,
              confidence: 90,
            };
          }
        }

        // Method C: pairAddress pattern match (e.g., "0x....:4meme")
        for (const { pattern, name, type } of PAIR_ADDRESS_PATTERNS) {
          if (pattern.test(pairAddress)) {
            console.log(`[Launchpad] DexScreener pairAddress pattern match: "${pairAddress}" → ${name}`);
            return {
              isFromLaunchpad: true,
              launchpadName: name,
              launchpadType: type,
              confidence: 90,
            };
          }
        }
      }

      // Method D: Check DexScreener "source" field (some pairs expose this)
      for (const pair of pairs) {
        const source = (pair.source || '').toLowerCase();
        if (source.includes('pump')) {
          return { isFromLaunchpad: true, launchpadName: 'Pump.fun', launchpadType: 'bonding_curve', confidence: 85 };
        }
        if (source.includes('four') || source.includes('4meme')) {
          return { isFromLaunchpad: true, launchpadName: 'Four.meme', launchpadType: 'bonding_curve', confidence: 85 };
        }
        if (source.includes('believe')) {
          return { isFromLaunchpad: true, launchpadName: 'Believe.app', launchpadType: 'bonding_curve', confidence: 85 };
        }
        if (source.includes('boop')) {
          return { isFromLaunchpad: true, launchpadName: 'Boop.fun', launchpadType: 'bonding_curve', confidence: 85 };
        }
        if (source.includes('bonk') || source.includes('letsbonk')) {
          return { isFromLaunchpad: true, launchpadName: 'LetsBonk.fun', launchpadType: 'bonding_curve', confidence: 85 };
        }
      }
    } catch (error: any) {
      console.warn('[Launchpad] DexScreener detection failed:', error?.message || error);
    }

    return { isFromLaunchpad: false, confidence: 30 };
  }

  /**
   * Strategy 2: GeckoTerminal launchpad_details detection
   * Provides graduation status and migrated pool info
   */
  private async detectViaGeckoTerminal(chain: Chain, address: string): Promise<LaunchpadInfo> {
    const networkMap: Record<Chain, string> = {
      ethereum: 'eth', bsc: 'bsc', base: 'base', arbitrum: 'arbitrum', solana: 'solana', tron: 'tron',
    };

    try {
      const res = await axios.get(
        `https://api.geckoterminal.com/api/v2/networks/${networkMap[chain]}/tokens/${address}`,
        { timeout: 8000 }
      );

      const attributes = res.data?.data?.attributes;
      if (attributes?.launchpad_details) {
        const lp = attributes.launchpad_details;
        console.log(`[Launchpad] GeckoTerminal launchpad_details found: graduated=${lp.completed}`);

        // Infer launchpad name by chain (GeckoTerminal doesn't name the launchpad explicitly)
        let launchpadName = 'Unknown Launchpad';
        if (chain === 'bsc') launchpadName = 'Four.meme';
        else if (chain === 'solana') launchpadName = 'Bonding Curve Launchpad';
        else if (chain === 'base') launchpadName = 'Clanker';

        return {
          isFromLaunchpad: true,
          launchpadName,
          launchpadType: 'bonding_curve',
          confidence: 80,
        };
      }
    } catch (error: any) {
      // Non-critical, GeckoTerminal might rate-limit
      console.warn('[Launchpad] GeckoTerminal detection failed:', error?.message || error);
    }

    return { isFromLaunchpad: false, confidence: 30 };
  }

  /**
   * Strategy 3: Etherscan contract creator address matching
   * Only works reliably on Ethereum mainnet with free tier
   */
  private async detectViaEtherscan(chain: Chain, address: string): Promise<LaunchpadInfo> {
    try {
      const creation = await this.etherscanService.getContractCreation(chain, address);

      if (creation?.contractCreator) {
        const creator = creation.contractCreator.toLowerCase();

        // Check against known deployer addresses
        for (const [deployerAddr, info] of Object.entries(LAUNCHPAD_DEPLOYERS)) {
          if (creator === deployerAddr.toLowerCase() && info.chains.includes(chain)) {
            console.log(`[Launchpad] Etherscan creator match: ${creator} → ${info.name}`);
            return {
              isFromLaunchpad: true,
              launchpadName: info.name,
              launchpadType: info.type,
              confidence: 95,
            };
          }
        }

        // Check configurable factory list
        for (const [factoryAddr, info] of Object.entries(launchpadFactories)) {
          if (info.chains.includes(chain) && creator === factoryAddr.toLowerCase()) {
            return {
              isFromLaunchpad: true,
              launchpadName: info.name,
              launchpadType: 'unknown',
              confidence: 90,
            };
          }
        }
      }
    } catch (error: any) {
      // Expected to fail on BSC/Base/Arbitrum with free tier - not an error
      console.warn(`[Launchpad] Etherscan lookup unavailable for ${chain}: ${error?.message || error}`);
    }

    return { isFromLaunchpad: false, confidence: 30 };
  }

  /**
   * Strategy 4: Solana-specific RugCheck creator/market detection
   */
  private async detectViaSolanaRugCheck(address: string): Promise<LaunchpadInfo> {
    try {
      const rugRes = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${address}/report`, {
        timeout: 8000,
      });
      const rugData = rugRes.data;

      // Check creator address
      if (rugData?.creator) {
        const creator = rugData.creator;
        for (const [deployerAddr, info] of Object.entries(LAUNCHPAD_DEPLOYERS)) {
          if (info.chains.includes('solana') && creator === deployerAddr) {
            console.log(`[Launchpad] RugCheck creator match: ${creator} → ${info.name}`);
            return {
              isFromLaunchpad: true,
              launchpadName: info.name,
              launchpadType: info.type,
              confidence: 95,
            };
          }
        }
      }

      // Check market programIds
      if (rugData?.markets) {
        for (const market of rugData.markets) {
          const programId = market.programId || market.marketType;
          if (programId) {
            for (const [deployerAddr, info] of Object.entries(LAUNCHPAD_DEPLOYERS)) {
              if (info.chains.includes('solana') && programId === deployerAddr) {
                console.log(`[Launchpad] RugCheck market programId match: ${programId} → ${info.name}`);
                return {
                  isFromLaunchpad: true,
                  launchpadName: info.name,
                  launchpadType: info.type,
                  confidence: 85,
                };
              }
            }
          }
        }
      }
    } catch (error: any) {
      console.warn('[Launchpad] RugCheck detection failed:', error?.message || error);
    }

    return { isFromLaunchpad: false, confidence: 30 };
  }
}
