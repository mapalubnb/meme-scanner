import { Chain, ContractAnalysis } from '../types';
import { config } from '../config';
import { GeckoTerminalService } from './geckoTerminal';
import { DexScreenerService } from './dexscreener';
import { GoPlusService } from './goplus';
import { RugCheckService } from './rugcheck';
import { EtherscanService } from './etherscan';
import { LaunchpadService } from './launchpad';
import { MoralisService } from './moralis';
import { DeepSeekService } from './deepseek';

export class ContractAnalyzer {
  private gecko: GeckoTerminalService;
  private dexscreener: DexScreenerService;
  private goplus: GoPlusService;
  private rugcheck: RugCheckService;
  private etherscan: EtherscanService;
  private launchpad: LaunchpadService;
  private moralis: MoralisService;
  private deepseek: DeepSeekService;

  constructor() {
    this.gecko = new GeckoTerminalService();
    this.dexscreener = new DexScreenerService();
    this.goplus = new GoPlusService();
    this.rugcheck = new RugCheckService();
    this.etherscan = new EtherscanService();
    this.launchpad = new LaunchpadService();
    this.moralis = new MoralisService(config.moralis.apiKey);
    this.deepseek = new DeepSeekService();
  }

  /**
   * Phase 1: Collect all on-chain data (fast, no AI)
   * Returns result without aiAnalysis field
   */
  async analyzeData(chain: Chain, address: string): Promise<ContractAnalysis> {
    console.log(`[Analyzer] Starting data collection: ${chain}:${address}`);
    const result: ContractAnalysis = { chain, address };

    // Step 1: Market data (GeckoTerminal primary, DexScreener fallback)
    await this.fetchMarketData(chain, address, result);

    // Step 2: Security analysis (GoPlus + RugCheck for Solana)
    await this.fetchSecurityData(chain, address, result);

    // Step 3: Holder analysis (Moralis - EVM only)
    await this.fetchHolderData(chain, address, result);

    // Step 4: Launchpad detection + deployment time (parallel)
    const [launchpadResult, deployTime] = await Promise.allSettled([
      this.launchpad.detectLaunchpad(chain, address),
      (chain !== 'solana' && chain !== 'tron') ? this.etherscan.getDeploymentTime(chain, address) : Promise.resolve(null),
    ]);

    if (launchpadResult.status === 'fulfilled' && launchpadResult.value) {
      result.launchpad = launchpadResult.value;
    }
    if (deployTime.status === 'fulfilled' && deployTime.value) {
      result.deployedAt = deployTime.value;
    }

    // Step 4.5: Token image & socials fallback
    if (!result.tokenImageUrl && chain !== 'solana' && chain !== 'tron') {
      try {
        const logo = await this.moralis.getTokenLogo(chain, address);
        if (logo) result.tokenImageUrl = logo;
      } catch {
        // Non-critical
      }
    }

    // Step 4.6: Fetch socials from GeckoTerminal if not available from DexScreener
    if (!result.socials) {
      try {
        const metadata = await this.gecko.getTokenMetadata(chain, address);
        if (metadata?.attributes) {
          const attr = metadata.attributes;
          const hasSocials = attr.websites?.length || attr.twitter_handle || attr.telegram_handle || attr.discord_url;
          if (hasSocials) {
            result.socials = {
              website: attr.websites?.[0]?.url || attr.websites?.[0] || undefined,
              twitter: attr.twitter_handle ? `https://twitter.com/${attr.twitter_handle}` : undefined,
              telegram: attr.telegram_handle ? `https://t.me/${attr.telegram_handle}` : undefined,
              discord: attr.discord_url || undefined,
              description: attr.description || undefined,
            };
          }
        }
      } catch {
        // Non-critical
      }
    }

    // Step 5: Contract source (EVM only)
    if (chain !== 'solana' && chain !== 'tron') {
      try {
        const source = await this.etherscan.getContractSource(chain, address);
        if (source) {
          result.contractSource = source;

          // Step 5.5: Tax distribution analysis (only if token has tax)
          const buyTax = parseFloat(result.security?.buyTax || '0');
          const sellTax = parseFloat(result.security?.sellTax || '0');
          if ((buyTax > 0 || sellTax > 0) && source.sourceCode) {
            try {
              const taxInfo = this.etherscan.analyzeTaxDistribution(source.sourceCode, source.abi);
              if (taxInfo) {
                taxInfo.totalBuyTax = result.security?.buyTax || '0';
                taxInfo.totalSellTax = result.security?.sellTax || '0';
                result.taxDistribution = taxInfo;
                console.log(`[Analyzer] Tax distribution detected: ${taxInfo.destinations.length} destinations, burn=${taxInfo.hasBurn}, reflection=${taxInfo.hasReflection}, autoLP=${taxInfo.hasAutoLP}`);
              }
            } catch (taxError) {
              console.error('[Analyzer] Tax analysis error:', taxError);
            }
          }
        }
      } catch (error) {
        console.error('[Analyzer] Etherscan error:', error);
      }
    }

    // Step 6: Ownership renounce verification + LP lock check (EVM only, parallel)
    if (chain !== 'solana' && chain !== 'tron') {
      try {
        const ownerAddr = result.security?.ownerAddress;
        const isZeroOwner = ownerAddr === '0x0000000000000000000000000000000000000000';

        // Run both checks in parallel
        const parallelChecks: Promise<any>[] = [];

        // Ownership verification: only verify if owner appears to be zero/renounced
        if (isZeroOwner) {
          parallelChecks.push(
            this.etherscan.verifyOwnershipRenounced(chain, address)
              .then(res => { result.ownershipStatus = { ...res, verifiedOnChain: res.renounced }; })
              .catch(err => console.error('[Analyzer] Ownership verify error:', err))
          );
        } else {
          result.ownershipStatus = { renounced: false, verifiedOnChain: false };
        }

        // LP lock check: if we have LP holder addresses from GoPlus
        const lpHolders = result.security?.lpHolders;
        if (lpHolders && lpHolders.length > 0) {
          // The first LP holder's pair address is the LP token
          const topLpPairAddr = result.rawData?.dexscreener?.pairAddress;
          if (topLpPairAddr) {
            parallelChecks.push(
              this.etherscan.checkLPLocks(chain, topLpPairAddr)
                .then(lockInfo => { if (lockInfo) result.lpLock = lockInfo; })
                .catch(err => console.error('[Analyzer] LP lock check error:', err))
            );
          }
        }

        if (parallelChecks.length > 0) {
          await Promise.allSettled(parallelChecks);
        }
      } catch (error) {
        console.error('[Analyzer] Ownership/LP lock check error:', error);
      }
    }

    console.log(`[Analyzer] Data collection complete: ${chain}:${address}`);
    return result;
  }

