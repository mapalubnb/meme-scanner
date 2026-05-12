import axios from 'axios';
import { Chain, ContractSourceInfo, ContractFunctionInfo, TaxDistribution, TaxDestination, LPLockInfo } from '../types';
import { config } from '../config';

// Etherscan V2 unified endpoint
const ETHERSCAN_V2_URL = 'https://api.etherscan.io/v2/api';

// Chain ID mapping for Etherscan V2
const CHAIN_ID_MAP: Record<Chain, string> = {
  ethereum: '1',
  bsc: '56',
  base: '8453',
  arbitrum: '42161',
  solana: '',   // Not supported by Etherscan
  tron: '',     // Not supported by Etherscan
};

// Re-export for backward compatibility
type ContractFunction = ContractFunctionInfo;

export class EtherscanService {
  /**
   * Make a request to Etherscan V2 API with retry on rate limit
   */
  private async requestV2(params: Record<string, string>, timeout = 15000): Promise<any> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const res = await axios.get(ETHERSCAN_V2_URL, {
        params: {
          ...params,
          apikey: config.etherscan.apiKey,
        },
        timeout,
      });

      // Handle error responses from Etherscan V2
      if (res.data?.status === '0') {
        const errMsg = typeof res.data?.result === 'string' ? res.data.result : '';

        // Rate limit - retry
        if (errMsg.toLowerCase().includes('rate limit')) {
          console.log(`[Etherscan] Rate limited, retry ${attempt + 1}/${maxRetries}...`);
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }

        // "Free API access is not supported" - don't spam logs, just throw quietly
        if (errMsg.includes('Free API access is not supported')) {
          throw new Error(`Etherscan API: Free tier not supported for this chain/action`);
        }

        // Other API errors - log and throw (don't retry)
        console.error(`[Etherscan V2] API error: status=0, message=${res.data?.message}, result=${errMsg.slice(0, 200)}`);
        throw new Error(`Etherscan API error: ${errMsg || res.data?.message || 'Unknown error'}`);
      }

