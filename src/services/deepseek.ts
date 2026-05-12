import axios, { AxiosInstance } from 'axios';
import { modelManager, aiConfig } from '../config';
import { ContractAnalysis } from '../types';

// Create client dynamically based on current provider
function createClient(): AxiosInstance {
  // Strip trailing slashes to avoid double-slash issues (e.g. https://example.com//v1)
  const rawUrl = modelManager.getBaseUrl().replace(/\/+$/, '');
  const baseURL = rawUrl.endsWith('/v1') ? rawUrl : `${rawUrl}/v1`;
  const instance = axios.create({
    baseURL,
    timeout: 90000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${modelManager.getApiKey()}`,
    },
  });
  return instance;
}

// Use getter to always get fresh client with current provider config
function getClient(): AxiosInstance {
  return createClient();
}

/**
 * Retry wrapper for API calls
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = 2, delayMs: number = 2000): Promise<T> {
  let lastError: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const status = error?.response?.status;
      // Don't retry on 4xx errors (except 429 rate limit)
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw error;
      }
      if (i < maxRetries) {
        const wait = delayMs * (i + 1); // Linear backoff
        console.log(`[DeepSeek] Retry ${i + 1}/${maxRetries} after ${wait}ms...`);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }
  throw lastError;
}

export class DeepSeekService {
  /**
   * List available models from the API provider
   */
  async listModels(): Promise<string[]> {
    const baseUrl = modelManager.getBaseUrl();
    const apiUrl = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
    console.log(`[DeepSeek] Fetching models from: ${apiUrl}/models`);
    try {
      const res = await getClient().get('/models');
      const data = res.data;
      // Handle different response formats from various providers
      const models = data?.data || data?.models || [];
      if (!Array.isArray(models)) {
        console.error('[DeepSeek] Unexpected models response format:', JSON.stringify(data).slice(0, 500));
        throw new Error('模型列表格式异常');
      }
      return models.map((m: any) => m.id || m.name || m).filter(Boolean).sort();
    } catch (error: any) {
      const status = error?.response?.status;
      const errMsg = error?.response?.data?.error?.message || error?.response?.data?.message || error?.message;
      console.error(`[DeepSeek] listModels error (status=${status}):`, error?.response?.data || error?.message);
      if (status === 401) throw new Error('API Key 无效');
      if (status === 403) throw new Error('无权限访问模型列表');
      if (status === 404) throw new Error(`该提供商不支持 /models 接口 (${apiUrl}/models 返回 404)`);
      throw new Error(`获取模型列表失败: ${errMsg}`);
    }
  }

  /**
   * General chat: send a message directly to the AI model
   */
  async chat(message: string): Promise<string> {
    if (!aiConfig.apiKey) {
      return 'AI不可用：未配置 API Key';
    }

    const currentModel = modelManager.getModel();
    console.log(`[DeepSeek] Chat request, model: ${currentModel}, msg length: ${message.length}`);

    try {
      modelManager.trackCall();
      const res = await withRetry(() => getClient().post('/chat/completions', {
        model: currentModel,
        messages: [
          {
            role: 'system',
            content: '你是一个专业的加密货币和区块链助手。用中文简洁回答用户问题。',
          },
          { role: 'user', content: message },
        ],
        temperature: 0.7,
      }));

      const content = res.data?.choices?.[0]?.message?.content;
      return content || 'AI 返回为空';
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 401) return 'AI不可用：API Key 无效';
      if (status === 429) return 'AI请求频率超限，稍后重试';
      if (error.code === 'ECONNABORTED') return 'AI请求超时';
      return `AI请求失败: ${error?.message || 'unknown'}`;
    }
  }

  /**
   * Analyze contract data and provide comprehensive risk assessment
   * Feeds full contract source code + all collected data to AI
   */
  async analyzeContract(analysis: ContractAnalysis): Promise<string> {
    // Check if API key is configured
    if (!aiConfig.apiKey) {
      console.warn('[DeepSeek] API key not configured');
      return 'AI分析不可用：未配置 API Key';
    }

    const prompt = this.buildPrompt(analysis);
    const currentModel = modelManager.getModel();
    console.log(`[DeepSeek] Analyzing contract, prompt length: ${prompt.length} chars, model: ${currentModel}`);

    try {
      modelManager.trackCall();
      const res = await withRetry(() => getClient().post('/chat/completions', {
        model: currentModel,
        messages: [
          {
            role: 'system',
            content: `你是一个专业的链上memecoin合约审计师和代币分析师。你的任务是根据提供的合约源码和链上数据，全面分析这个代币合约。

输出格式要求（严格按此格式）：

📌 代币概述：这是什么类型的代币，核心机制是什么（如标准ERC20、带税代币、通缩代币、rebase代币等），是否来自发射台（如有发射台信息，说明该台子的特点和对代币安全性的影响）

⚙️ 合约功能：
• [列出合约实现的核心功能，如：买卖税收、黑名单、最大持仓限制、自动LP、分红等]

💸 税收分析（如果代币有买卖税）：
• 税率结构：分别列出买入税和卖出税的各项组成
• 税收去向：每项税收流向哪里（营销钱包、开发者钱包、自动加池、销毁、持有者分红、回购等），给出具体钱包地址（如果源码中有）
• 税收用途评估：这些税收去向是否合理？是否存在开发者可以随意提取大量资金的风险？
• 可修改性：Owner是否能修改税率或更换接收钱包？最高可设置到多少？

⚠️ 风险等级：高/中/低

🚨 风险点：
• [列出所有检测到的安全风险，包括Owner权限、可修改参数、后门函数等]

✅ 安全特征：
• [列出正面的安全特征，如Owner已放弃、税率不可修改、无黑名单等]

💡 总结：2-3句话概括该合约的安全性和功能特点

规则：
- 如果有源码，重点分析源码中的逻辑，特别关注税收相关的_transfer函数
- 不要给出是否适合入场/交易的建议
- 只做技术层面的客观分析
- 使用中文
- 确保每个章节完整输出，不要中途截断`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
      }));

      const content = res.data?.choices?.[0]?.message?.content;
      if (!content) {
        console.error('[DeepSeek] Empty response. Full response:', JSON.stringify(res.data).slice(0, 500));
        return 'AI分析返回为空，请稍后重试';
      }
      return content;
    } catch (error: any) {
      const status = error?.response?.status;
      const errData = error?.response?.data;
      console.error(`[DeepSeek] Error (status=${status}):`, JSON.stringify(errData || error.message).slice(0, 500));

      if (status === 401) return 'AI分析不可用：API Key 无效';
      if (status === 429) return 'AI分析不可用：请求频率超限，稍后重试';
      if (status === 404) return `AI分析不可用：模型 "${currentModel}" 不存在，请检查配置`;
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return 'AI分析超时，请稍后重试';

      return 'AI分析暂时不可用';
    }
  }

  /**
   * Trim large source code by removing standard library files and keeping custom logic
   */
  private trimSourceCode(source: string, maxLen: number): string {
    // If source is multi-file format (separated by "// === filename ==="), parse and filter
    const filePattern = /\/\/ === (.+?) ===/g;
    const files: Array<{ name: string; content: string; start: number }> = [];
    let match;
    const positions: number[] = [];

    while ((match = filePattern.exec(source)) !== null) {
      positions.push(match.index);
      files.push({ name: match[1], content: '', start: match.index });
    }

    if (files.length > 1) {
      // Extract content for each file
      for (let i = 0; i < files.length; i++) {
        const end = i + 1 < files.length ? files[i + 1].start : source.length;
        files[i].content = source.slice(files[i].start, end);
      }

      // Filter out known library files (OpenZeppelin, interfaces, etc.)
      const libraryPatterns = [
        /openzeppelin/i, /\/@oz\//i, /SafeMath/i, /IERC20\.sol/i,
        /ERC20\.sol/i, /Ownable\.sol/i, /Context\.sol/i, /Address\.sol/i,
        /SafeERC20\.sol/i, /ReentrancyGuard\.sol/i, /Pausable\.sol/i,
        /IERC20Metadata/i, /ERC20Burnable/i,
      ];

      const customFiles = files.filter(f => !libraryPatterns.some(p => p.test(f.name)));
      const libFiles = files.filter(f => libraryPatterns.some(p => p.test(f.name)));

      // Build output: all custom files first, then library summaries
      let result = customFiles.map(f => f.content).join('\n');

      if (result.length > maxLen) {
        result = result.slice(0, maxLen) + '\n// ... [截断] ...';
      } else if (result.length < maxLen * 0.8) {
        // Add some library files if space allows
        for (const lib of libFiles) {
          if (result.length + lib.content.length < maxLen) {
            result += '\n' + lib.content;
          }
        }
      }

      if (libFiles.length > 0) {
        result += `\n\n// [已省略 ${libFiles.length} 个标准库文件: ${libFiles.map(f => f.name).join(', ')}]`;
      }

      return result;
    }

    // Single file or no file markers: truncate intelligently
    // Try to keep the _transfer function and constructor which contain the core logic
    const transferMatch = source.match(/function\s+_transfer[\s\S]{0,5000}/);
    const constructorMatch = source.match(/constructor[\s\S]{0,3000}/);

    let result = '';
    if (transferMatch) {
      result += '// === _transfer 核心逻辑 ===\n' + transferMatch[0] + '\n\n';
    }
    if (constructorMatch) {
      result += '// === constructor ===\n' + constructorMatch[0] + '\n\n';
    }

    // Fill remaining space with the beginning of the source
    const remaining = maxLen - result.length;
    if (remaining > 1000) {
      result = source.slice(0, remaining) + '\n// ... [截断，共 ' + source.length + ' 字符] ...\n\n' + result;
    }

    return result.slice(0, maxLen);
  }

  /**
   * Build comprehensive prompt including all collected data and full source code
   */
  private buildPrompt(analysis: ContractAnalysis): string {
    let prompt = `=== 代币基本信息 ===\n`;
    prompt += `链: ${analysis.chain}\n`;
    prompt += `合约地址: ${analysis.address}\n`;
    if (analysis.tokenName) prompt += `代币名: ${analysis.tokenName} (${analysis.tokenSymbol})\n`;
    if (analysis.priceUsd) prompt += `价格: $${analysis.priceUsd}\n`;
    if (analysis.marketCap) prompt += `市值: $${analysis.marketCap}\n`;
    if (analysis.liquidity) prompt += `流动性: $${analysis.liquidity}\n`;
    if (analysis.volume24h) prompt += `24h交易量: $${analysis.volume24h}\n`;
    if (analysis.poolCreatedAt) prompt += `池子创建时间: ${analysis.poolCreatedAt}\n`;

    if (analysis.socials) {
      if (analysis.socials.website) prompt += `官网: ${analysis.socials.website}\n`;
      if (analysis.socials.twitter) prompt += `Twitter: ${analysis.socials.twitter}\n`;
      if (analysis.socials.telegram) prompt += `Telegram: ${analysis.socials.telegram}\n`;
      if (analysis.socials.description) prompt += `项目描述: ${analysis.socials.description}\n`;
    }

    if (analysis.deployedAt) {
      prompt += `合约部署时间: ${analysis.deployedAt}\n`;
    }

    if (analysis.launchpad) {
      prompt += `\n=== 发射台检测 ===\n`;
      if (analysis.launchpad.isFromLaunchpad) {
        prompt += `来源: ${analysis.launchpad.launchpadName || '未知发射台'}\n`;
        prompt += `类型: ${analysis.launchpad.launchpadType || 'unknown'}\n`;
        prompt += `置信度: ${analysis.launchpad.confidence}%\n`;
        prompt += `说明: 该代币通过发射台创建，请结合该发射台的机制特点进行分析（如bonding_curve类台子通常无预售、流动性自动添加；presale类台子需关注解锁时间等）\n`;
      } else {
        prompt += `该代币非发射台创建（独立部署合约）\n`;
      }
    }

    if (analysis.ownershipStatus) {
      prompt += `\n=== 所有权状态 ===\n`;
      if (analysis.ownershipStatus.renounced) {
        prompt += `✅ 所有权已放弃 (链上验证: ${analysis.ownershipStatus.verifiedOnChain ? '已确认' : '未确认'})\n`;
        if (analysis.ownershipStatus.timestamp) {
          prompt += `放弃时间: ${analysis.ownershipStatus.timestamp}\n`;
        }
      } else {
        prompt += `⚠️ 所有权未放弃\n`;
      }
    }

    if (analysis.lpLock) {
      prompt += `\n=== LP锁定状态 ===\n`;
      prompt += `锁定比例: ${analysis.lpLock.totalLockedPercent}%\n`;
      for (const locker of analysis.lpLock.lockers) {
        prompt += `  - ${locker.name}: ${locker.percent.toFixed(1)}% (${locker.address})\n`;
      }
    }

    // Security scan data
    if (analysis.security) {
      const s = analysis.security;
      prompt += `\n=== GoPlus安全扫描结果 ===\n`;
      prompt += `蜜罐: ${s.isHoneypot ? '是' : '否'}\n`;
      prompt += `买入税: ${s.buyTax}% | 卖出税: ${s.sellTax}%\n`;
      prompt += `开源: ${s.isOpenSource ? '是' : '否'}\n`;
      prompt += `代理合约: ${s.isProxy ? '是' : '否'}\n`;
      prompt += `可铸造: ${s.isMintable ? '是' : '否'}\n`;
      prompt += `可暂停交易: ${s.transferPausable ? '是' : '否'}\n`;
      prompt += `黑名单功能: ${s.isBlacklisted ? '有' : '无'}\n`;
      prompt += `隐藏Owner: ${s.hiddenOwner ? '是' : '否'}\n`;
      prompt += `Owner可改余额: ${s.ownerCanChangeBalance ? '是' : '否'}\n`;
      prompt += `防鲸: ${s.antiWhale ? '有' : '无'}\n`;
      prompt += `交易冷却: ${s.tradingCooldown ? '有' : '无'}\n`;
      if (s.ownerAddress) prompt += `Owner地址: ${s.ownerAddress}\n`;
      if (s.creatorAddress) prompt += `创建者: ${s.creatorAddress}\n`;
      if (s.holderCount) prompt += `持有者数量: ${s.holderCount}\n`;
    }

    // Tax distribution analysis
    if (analysis.taxDistribution) {
      const td = analysis.taxDistribution;
      prompt += `\n=== 税收去向分析 ===\n`;
      prompt += `买入总税: ${td.totalBuyTax}% | 卖出总税: ${td.totalSellTax}%\n`;
      prompt += `包含销毁机制: ${td.hasBurn ? '是' : '否'}\n`;
      prompt += `包含持有者分红: ${td.hasReflection ? '是' : '否'}\n`;
      prompt += `包含自动加池: ${td.hasAutoLP ? '是' : '否'}\n`;
      if (td.destinations.length > 0) {
        prompt += `\n税收分配去向:\n`;
        td.destinations.forEach(d => {
          prompt += `  - ${d.label} (${d.type})`;
          if (d.percentage) prompt += ` 占比: ${d.percentage}`;
          if (d.address) prompt += ` 地址: ${d.address}`;
          if (d.notes) prompt += ` [${d.notes}]`;
          prompt += '\n';
        });
      }
      if (td.rawTaxFunctions?.length) {
        prompt += `可修改税收的函数: ${td.rawTaxFunctions.join(', ')}\n`;
      }
      prompt += `\n请重点分析：这些税收去向是否合理？Owner是否能无限制提高税率或更换接收钱包？是否存在"貔貅"式隐蔽抽税风险？\n`;
    }

    // Contract functions from ABI analysis
    if (analysis.contractSource?.contractFunctions?.length) {
      const funcs = analysis.contractSource.contractFunctions;
      const writeFuncs = funcs.filter(f => f.stateMutability !== 'view' && f.stateMutability !== 'pure');
      const riskFuncs = funcs.filter(f => f.riskLevel === 'high' || f.riskLevel === 'medium');

      prompt += `\n=== ABI函数分析 ===\n`;
      prompt += `合约名: ${analysis.contractSource.contractName || 'Unknown'}\n`;
      prompt += `总函数: ${funcs.length} | 写入函数: ${writeFuncs.length} | 风险函数: ${riskFuncs.length}\n`;

      if (riskFuncs.length > 0) {
        prompt += `\n高/中风险函数:\n`;
        riskFuncs.forEach(f => {
          const ownerTag = f.isOwnerOnly ? ' [onlyOwner]' : '';
          prompt += `  - ${f.name}(${f.inputs})${ownerTag} [${f.riskLevel}] ${f.riskNote || ''}\n`;
        });
      }
    }

    // FULL CONTRACT SOURCE CODE - this is the key data for AI deep analysis
    // Cap source code at 30000 chars to avoid DeepSeek timeout (900s server limit)
    if (analysis.contractSource?.isVerified && analysis.contractSource.sourceCode) {
      let source = analysis.contractSource.sourceCode;
      const MAX_SOURCE_LEN = 30000;

      if (source.length > MAX_SOURCE_LEN) {
        // Strip standard OpenZeppelin/library code and keep custom logic
        source = this.trimSourceCode(source, MAX_SOURCE_LEN);
        prompt += `\n=== 合约源码 (已精简，原始 ${analysis.contractSource.sourceCode.length} 字符) ===\n`;
      } else {
        prompt += `\n=== 合约完整源码 ===\n`;
      }
      prompt += source;
      prompt += `\n=== 源码结束 ===\n`;
    } else if (analysis.contractSource && !analysis.contractSource.isVerified) {
      prompt += `\n=== 合约源码 ===\n未验证（无法获取源码）\n`;
    }

    // Trading metrics
    if (analysis.rawData?.dexscreener) {
      const dx = analysis.rawData.dexscreener;
      prompt += `\n=== 交易数据 ===\n`;
      if (dx.buyCount24h !== undefined) prompt += `24h买入: ${dx.buyCount24h}次\n`;
      if (dx.sellCount24h !== undefined) prompt += `24h卖出: ${dx.sellCount24h}次\n`;
      if (dx.priceChange24h !== undefined) prompt += `24h涨跌: ${dx.priceChange24h}%\n`;
    }

    // Holder data
    if (analysis.rawData?.holders) {
      const h = analysis.rawData.holders;
      prompt += `\n=== 持仓分布 ===\n`;
      prompt += `总持有者: ${h.totalHolders || '未知'}\n`;
      prompt += `Top10集中度: ${h.top10Concentration}%\n`;
      prompt += `Top20集中度: ${h.top20Concentration}%\n`;
      if (h.creatorHolding) prompt += `创建者持仓: ${h.creatorHolding}\n`;
      if (h.topHolders?.length) {
        prompt += `前5持仓:\n`;
        h.topHolders.slice(0, 5).forEach((holder: any, i: number) => {
          prompt += `  ${i + 1}. ${holder.address.slice(0, 10)}... ${holder.percent}${holder.isContract ? ' (合约)' : ''}\n`;
        });
      }
    }

    // Solana RugCheck
    if (analysis.rawData?.rugcheck) {
      const r = analysis.rawData.rugcheck;
      prompt += `\n=== RugCheck (Solana) ===\n`;
      prompt += `风险等级: ${r.riskLevel}\n`;
      prompt += `Mint Authority: ${r.mintAuthority || '已放弃'}\n`;
      prompt += `Freeze Authority: ${r.freezeAuthority || '已放弃'}\n`;
      prompt += `LP已燃烧: ${r.lpBurned ? '是' : '否'}\n`;
      if (r.risks?.length) {
        prompt += `风险项: ${r.risks.slice(0, 5).join('; ')}\n`;
      }
    }

    return prompt;
  }
}
