import { Chain, ContractAnalysis } from '../types';
import { config } from '../config';
import { GeckoTerminalService } from './geckoTerminal';
import { DexScreenerService } from './dexscreener';
import { GoPlusService } from './goplus';
import { RugCheckService } from './rugcheck';
import { EtherscanService } from './etherscan';
import { LaunchpadService } from './launchpad';
import { MoralisService } from './moralis';
import { AIService } from './ai';

export class ContractAnalyzer {
  private gecko: GeckoTerminalService;
  private dexscreener: DexScreenerService;
  private goplus: GoPlusService;
  private rugcheck: RugCheckService;
  private etherscan: EtherscanService;
  private launchpad: LaunchpadService;
  private moralis: MoralisService;
  private ai: AIService;

  constructor() {
    this.gecko = new GeckoTerminalService();
    this.dexscreener = new DexScreenerService();
    this.goplus = new GoPlusService();
    this.rugcheck = new RugCheckService();
    this.etherscan = new EtherscanService();
    this.launchpad = new LaunchpadService();
    this.moralis = new MoralisService(config.moralis.apiKey);
    this.ai = new AIService();
  }

  /**
   * Phase 1: Collect all on-chain data (fast, no AI)
   * Returns result without aiAnalysis field
   */
  async analyzeData(chain: Chain, address: string): Promise<ContractAnalysis> {
    console.log(`[Analyzer] Starting data collection: ${chain}:${address}`);
    const result: ContractAnalysis = { chain, address, analysisType: 'unknown' };
    const isEVM = chain !== 'solana' && chain !== 'tron';

    // Step 1: Market data (GeckoTerminal primary, DexScreener fallback)
    await this.fetchMarketData(chain, address, result);

    // Step 2: Security analysis (GoPlus + RugCheck for Solana)
    await this.fetchSecurityData(chain, address, result);

    // Step 3: Holder analysis (Moralis - EVM only)
    await this.fetchHolderData(chain, address, result);

    // Step 4: Launchpad detection + deployment time (parallel)
    const [launchpadResult, deployTime, contractCheck] = await Promise.allSettled([
      this.launchpad.detectLaunchpad(chain, address),
      isEVM ? this.etherscan.getDeploymentTime(chain, address) : Promise.resolve(null),
      isEVM ? this.etherscan.isContractAddress(chain, address) : Promise.resolve(null),
    ]);

    if (launchpadResult.status === 'fulfilled' && launchpadResult.value) {
      result.launchpad = launchpadResult.value;
    }
    if (deployTime.status === 'fulfilled' && deployTime.value) {
      result.deployedAt = deployTime.value;
    }
    if (contractCheck.status === 'fulfilled' && typeof contractCheck.value === 'boolean') {
      result.isContract = contractCheck.value;
    }

    // Step 4.5: Token image & socials fallback
    if (!result.tokenImageUrl && isEVM) {
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
    if (isEVM) {
      try {
        const source = await this.etherscan.getContractSource(chain, address);
        if (source) {
          result.contractSource = source;
          if (source.isVerified || result.isContract === undefined) {
            result.isContract = true;
          }

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
    if (isEVM) {
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

    this.finalizeAnalysisType(result);
    console.log(`[Analyzer] Data collection complete: ${chain}:${address}`);
    return result;
  }

  /**
   * Phase 2: Run AI analysis on already-collected data
   */
  async analyzeAI(result: ContractAnalysis): Promise<string> {
    try {
      const aiResult = await this.ai.analyzeContract(result);
      return aiResult;
    } catch (error) {
      console.error('[Analyzer] AI analysis error:', error);
      return '分析暂时不可用';
    }
  }

  private finalizeAnalysisType(result: ContractAnalysis) {
    const tokenSignals = this.hasTokenSignals(result);
    if (tokenSignals) {
      result.analysisType = 'token';
      result.isContract = true;
    } else if (result.isContract || result.contractSource) {
      result.analysisType = 'contract';
    } else {
      result.analysisType = 'unknown';
    }

    result.contractKind = this.inferContractKind(result);
  }

  private hasTokenSignals(result: ContractAnalysis): boolean {
    return Boolean(
      result.tokenName ||
      result.tokenSymbol ||
      result.priceUsd ||
      result.marketCap ||
      result.liquidity ||
      result.volume24h ||
      result.poolCreatedAt ||
      result.tokenImageUrl ||
      result.socials ||
      this.hasTokenSecuritySignals(result.security) ||
      result.rawData?.dexscreener ||
      result.rawData?.rugcheck
    );
  }

  private hasTokenSecuritySignals(security: ContractAnalysis['security']): boolean {
    if (!security) return false;

    const buyTax = parseFloat(security.buyTax || '0');
    const sellTax = parseFloat(security.sellTax || '0');

    return Boolean(
      security.holderCount ||
      security.topHolders?.length ||
      security.lpHolders?.length ||
      buyTax > 0 ||
      sellTax > 0 ||
      security.isHoneypot ||
      security.cannotSellAll ||
      security.tradingCooldown ||
      security.antiWhale
    );
  }

  private inferContractKind(result: ContractAnalysis): string {
    if (!result.contractSource?.contractFunctions?.length) {
      if (result.analysisType === 'token') return '代币合约';
      if (result.analysisType === 'contract') return result.contractSource?.isVerified ? '通用合约' : '未验证合约';
      return '未知地址';
    }

    const names = new Set(result.contractSource.contractFunctions.map(f => f.name.toLowerCase()));
    const hasAll = (required: string[]) => required.every(name => names.has(name.toLowerCase()));
    const hasAny = (patterns: RegExp[]) => [...names].some(name => patterns.some(pattern => pattern.test(name)));

    if (hasAll(['totalSupply', 'balanceOf', 'transfer', 'approve', 'transferFrom'])) return 'ERC20代币合约';
    if (hasAll(['ownerOf', 'tokenURI']) || hasAny([/^safetransferfrom$/, /^setapprovalforall$/])) return 'NFT合约';
    if (hasAll(['token0', 'token1', 'getReserves'])) return 'DEX交易对合约';
    if (hasAny([/^swapExact/i, /^addLiquidity/i, /^removeLiquidity/i])) return 'DEX路由合约';
    if (hasAny([/deposit/i, /withdraw/i, /stake/i, /unstake/i, /claim/i, /reward/i])) return '质押/收益合约';
    if (hasAny([/borrow/i, /repay/i, /liquidat/i, /collateral/i])) return '借贷合约';
    if (result.contractSource.isProxy) return '代理合约';
    if (result.analysisType === 'token') return '代币合约';
    return '通用合约';
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