      return res.data;
    }
    throw new Error('Etherscan API rate limit exceeded after retries');
  }

  /**
   * Get verified contract source code via Etherscan V2 unified endpoint
   */
  async getContractSource(chain: Chain, address: string): Promise<ContractSourceInfo | null> {
    const chainId = CHAIN_ID_MAP[chain];
    if (!chainId) return null; // Solana/Tron not supported

    try {
      const data = await this.requestV2({
        chainid: chainId,
        module: 'contract',
        action: 'getsourcecode',
        address,
      });

      const result = data?.result?.[0];

      // Debug: log what we got back from the explorer API
      console.log(`[Etherscan V2] Response for ${address} on ${chain} (chainId=${chainId}):`, {
        hasResult: !!result,
        contractName: result?.ContractName,
        abiLength: result?.ABI?.length,
        abiStart: result?.ABI?.slice(0, 80),
        sourceLength: result?.SourceCode?.length,
        isProxy: result?.Proxy,
        implementation: result?.Implementation,
        isVerified: result?.ABI !== 'Contract source code not verified',
      });

      if (!result || result.ABI === 'Contract source code not verified') {
        console.log(`[Etherscan V2] Contract not verified: ${address} on ${chain}`);
        return { isVerified: false };
      }

      // Some explorers return error messages in ABI field when API key is wrong
      if (result.ABI && (result.ABI.includes('NOTOK') || result.ABI === 'Invalid API Key')) {
        console.error('[Etherscan V2] API returned error in ABI field:', result.ABI.slice(0, 100));
        return { isVerified: false };
      }

      // Handle Proxy Contracts: fetch implementation source code
      if (result.Proxy === '1' && result.Implementation) {
        console.log(`[Etherscan V2] Proxy detected, fetching implementation: ${result.Implementation}`);
        try {
          const implData = await this.requestV2({
            chainid: chainId,
            module: 'contract',
            action: 'getsourcecode',
            address: result.Implementation,
          });
          const implResult = implData?.result?.[0];
          if (implResult && implResult.ABI !== 'Contract source code not verified') {
            // Use implementation's source code but keep proxy info
            result.SourceCode = implResult.SourceCode || result.SourceCode;
            result.ABI = implResult.ABI || result.ABI;
            result.ContractName = implResult.ContractName || result.ContractName;
            result.CompilerVersion = implResult.CompilerVersion || result.CompilerVersion;
            console.log(`[Etherscan V2] Implementation source loaded: ${implResult.ContractName}`);
          }
        } catch (implError: any) {
          console.error('[Etherscan V2] Failed to fetch implementation:', implError?.message);
        }
      }

      // If ABI is empty/blank but no error message, contract is likely not verified or rate-limited
      if (!result.ABI || result.ABI.trim() === '' || result.ABI.trim() === '[]') {
        console.log(`[Etherscan V2] ABI empty for ${address} on ${chain} (rate limited or not verified)`);
        // If there's source code, still consider it verified
        if (result.SourceCode && result.SourceCode.length > 0) {
          // Has source but no ABI - unusual but possible
        } else {
          return { isVerified: false };
        }
      }

      // Handle multi-file source code format (Etherscan wraps in {{ }})
      let flatSourceCode = result.SourceCode || '';
      if (flatSourceCode.startsWith('{{')) {
        try {
          const inner = flatSourceCode.slice(1, -1); // strip outer braces
          const parsed = JSON.parse(inner);
          const sources = parsed.sources || {};
          // Concatenate all source files into one string for analysis
          flatSourceCode = Object.entries(sources)
            .map(([filename, info]: [string, any]) => `// === ${filename} ===\n${info.content}`)
            .join('\n\n');
          console.log(`[Etherscan V2] Multi-file source: ${Object.keys(sources).length} files, total ${flatSourceCode.length} chars`);
        } catch (e) {
          console.error('[Etherscan V2] Failed to parse multi-file source format:', e);
        }
      }

      // Detect dangerous functions in source code
      const dangerousFunctions = this.detectDangerousFunctions(flatSourceCode);

      // Parse ABI to extract all contract functions with details
      let contractFunctions = this.parseContractFunctions(result.ABI, flatSourceCode);

      // Fallback: if ABI parsing yielded nothing but we have source code, extract from source
      if (contractFunctions.length === 0 && flatSourceCode.length > 0) {
        console.log(`[Etherscan V2] ABI parse yielded 0 functions, trying source code extraction...`);
        contractFunctions = this.extractFunctionsFromSource(flatSourceCode);
      }

      return {
        isVerified: true,
        sourceCode: flatSourceCode,
        compilerVersion: result.CompilerVersion,
        contractName: result.ContractName || 'Unknown',
        abi: result.ABI,
        dangerousFunctions,
        contractFunctions,
      };
    } catch (error: any) {
      console.error('[Etherscan V2] getContractSource error:', error?.message || error);
      return null;
    }
  }

  /**
   * Get contract creation transaction (for launchpad detection)
   */
  async getContractCreation(chain: Chain, address: string) {
    const chainId = CHAIN_ID_MAP[chain];
    if (!chainId) return null;

    try {
      const data = await this.requestV2({
        chainid: chainId,
        module: 'contract',
        action: 'getcontractcreation',
        contractaddresses: address,
      });

      return data?.result?.[0]; // { contractAddress, contractCreator, txHash }
    } catch {
      return null;
    }
  }

  /**
   * Get deployment timestamp of a contract by fetching the creation tx block
   * Returns ISO date string or null
   */
  async getDeploymentTime(chain: Chain, address: string): Promise<string | null> {
    const chainId = CHAIN_ID_MAP[chain];
    if (!chainId) return null;

    try {
      const creation = await this.getContractCreation(chain, address);
      if (!creation?.txHash) return null;

      // Get transaction receipt to find block number
      const txData = await this.requestV2({
        chainid: chainId,
        module: 'proxy',
        action: 'eth_getTransactionByHash',
        txhash: creation.txHash,
      });

      const blockHex = txData?.result?.blockNumber;
      if (!blockHex) return null;

      // Get block timestamp
      const blockData = await this.requestV2({
        chainid: chainId,
        module: 'proxy',
        action: 'eth_getBlockByNumber',
        tag: blockHex,
        boolean: 'false',
      });

      const timestampHex = blockData?.result?.timestamp;
      if (!timestampHex) return null;

      const timestamp = parseInt(timestampHex, 16) * 1000;
      return new Date(timestamp).toISOString();
    } catch (error: any) {
      console.error('[Etherscan] getDeploymentTime error:', error?.message);
      return null;
    }
  }

  /**
   * Check if renounceOwnership() was actually called on the contract
   * by searching for Transfer of ownership events to 0x0 address
   */
  async verifyOwnershipRenounced(chain: Chain, address: string): Promise<{ renounced: boolean; txHash?: string; timestamp?: string }> {
    const chainId = CHAIN_ID_MAP[chain];
    if (!chainId) return { renounced: false };

    try {
      // OwnershipTransferred event topic: keccak256("OwnershipTransferred(address,address)")
      const OWNERSHIP_TRANSFERRED_TOPIC = '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0';
      const ZERO_ADDRESS_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

      const data = await this.requestV2({
        chainid: chainId,
        module: 'logs',
        action: 'getLogs',
        address: address,
        topic0: OWNERSHIP_TRANSFERRED_TOPIC,
        topic2: ZERO_ADDRESS_TOPIC, // newOwner = address(0)
        fromBlock: '0',
        toBlock: 'latest',
      });

      const logs = data?.result;
      if (Array.isArray(logs) && logs.length > 0) {
        const lastLog = logs[logs.length - 1];
        const timestamp = lastLog.timeStamp
          ? new Date(parseInt(lastLog.timeStamp, 16) * 1000).toISOString()
          : undefined;
        return {
          renounced: true,
          txHash: lastLog.transactionHash,
          timestamp,
        };
      }

      return { renounced: false };
    } catch (error: any) {
      console.error('[Etherscan] verifyOwnershipRenounced error:', error?.message);
      return { renounced: false };
    }
  }

  /**
   * Check if LP tokens are locked in known locker contracts
   * Returns lock info if found
   */
  async checkLPLocks(chain: Chain, lpTokenAddress: string): Promise<LPLockInfo | null> {
    const chainId = CHAIN_ID_MAP[chain];
    if (!chainId) return null;

    // Known LP locker contracts
    const LOCKERS: Record<string, string> = {
      '0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214': 'Unicrypt',
      '0xdead000000000000000042069420694206942069': 'Dead Address (Burned)',
      '0x000000000000000000000000000000000000dead': 'Dead Address (Burned)',
      '0x0000000000000000000000000000000000000000': 'Null Address (Burned)',
      '0x71b5759d73262fbb223956913ecf4ecc51057641': 'PinkSale Lock',
      '0x407993575c91ce7643a4d4ccafc9a98c36ee1bbe': 'PinkSale Lock v2',
      '0xe2fe530c047f2d85298b07d9333c05737f1435fb': 'Team.finance',
      '0xc77aab3c6d7dab46248f3cc627ef1bd3a732cb9b': 'Team.finance v2',
      '0xc8b839b9226965caf1d9fc1551588aaf553a7be6': 'Floki Lock',
    };

    try {
      // Get top holders of the LP token via Etherscan token holders
      const data = await this.requestV2({
        chainid: chainId,
        module: 'token',
        action: 'tokenholderlist',
        contractaddress: lpTokenAddress,
        page: '1',
        offset: '20',
      });

      const holders = data?.result;
      if (!Array.isArray(holders)) return null;

      let totalLockedPct = 0;
      const lockers: Array<{ name: string; address: string; percent: number }> = [];

      for (const holder of holders) {
        const holderAddr = holder.TokenHolderAddress?.toLowerCase();
        const lockerName = LOCKERS[holderAddr];
        if (lockerName) {
          const pct = parseFloat(holder.TokenHolderQuantity || '0') / parseFloat(holder.TokenTotalSupply || '1') * 100;
          totalLockedPct += pct;
          lockers.push({ name: lockerName, address: holderAddr, percent: pct });
        }
      }

      if (lockers.length > 0) {
        return {
          isLocked: true,
          totalLockedPercent: Math.round(totalLockedPct * 100) / 100,
          lockers,
        };
      }

      return null;
    } catch (error: any) {
      // tokenholderlist might not be available on all chains/tiers
      console.warn('[Etherscan] checkLPLocks error:', error?.message);
      return null;
    }
  }

  /**
   * Parse ABI JSON to extract all public/external functions with risk assessment
   */
  private parseContractFunctions(abiStr: string | any, sourceCode: string): ContractFunction[] {
    if (!abiStr || abiStr === '[]') {
      console.log('[Etherscan] ABI is empty or []');
      return [];
    }

    try {
      let abi: any;

      // Handle case where ABI is already parsed (object/array)
      if (Array.isArray(abiStr)) {
        abi = abiStr;
      } else if (typeof abiStr === 'object') {
        console.error('[Etherscan] ABI is an object but not array:', JSON.stringify(abiStr).slice(0, 200));
        return [];
      } else if (typeof abiStr === 'string') {
        // Try parsing JSON string
        try {
          abi = JSON.parse(abiStr);
        } catch {
          // Sometimes ABI is double-escaped JSON string
          try {
            const unescaped = abiStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            abi = JSON.parse(unescaped);
          } catch {
            console.error('[Etherscan] ABI parse failed, raw start:', abiStr.slice(0, 200));
            return [];
          }
        }

        // If parsed result is still a string, parse again (double-encoded)
        if (typeof abi === 'string') {
          try {
            abi = JSON.parse(abi);
          } catch {
            console.error('[Etherscan] ABI string re-parse failed');
            return [];
          }
        }
      } else {
        console.error('[Etherscan] ABI unexpected type:', typeof abiStr);
        return [];
      }

      if (!Array.isArray(abi)) {
        console.error('[Etherscan] ABI is not an array, type:', typeof abi, 'value:', JSON.stringify(abi).slice(0, 200));
        return [];
      }

      console.log(`[Etherscan] ABI parsed: ${abi.length} items, types: ${[...new Set(abi.map((i: any) => i.type))].join(',')}`);

      const functions: ContractFunction[] = [];

      for (const item of abi) {
        if (item.type === 'function') {
          const inputs = (item.inputs || [])
            .map((inp: any) => `${inp.type}${inp.name ? ' ' + inp.name : ''}`)
            .join(', ');
          const outputs = (item.outputs || [])
            .map((out: any) => out.type)
            .join(', ');

          const func: ContractFunction = {
            name: item.name,
            type: 'function',
            stateMutability: item.stateMutability || 'nonpayable',
            inputs: inputs || 'none',
            outputs: outputs || 'void',
          };

          // Check if function is owner-restricted (search source for onlyOwner modifier)
          if (sourceCode) {
            const ownerPattern = new RegExp(
              `function\\s+${this.escapeRegex(item.name)}\\s*\\([^)]*\\)[^{]*\\b(onlyOwner|onlyAdmin|onlyOperator|authorized|onlyRole)\\b`,
              'i'
            );
            func.isOwnerOnly = ownerPattern.test(sourceCode);
          }

          // Assess risk level
          this.assessFunctionRisk(func);

          functions.push(func);
        }
      }

      console.log(`[Etherscan] Parsed ${functions.length} functions from ABI`);
      return functions;
    } catch (error) {
      const rawPreview = typeof abiStr === 'string' ? abiStr.slice(0, 200) : JSON.stringify(abiStr).slice(0, 200);
      console.error('[Etherscan] ABI parse error:', error, 'raw ABI start:', rawPreview);
      return [];
    }
  }

  /**
   * Escape special regex characters in function name
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Assess risk level of a contract function
   */
  private assessFunctionRisk(func: ContractFunction): void {
    const name = func.name.toLowerCase();

    // High risk: functions that can steal funds or trap users
    const highRisk = [
      { pattern: /^(setfee|settax|updatefee|updatetax|changetax|changefee|setbuytax|setselltax)/i, note: '可修改买卖税率' },
      { pattern: /^(mint|_mint)$/i, note: '可增发代币' },
      { pattern: /^(blacklist|addtoblacklist|block|banaddress|addblack)/i, note: '可拉黑地址禁止交易' },
      { pattern: /^(pause|freeze|stop)/i, note: '可暂停所有交易' },
      { pattern: /^(selfdestruct|destroy|kill)/i, note: '可自毁合约' },
      { pattern: /^(setpair|setrouter|setswap)/i, note: '可修改交易对/路由' },
    ];

    // Medium risk: owner privileges that could be abused
    const mediumRisk = [
      { pattern: /^(withdraw|drain|sweep|claim|skim)/i, note: '可提取合约资金' },
      { pattern: /^(setmax|setlimit|setmaxtx|setmaxwallet|setmaxtransaction)/i, note: '可修改最大交易/持仓限额' },
      { pattern: /^(excludefromfee|excludefromlimit|setexclude)/i, note: '可排除地址免税/免限制' },
      { pattern: /^(setwalletlimit|settxlimit)/i, note: '可修改钱包限额' },
      { pattern: /^(transferownership|setowner|changeowner)/i, note: '可转移所有权' },
      { pattern: /^(unpause|unfreeze|resume)/i, note: '可恢复交易' },
      { pattern: /^(setcooldown|settradingcooldown)/i, note: '可设置交易冷却' },
    ];

    // Low risk: informational
    const lowRisk = [
      { pattern: /^(renounceownership)/i, note: '可放弃所有权(需验证是否已调用)' },
      { pattern: /^(opentrading|enabletrading|starttrading)/i, note: '开启交易' },
    ];

    for (const { pattern, note } of highRisk) {
      if (pattern.test(name)) {
        func.riskLevel = 'high';
        func.riskNote = note;
        return;
      }
    }

    for (const { pattern, note } of mediumRisk) {
      if (pattern.test(name)) {
        func.riskLevel = 'medium';
        func.riskNote = note;
        return;
      }
    }

    for (const { pattern, note } of lowRisk) {
      if (pattern.test(name)) {
        func.riskLevel = 'low';
        func.riskNote = note;
        return;
      }
    }

    // Owner-only functions without specific risk pattern are medium by default
    if (func.isOwnerOnly && func.stateMutability !== 'view' && func.stateMutability !== 'pure') {
      func.riskLevel = 'medium';
      func.riskNote = 'Owner专属写入函数';
      return;
    }

    func.riskLevel = 'info';
  }

  /**
   * Extract function signatures directly from Solidity source code
   * Used as fallback when ABI parsing fails
   */
  private extractFunctionsFromSource(sourceCode: string): ContractFunction[] {
    if (!sourceCode) return [];

    const functions: ContractFunction[] = [];
    // Match: function functionName(params) visibility modifiers returns (type)
    const funcPattern = /function\s+(\w+)\s*\(([^)]*)\)\s*((?:public|external|internal|private|view|pure|payable|virtual|override|onlyOwner|onlyAdmin|onlyOperator|returns\s*\([^)]*\)|[\w\s])*)/g;

    let match;
    const seen = new Set<string>();

    while ((match = funcPattern.exec(sourceCode)) !== null) {
      const name = match[1];
      const params = match[2].trim();
      const modifiers = match[3] || '';

      // Skip internal/private, duplicates, and common inherited functions
      if (modifiers.includes('internal') || modifiers.includes('private')) continue;
      if (seen.has(name)) continue;
      seen.add(name);

      // Determine visibility/mutability
      let stateMutability = 'nonpayable';
      if (modifiers.includes('view')) stateMutability = 'view';
      else if (modifiers.includes('pure')) stateMutability = 'pure';
      else if (modifiers.includes('payable')) stateMutability = 'payable';

      const isOwnerOnly = /onlyOwner|onlyAdmin|onlyOperator|onlyRole|authorized/.test(modifiers);

      // Simplify params for display
      const simplifiedParams = params
        ? params.split(',').map(p => p.trim().replace(/\s+memory|\s+calldata|\s+storage/g, '')).join(', ')
        : 'none';

      const func: ContractFunction = {
        name,
        type: 'function',
        stateMutability,
        inputs: simplifiedParams || 'none',
        outputs: 'void',
        isOwnerOnly,
      };

      this.assessFunctionRisk(func);
      functions.push(func);
    }

    console.log(`[Etherscan] Extracted ${functions.length} functions from source code`);
    return functions;
  }

  /**
   * Detect dangerous/suspicious patterns in source code
   */
  private detectDangerousFunctions(sourceCode: string): string[] {
    if (!sourceCode) return [];

    const dangerous: string[] = [];
    const patterns: [RegExp, string][] = [
      [/function\s+setTax|function\s+setFee|function\s+updateFee/i, 'Can modify tax/fee'],
      [/function\s+blacklist|function\s+addToBlacklist|function\s+block/i, 'Has blacklist function'],
      [/function\s+pause|function\s+unpause|whenNotPaused/i, 'Can pause transfers'],
      [/function\s+mint(?!.*override)/i, 'Has mint function'],
      [/selfdestruct|delegatecall/i, 'Has selfdestruct/delegatecall'],
      [/function\s+setMaxTransaction|function\s+setMaxWallet/i, 'Can change max tx/wallet'],
      [/function\s+renounceOwnership/i, 'Has renounceOwnership (check if called)'],
      [/function\s+transferOwnership/i, 'Ownership transferable'],
      [/\.call\{value:/i, 'Uses low-level call with value'],
      [/function\s+withdraw|function\s+drain/i, 'Has withdraw/drain function'],
    ];

    for (const [pattern, description] of patterns) {
      if (pattern.test(sourceCode)) {
        dangerous.push(description);
      }
    }

    return dangerous;
  }

  /**
   * Analyze tax distribution from contract source code
   * Detects: tax wallet addresses, burn mechanism, auto-LP, reflections, etc.
   */
  analyzeTaxDistribution(sourceCode: string, abi?: string): TaxDistribution | null {
    if (!sourceCode) return null;

    const destinations: TaxDestination[] = [];
    const rawTaxFunctions: string[] = [];
    let hasBurn = false;
    let hasReflection = false;
    let hasAutoLP = false;

    // ═══════════════════════════════════════
    // 1. Detect tax wallet addresses
    // ═══════════════════════════════════════

    // Marketing wallet patterns
    const marketingPatterns = [
      /(?:marketing|mkt|marketingWallet|_marketingWallet|marketingAddress|_marketingAddress|marketingFee(?:Receiver|Wallet))\s*(?:=|:)\s*(0x[a-fA-F0-9]{40})/gi,
      /address\s+(?:public\s+|private\s+|internal\s+)?(?:marketing|mktWallet|marketingWallet|_marketingWallet|marketingAddress)\s*(?:=\s*(0x[a-fA-F0-9]{40}))?/gi,
    ];

    // Dev wallet patterns
    const devPatterns = [
      /(?:dev|devWallet|_devWallet|devAddress|developmentWallet|developerWallet|devFee(?:Receiver|Wallet))\s*(?:=|:)\s*(0x[a-fA-F0-9]{40})/gi,
      /address\s+(?:public\s+|private\s+|internal\s+)?(?:dev|devWallet|_devWallet|devAddress|developmentWallet)\s*(?:=\s*(0x[a-fA-F0-9]{40}))?/gi,
    ];

    // Treasury wallet patterns
    const treasuryPatterns = [
      /(?:treasury|treasuryWallet|_treasuryWallet|treasuryAddress)\s*(?:=|:)\s*(0x[a-fA-F0-9]{40})/gi,
      /address\s+(?:public\s+|private\s+|internal\s+)?(?:treasury|treasuryWallet|_treasuryWallet)\s*(?:=\s*(0x[a-fA-F0-9]{40}))?/gi,
    ];

    // Team wallet patterns
    const teamPatterns = [
      /(?:team|teamWallet|_teamWallet|teamAddress|teamFee(?:Receiver|Wallet))\s*(?:=|:)\s*(0x[a-fA-F0-9]{40})/gi,
      /address\s+(?:public\s+|private\s+|internal\s+)?(?:team|teamWallet|_teamWallet|teamAddress)\s*(?:=\s*(0x[a-fA-F0-9]{40}))?/gi,
    ];

    // Charity wallet patterns
    const charityPatterns = [
      /(?:charity|charityWallet|_charityWallet|charityAddress|donation)\s*(?:=|:)\s*(0x[a-fA-F0-9]{40})/gi,
    ];

    // Buyback wallet patterns
    const buybackPatterns = [
      /(?:buyback|buybackWallet|_buybackWallet|buyBackAddress)\s*(?:=|:)\s*(0x[a-fA-F0-9]{40})/gi,
    ];

    // Generic fee receiver patterns (catch-all)
    const feeReceiverPatterns = [
      /(?:feeReceiver|feeWallet|_feeWallet|taxWallet|_taxWallet|taxReceiver|feeAddress)\s*(?:=|:)\s*(0x[a-fA-F0-9]{40})/gi,
    ];

    const extractAddresses = (patterns: RegExp[], type: TaxDestination['type'], label: string) => {
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(sourceCode)) !== null) {
          const addr = match[1];
          if (addr && addr !== '0x0000000000000000000000000000000000000000' &&
              !destinations.find(d => d.address?.toLowerCase() === addr.toLowerCase() && d.type === type)) {
            destinations.push({ type, label, address: addr });
          }
        }
      }
    };

    extractAddresses(marketingPatterns, 'marketing', '营销钱包');
    extractAddresses(devPatterns, 'dev', '开发者钱包');
    extractAddresses(treasuryPatterns, 'treasury', '金库/国库');
    extractAddresses(teamPatterns, 'team', '团队钱包');
    extractAddresses(charityPatterns, 'charity', '慈善/捐赠');
    extractAddresses(buybackPatterns, 'buyback', '回购钱包');
    extractAddresses(feeReceiverPatterns, 'unknown', '费用接收钱包');

    // ═══════════════════════════════════════
    // 2. Detect burn mechanism
    // ═══════════════════════════════════════
    const burnPatterns = [
      /(?:dead|DEAD|burnAddress|deadAddress)\s*(?:=|:)\s*(0x[a-fA-F0-9]{40}|0x(?:0{39}[dD]ead|[dD]ead[0-9a-fA-F]{36}))/i,
      /address\s*\(\s*0x(?:0{39}dead|dead[0-9a-f]*|000000000000000000000000000000000000dead)\s*\)/i,
      /0x000000000000000000000000000000000000dEaD/i,
      /burnFee|_burnFee|burnTax|_burnTax|autoBurn|_autoBurn/i,
      /function\s+_burn|_tokenTransfer.*dead/i,
      /transfer\s*\(\s*(?:dead|DEAD|burnAddress|address\s*\(\s*0xdead)/i,
    ];

    for (const pattern of burnPatterns) {
      if (pattern.test(sourceCode)) {
        hasBurn = true;
        break;
      }
    }

    if (hasBurn && !destinations.find(d => d.type === 'burn')) {
      // Try to extract burn percentage
      const burnPctMatch = sourceCode.match(/(?:burnFee|_burnFee|burnTax|_burnTax|burnPercent)\s*=\s*(\d+)/i);
      destinations.push({
        type: 'burn',
        label: '销毁 (Dead地址)',
        address: '0x000000000000000000000000000000000000dEaD',
        percentage: burnPctMatch ? burnPctMatch[1] + '%' : undefined,
        notes: '代币转入黑洞地址永久销毁',
      });
    }

    // ═══════════════════════════════════════
    // 3. Detect reflection/dividend mechanism
    // ═══════════════════════════════════════
    const reflectionPatterns = [
      /reflectionFee|_reflectionFee|rewardFee|_rewardFee|holderReward/i,
      /dividendTracker|_dividendTracker|dividendToken/i,
      /distributeDividends|_distributeDividends/i,
      /reflectFee|_reflectFee|tFeeTotal/i,
      /function\s+deliver|_reflectFee|_getReflectAmount/i,
      /rfi|reflect\.finance|safemoon/i, // Known reflection token patterns
    ];

    for (const pattern of reflectionPatterns) {
      if (pattern.test(sourceCode)) {
        hasReflection = true;
        break;
      }
    }

    if (hasReflection && !destinations.find(d => d.type === 'reflection')) {
      const reflPctMatch = sourceCode.match(/(?:reflectionFee|_reflectionFee|rewardFee|_rewardFee|taxFee|_taxFee)\s*=\s*(\d+)/i);
      destinations.push({
        type: 'reflection',
        label: '持有者分红',
        percentage: reflPctMatch ? reflPctMatch[1] + '%' : undefined,
        notes: '按持仓比例自动分配给所有持有者',
      });
    }

    // ═══════════════════════════════════════
    // 4. Detect auto-LP mechanism
    // ═══════════════════════════════════════
    const autoLPPatterns = [
      /liquidityFee|_liquidityFee|autoLP|_autoLP|autoLiquidity/i,
      /swapAndLiquify|_swapAndLiquify|addLiquidity/i,
      /function\s+swapAndLiquify/i,
      /liquidityTax|lpFee|_lpFee|lpTax/i,
    ];

    for (const pattern of autoLPPatterns) {
      if (pattern.test(sourceCode)) {
        hasAutoLP = true;
        break;
      }
    }

    if (hasAutoLP && !destinations.find(d => d.type === 'liquidity')) {
      const lpPctMatch = sourceCode.match(/(?:liquidityFee|_liquidityFee|lpFee|_lpFee|liquidityTax)\s*=\s*(\d+)/i);
      destinations.push({
        type: 'liquidity',
        label: '自动添加流动性',
        percentage: lpPctMatch ? lpPctMatch[1] + '%' : undefined,
        notes: '税收自动注入LP池增强流动性',
      });
    }

    // ═══════════════════════════════════════
    // 5. Detect tax percentage allocation from source
    // ═══════════════════════════════════════
    // Many tokens define: marketingFee = 3, devFee = 2, etc.
    const feeVarPatterns = [
      { pattern: /(?:marketing(?:Fee|Tax|Share)|_marketing(?:Fee|Tax))\s*=\s*(\d+)/gi, type: 'marketing' as const },
      { pattern: /(?:dev(?:Fee|Tax|Share)|_dev(?:Fee|Tax)|development(?:Fee|Tax))\s*=\s*(\d+)/gi, type: 'dev' as const },
      { pattern: /(?:treasury(?:Fee|Tax|Share)|_treasury(?:Fee|Tax))\s*=\s*(\d+)/gi, type: 'treasury' as const },
      { pattern: /(?:team(?:Fee|Tax|Share)|_team(?:Fee|Tax))\s*=\s*(\d+)/gi, type: 'team' as const },
      { pattern: /(?:buyback(?:Fee|Tax|Share)|_buyback(?:Fee|Tax))\s*=\s*(\d+)/gi, type: 'buyback' as const },
    ];

    for (const { pattern, type } of feeVarPatterns) {
      let match;
      while ((match = pattern.exec(sourceCode)) !== null) {
        const pct = match[1];
        const existing = destinations.find(d => d.type === type);
        if (existing && !existing.percentage) {
          existing.percentage = pct + '%';
        }
      }
    }

    // ═══════════════════════════════════════
    // 6. Detect tax-related functions
    // ═══════════════════════════════════════
    const taxFuncPatterns = [
      /function\s+(setMarketingWallet|setDevWallet|setTaxWallet|setFeeReceiver|updateMarketingWallet|updateDevWallet|setTreasuryWallet)\s*\(/gi,
      /function\s+(setMarketingFee|setDevFee|setTaxes|updateFees|setFees|setBuyFees|setSellFees|setSwapAndLiquify)\s*\(/gi,
      /function\s+(manualSwap|manualSend|rescueETH|withdrawStuckETH|claimStuckTokens)\s*\(/gi,
    ];

    for (const pattern of taxFuncPatterns) {
      let match;
      while ((match = pattern.exec(sourceCode)) !== null) {
        if (!rawTaxFunctions.includes(match[1])) {
          rawTaxFunctions.push(match[1]);
        }
      }
    }

    // Only return result if we found something meaningful
    if (destinations.length === 0 && !hasBurn && !hasReflection && !hasAutoLP) {
      return null;
    }

    return {
      totalBuyTax: '', // Will be filled from GoPlus data in analyzer
      totalSellTax: '',
      destinations,
      hasBurn,
      hasReflection,
      hasAutoLP,
      rawTaxFunctions: rawTaxFunctions.length > 0 ? rawTaxFunctions : undefined,
    };
  }
}