  /**
   * Phase 2: Run AI analysis on already-collected data
   */
  async analyzeAI(result: ContractAnalysis): Promise<string> {
    try {
      const aiResult = await this.deepseek.analyzeContract(result);
      return aiResult;
    } catch (error) {
      console.error('[Analyzer] DeepSeek error:', error);
      return '分析暂时不可用';
    }
  }

  /**
   * Extract DexScreener trading metrics into a flat object for rawData storage
   */
  private extractDexMetrics(dexData: any): Record<string, any> {
    return {
      buyCount24h: dexData.buyCount24h,
      sellCount24h: dexData.sellCount24h,
      buyCount1h: dexData.buyCount1h,
      sellCount1h: dexData.sellCount1h,
      priceChange24h: dexData.priceChange24h,
      priceChange1h: dexData.priceChange1h,
      priceChange5m: dexData.priceChange5m,
      volume1h: dexData.volume1h,
      volume5m: dexData.volume5m,
      pairCount: dexData.pairs.length,
      dexUrl: dexData.dexUrl,
      dexName: dexData.dexName,
      dexVersion: dexData.dexVersion,
      dexFullName: dexData.dexFullName,
      pairAddress: dexData.pairAddress,
      quoteTokenSymbol: dexData.quoteTokenSymbol,
      quoteTokenName: dexData.quoteTokenName,
      liquidityBase: dexData.liquidityBase,
      liquidityQuote: dexData.liquidityQuote,
      priceNative: dexData.priceNative,
    };
  }

  /**
   * Step 1: Fetch market data
   * Try GeckoTerminal first, fallback to DexScreener
   */
  private async fetchMarketData(chain: Chain, address: string, result: ContractAnalysis) {
    let dataFetched = false;

    // Try GeckoTerminal first
    try {
      const tokenInfo = await this.gecko.getTokenInfo(chain, address);
      if (tokenInfo?.attributes) {
        const attr = tokenInfo.attributes;
        result.tokenName = attr.name;
        result.tokenSymbol = attr.symbol;
        result.priceUsd = attr.price_usd;
        result.marketCap = attr.market_cap_usd || attr.fdv_usd;
        result.volume24h = attr.volume_usd?.h24;
        if (attr.image_url) {
          result.tokenImageUrl = attr.image_url;
        }
        dataFetched = true;
      }

      const pools = await this.gecko.getTokenPools(chain, address);
      if (pools?.length > 0) {
        const topPool = pools[0];
        result.liquidity = topPool.attributes?.reserve_in_usd;
        result.poolCreatedAt = topPool.attributes?.pool_created_at;
      }
    } catch (error) {
      console.error('[Analyzer] GeckoTerminal error, falling back to DexScreener:', error);
    }

    // Always fetch DexScreener for trading metrics (and as fallback for basic data)
    try {
      const dexData = await this.dexscreener.getTokenPairs(chain, address);
      if (dexData) {
        // Fill basic data if GeckoTerminal didn't provide it
        if (!dataFetched) {
          result.tokenName = result.tokenName || dexData.tokenName;
          result.tokenSymbol = result.tokenSymbol || dexData.tokenSymbol;
          result.priceUsd = result.priceUsd || dexData.priceUsd;
          result.marketCap = result.marketCap || dexData.fdv?.toString();
          result.liquidity = result.liquidity || dexData.liquidity?.toString();
          result.volume24h = result.volume24h || dexData.volume24h?.toString();
          result.poolCreatedAt = result.poolCreatedAt || dexData.pairCreatedAt;
        }
        // Token image fallback
        if (!result.tokenImageUrl && dexData.tokenImageUrl) {
          result.tokenImageUrl = dexData.tokenImageUrl;
        }
        // Social links
        if (!result.socials) {
          const hasSocials = dexData.website || dexData.twitter || dexData.telegram || dexData.discord;
          if (hasSocials) {
            result.socials = {
              website: dexData.website,
              twitter: dexData.twitter,
              telegram: dexData.telegram,
              discord: dexData.discord,
              description: dexData.description,
            };
          }
        }
        // Store trading metrics
        result.rawData = { ...result.rawData, dexscreener: this.extractDexMetrics(dexData) };
      }
    } catch (error) {
      if (!dataFetched) {
        console.error('[Analyzer] DexScreener error:', error);
      }
      // Non-critical if GeckoTerminal already provided data
    }
  }

  /**
   * Step 2: Security scanning
   */
  private async fetchSecurityData(chain: Chain, address: string, result: ContractAnalysis) {
    // GoPlus for all chains
    try {
      const security = await this.goplus.getTokenSecurity(chain, address);
      if (security) {
        result.security = security;
      }
    } catch (error) {
      console.error('[Analyzer] GoPlus error:', error);
    }

    // Solana-specific: RugCheck
    if (chain === 'solana') {
      try {
        const rugReport = await this.rugcheck.getTokenReport(address);
        if (rugReport) {
          result.rawData = { ...result.rawData, rugcheck: rugReport };
        }
      } catch (error) {
        console.error('[Analyzer] RugCheck error:', error);
      }
    }
  }

  /**
   * Step 3: Holder analysis via Moralis (EVM chains only)
   */
  private async fetchHolderData(chain: Chain, address: string, result: ContractAnalysis) {
    // Skip if no Moralis key configured
    if (!config.moralis.apiKey || config.moralis.apiKey === 'your_moralis_api_key_here') {
      return;
    }

    // Only EVM chains supported
    if (chain === 'solana' || chain === 'tron') return;

    try {
      const holderStats = await this.moralis.getTokenHolders(chain, address, 30);
      if (holderStats) {
        // Use GoPlus holderCount as PRIMARY source (Moralis stats endpoint often unavailable)
        // Only use Moralis totalHolders if it's a credible number (> limit param)
        let totalHolders: number;
        if (result.security?.holderCount && result.security.holderCount > 0) {
          totalHolders = result.security.holderCount;
        } else if (holderStats.totalHolders > 30) {
          // Only trust Moralis count if it's above the fetch limit (otherwise it's likely wrong)
          totalHolders = holderStats.totalHolders;
        } else {
          // Fallback: use GoPlus data or indicate unknown
          totalHolders = result.security?.holderCount || 0;
        }

        result.rawData = {
          ...result.rawData,
          holders: {
            totalHolders,
            holderChange24h: holderStats.holderChange24h,
            top10Concentration: holderStats.top10Concentration,
            top20Concentration: holderStats.top20Concentration,
            topHolders: holderStats.topHolders.slice(0, 10).map(h => ({
              address: h.holderAddress,
              percent: h.percentageOfTotal.toFixed(2) + '%',
              isContract: h.isContract,
            })),
          },
        };

        // Check deployer wallet holdings
        if (result.security?.creatorAddress) {
          const creatorHolding = holderStats.topHolders.find(
            h => h.holderAddress.toLowerCase() === result.security!.creatorAddress!.toLowerCase()
          );
          if (creatorHolding) {
            result.rawData.holders.creatorHolding = creatorHolding.percentageOfTotal.toFixed(2) + '%';
          }
        }
      }
    } catch (error) {
      console.error('[Analyzer] Moralis holder analysis error:', error);
    }
  }
}
