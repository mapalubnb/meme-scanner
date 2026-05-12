import * as lark from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import { config, modelManager } from '../config';
import { ContractAnalysis } from '../types';

export class FeishuService {
  private client: lark.Client;
  private tokenCache: { token: string; expiresAt: number } | null = null;

  constructor() {
    this.client = new lark.Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      disableTokenCache: false,
    });
  }

  /**
   * Send startup/restart notification card to configured chat
   */
  async sendStartupNotification() {
    const chatId = config.feishu.chatId;
    if (!chatId) {
      console.log('[Feishu] No FEISHU_CHAT_ID configured, skipping startup notification');
      return;
    }

    const now = new Date();
    const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '🟢 Meme Scanner 服务启动' },
        template: 'green',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: [
              '🚀 **服务已启动/重启**',
              '',
              `⏰ 时间: ${timeStr}`,
              `🤖 AI模型: ${modelManager.getModel()}`,
              `🔗 连接方式: 飞书长连接 (WebSocket)`,
              '',
              '📋 支持功能:',
              '• 多链合约检测 (ETH/BSC/Base/ARB/SOL/TRON)',
              '• GoPlus 安全扫描',
              '• 合约函数风险分析',
              '• 持仓集中度分析',
              '• AI 合约审计',
              '',
              '发送合约地址即可开始分析 ✅',
            ].join('\n'),
          },
        },
      ],
    };

    try {
      await this.client.im.message.create({
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
        params: { receive_id_type: 'chat_id' },
      });
      console.log('[Feishu] Startup notification sent');
    } catch (error: any) {
      console.error('[Feishu] Startup notification error:', error?.response?.data || error?.message || error);
    }
  }

  /**
   * Get tenant_access_token for raw API calls (cached with TTL)
   */
  private async getTenantToken(): Promise<string> {
    // Return cached token if still valid (with 5-minute safety margin)
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }

    const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    });
    if (res.data?.code !== 0) {
      throw new Error(`Get tenant token failed: ${JSON.stringify(res.data)}`);
    }

    const token = res.data.tenant_access_token;
    const expire = res.data.expire || 7200; // Default 2 hours
    this.tokenCache = {
      token,
      expiresAt: Date.now() + (expire - 300) * 1000, // Expire 5 minutes early
    };
    return token;
  }

  /**
   * Upload an image URL to Feishu and get img_key
   * Uses raw HTTP API directly (bypassing Lark SDK file upload issues)
   */
  async uploadImageFromUrl(imageUrl: string): Promise<string | null> {
    try {
      // Step 1: Download image with browser-like headers to avoid CDN blocks
      console.log(`[Feishu] Downloading image: ${imageUrl}`);
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxRedirects: 5,
        headers: {
          'Accept': 'image/png, image/jpeg, image/gif, image/webp, image/avif, */*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Referer': new URL(imageUrl).origin,
        },
      });

      let buffer = Buffer.from(response.data);
      const contentType = String(response.headers['content-type'] || '').toLowerCase();

      console.log(`[Feishu] Downloaded: ${buffer.length} bytes, content-type="${contentType}", status=${response.status}`);

      // Step 1.5: Validate this is actually an image (check magic bytes)
      if (buffer.length < 8) {
        console.error('[Feishu] Downloaded buffer too small, likely not an image');
        return null;
      }

      const magicHex = buffer.slice(0, 8).toString('hex');
      const isJPEG = magicHex.startsWith('ffd8ff');
      const isPNG = magicHex.startsWith('89504e47');
      const isGIF = magicHex.startsWith('474946');
      const isWebP = magicHex.startsWith('52494646') && buffer.slice(8, 12).toString('ascii') === 'WEBP';
      const isSVG = buffer.slice(0, 100).toString('utf8').trim().startsWith('<svg') ||
                    buffer.slice(0, 100).toString('utf8').trim().startsWith('<?xml');
      const isBMP = magicHex.startsWith('424d');

      console.log(`[Feishu] Magic bytes: ${magicHex.slice(0, 16)} | Detected: JPEG=${isJPEG} PNG=${isPNG} GIF=${isGIF} WebP=${isWebP} SVG=${isSVG} BMP=${isBMP}`);

      if (!isJPEG && !isPNG && !isGIF && !isWebP && !isSVG && !isBMP) {
        // Might be HTML error page or unknown format
        const textPreview = buffer.slice(0, 200).toString('utf8');
        if (textPreview.includes('<html') || textPreview.includes('<!DOCTYPE')) {
          console.error('[Feishu] Downloaded content is HTML, not an image:', textPreview.slice(0, 100));
          return null;
        }
        console.warn('[Feishu] Unknown image format, attempting upload anyway...');
      }

      // Step 2: Convert to PNG if format is not natively supported by Feishu
      // Feishu im/v1/images accepts: JPEG, PNG, GIF, BMP (NOT WebP, NOT SVG, NOT AVIF)
      let uploadContentType = contentType.split(';')[0].trim();
      let filename = 'token.png';

      if (isWebP || isSVG || (!isJPEG && !isPNG && !isGIF && !isBMP)) {
        // Need to convert to PNG using sharp
        try {
          const sharp = (await import('sharp')).default;
          buffer = await sharp(buffer)
            .png({ quality: 90, compressionLevel: 6 })
            .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
            .toBuffer();
          uploadContentType = 'image/png';
          filename = 'token.png';
          console.log(`[Feishu] Converted to PNG: ${buffer.length} bytes`);
        } catch (convertError: any) {
          console.error('[Feishu] sharp conversion failed:', convertError?.message);
          // If WebP and sharp fails, we cannot upload to Feishu
          if (isWebP || isSVG) {
            console.error('[Feishu] Cannot upload WebP/SVG without conversion. Install sharp: npm install sharp');
            return null;
          }
          // For other formats, try uploading as-is
        }
      } else if (isJPEG) {
        uploadContentType = 'image/jpeg';
        filename = 'token.jpg';
      } else if (isPNG) {
        uploadContentType = 'image/png';
        filename = 'token.png';
      } else if (isGIF) {
        uploadContentType = 'image/gif';
        filename = 'token.gif';
      } else if (isBMP) {
        uploadContentType = 'image/bmp';
        filename = 'token.bmp';
      }

      // Step 3: Get fresh tenant token
      const token = await this.getTenantToken();
      console.log(`[Feishu] Got tenant token: ${token.slice(0, 10)}...`);

      // Step 4: Upload to Feishu with proper form-data
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      form.append('image_type', 'message');
      form.append('image', buffer, {
        filename,
        contentType: uploadContentType,
      });

      const uploadRes = await axios.post(
        'https://open.feishu.cn/open-apis/im/v1/images',
        form,
        {
          headers: {
            ...form.getHeaders(),
            'Authorization': `Bearer ${token}`,
          },
          timeout: 20000,
        }
      );

      console.log(`[Feishu] Upload response (code=${uploadRes.data?.code}):`, JSON.stringify(uploadRes.data).slice(0, 400));

      if (uploadRes.data?.code === 0 && uploadRes.data?.data?.image_key) {
        const imgKey = uploadRes.data.data.image_key;
        console.log(`[Feishu] ✅ Image uploaded: ${imgKey}`);
        return imgKey;
      }

      // Diagnose common error codes
      const errCode = uploadRes.data?.code;
      const errMsg = uploadRes.data?.msg || uploadRes.data?.message || '';
      if (errCode === 99991672 || errMsg.includes('permission')) {
        console.error('[Feishu] ❌ PERMISSION DENIED: App lacks "im:resource" scope. Go to Feishu Open Platform → App → Permissions → add "im:resource" and re-publish.');
      } else if (errCode === 99991668) {
        console.error('[Feishu] ❌ Invalid token. Check FEISHU_APP_ID and FEISHU_APP_SECRET.');
      } else if (errCode === 99991663) {
        console.error('[Feishu] ❌ Image format not supported by Feishu.');
      }

      return null;
    } catch (error: any) {
      const status = error?.response?.status;
      const errData = error?.response?.data;
      console.error(`[Feishu] Image upload pipeline error (HTTP ${status}):`, errData || error?.message || error);

      // Common download failures
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        console.error('[Feishu] Image download timed out');
      } else if (status === 403 || status === 401) {
        console.error('[Feishu] Image CDN returned 403/401 - may need different User-Agent or the URL expired');
      }

      return null;
    }
  }

  /**
   * Reply to a message with analysis result (without AI, shows "AI分析中..." placeholder)
   * Returns the reply message_id for later patching
   */
  async replyAnalysis(_chatId: string, messageId: string, analysis: ContractAnalysis): Promise<string | null> {
    // Upload token image if available
    let tokenImgKey: string | null = null;
    if (analysis.tokenImageUrl) {
      tokenImgKey = await this.uploadImageFromUrl(analysis.tokenImageUrl);
    }

    // Cache imgKey on analysis object for later use in patch
    (analysis as any)._tokenImgKey = tokenImgKey;

    const card = this.buildAnalysisCard(analysis, tokenImgKey);

    try {
      const res: any = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
      });
      const replyMsgId = res?.data?.message_id || res?.message_id;
      console.log(`[Feishu] Card sent, reply message_id: ${replyMsgId}`);
      return replyMsgId || null;
    } catch (error: any) {
      console.error('[Feishu] Card reply error:', error?.response?.data || error?.message || error);
      // Fallback to text message
      try {
        await this.replyText(messageId, this.buildTextResult(analysis));
      } catch (fallbackError: any) {
        console.error('[Feishu] Text fallback also failed:', fallbackError?.response?.data || fallbackError?.message);
      }
      return null;
    }
  }

  /**
   * Update an existing card message with AI analysis results
   * Uses im.message.patch to update the card content in-place
   */
  async patchAnalysisCard(replyMessageId: string, analysis: ContractAnalysis) {
    const tokenImgKey = (analysis as any)._tokenImgKey || null;
    const card = this.buildAnalysisCard(analysis, tokenImgKey);

    try {
      await this.client.im.message.patch({
        path: { message_id: replyMessageId },
        data: {
          content: JSON.stringify(card),
        },
      });
      console.log(`[Feishu] Card patched with AI analysis: ${replyMessageId}`);
    } catch (error: any) {
      console.error('[Feishu] Card patch error:', error?.response?.data || error?.message || error);
      // If patch fails, try sending AI result as a separate text reply
      if (analysis.aiAnalysis) {
        try {
          await this.replyText(replyMessageId, `🤖 AI 合约审计\n\n${analysis.aiAnalysis}`);
        } catch {
          // Give up
        }
      }
    }
  }

  /**
   * Send processing status
   */
  async replyText(messageId: string, text: string) {
    try {
      await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    } catch (error) {
      console.error('[Feishu] Text reply error:', error);
    }
  }

  /**
   * Get block explorer URL for an address
   */
  private getExplorerUrl(chain: string, address: string): string {
    const explorers: Record<string, string> = {
      ethereum: `https://etherscan.io/address/${address}`,
      bsc: `https://bscscan.com/address/${address}`,
      base: `https://basescan.org/address/${address}`,
      arbitrum: `https://arbiscan.io/address/${address}`,
      solana: `https://solscan.io/account/${address}`,
      tron: `https://tronscan.org/#/address/${address}`,
    };
    return explorers[chain] || `https://etherscan.io/address/${address}`;
  }

  /**
   * Get block explorer URL for a token contract
   */
  private getTokenExplorerUrl(chain: string, address: string): string {
    const explorers: Record<string, string> = {
      ethereum: `https://etherscan.io/token/${address}`,
      bsc: `https://bscscan.com/token/${address}`,
      base: `https://basescan.org/token/${address}`,
      arbitrum: `https://arbiscan.io/token/${address}`,
      solana: `https://solscan.io/token/${address}`,
      tron: `https://tronscan.org/#/token20/${address}`,
    };
    return explorers[chain] || `https://etherscan.io/token/${address}`;
  }

  /**
   * Format number with K/M/B suffix
   */
  private formatNumber(num: number | string | undefined): string {
    if (!num) return '-';
    const n = typeof num === 'string' ? parseFloat(num) : num;
    if (isNaN(n)) return '-';
    if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
    if (n >= 1) return `$${n.toFixed(2)}`;
    if (n >= 0.0001) return `$${n.toFixed(6)}`;
    return `$${n.toExponential(2)}`;
  }

  /**
   * Format raw number (no $ prefix)
   */
  private formatRawNumber(num: number | string | undefined): string {
    if (!num) return '-';
    const n = typeof num === 'string' ? parseFloat(num) : num;
    if (isNaN(n)) return '-';
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
    return n.toFixed(2);
  }

  /**
   * Format time ago
   */
  private timeAgo(dateStr: string | undefined): string {
    if (!dateStr) return '-';
    const created = new Date(dateStr).getTime();
    const now = Date.now();
    const diff = now - created;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (days > 0) return `${days}天前`;
    if (hours > 0) return `${hours}小时前`;
    return `${mins}分钟前`;
  }

  /**
   * Build interactive card for analysis result
   */
  private buildAnalysisCard(analysis: ContractAnalysis, tokenImgKey?: string | null) {
    const riskColor = this.getRiskColor(analysis);
    const elements: any[] = [];
    const dx = analysis.rawData?.dexscreener;

    // ═══════════════════════════════════════
    // 📋 基本信息
    // ═══════════════════════════════════════
    const chainEmoji: Record<string, string> = {
      ethereum: '🔷', bsc: '🟡', base: '🔵', arbitrum: '🔶', solana: '🟣', tron: '🔴'
    };
    const emoji = chainEmoji[analysis.chain] || '⬜';

    const contractUrl = this.getTokenExplorerUrl(analysis.chain, analysis.address);
    let imageStatus = '';
    if (!tokenImgKey) {
      imageStatus = analysis.tokenImageUrl
        ? ` | [🖼️ 头像](${analysis.tokenImageUrl})`
        : ' | 🖼️ 头像未获取';
    }

    const infoLines = [
      `${emoji} **${analysis.chain.toUpperCase()}** | 🪙 **${analysis.tokenName || 'Unknown'}** (\`${analysis.tokenSymbol || '?'}\`)${imageStatus}`,
      `📝 合约: [${analysis.address}](${contractUrl})`,
    ];

    // Social links
    if (analysis.socials) {
      const links: string[] = [];
      if (analysis.socials.website) links.push(`[🌐 官网](${analysis.socials.website})`);
      if (analysis.socials.twitter) links.push(`[🐦 Twitter](${analysis.socials.twitter})`);
      if (analysis.socials.telegram) links.push(`[💬 Telegram](${analysis.socials.telegram})`);
      if (analysis.socials.discord) links.push(`[🎮 Discord](${analysis.socials.discord})`);
      if (links.length > 0) {
        infoLines.push(`🔗 ${links.join(' | ')}`);
      }
    }

    if (analysis.socials?.description) {
      // Truncate long descriptions
      const desc = analysis.socials.description.length > 100
        ? analysis.socials.description.slice(0, 100) + '...'
        : analysis.socials.description;
      infoLines.push(`📄 ${desc}`);
    }

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: infoLines.join('\n'),
      },
    });

    elements.push({ tag: 'hr' });

    // ═══════════════════════════════════════
    // 💰 市场数据
    // ═══════════════════════════════════════
    const priceStr = this.formatNumber(analysis.priceUsd);
    const mcapStr = this.formatNumber(analysis.marketCap);
    const liqStr = this.formatNumber(analysis.liquidity);
    const vol24Str = this.formatNumber(analysis.volume24h);

    const marketLines = ['💰 **市场数据**', ''];
    marketLines.push(`💲 价格: **${priceStr}**`);
    marketLines.push(`📊 市值: **${mcapStr}**`);
    marketLines.push(`🏦 流动性: **${liqStr}**`);
    marketLines.push(`📈 24h交易量: **${vol24Str}**`);

    if (dx?.priceNative && dx?.quoteTokenSymbol) {
      marketLines.push(`💱 报价: ${dx.priceNative} ${dx.quoteTokenSymbol}`);
    }

    // Price changes
    if (dx) {
      const changes: string[] = [];
      if (dx.priceChange5m !== undefined) {
        const e5 = dx.priceChange5m >= 0 ? '🟢' : '🔴';
        changes.push(`${e5} 5m: ${dx.priceChange5m > 0 ? '+' : ''}${dx.priceChange5m}%`);
      }
      if (dx.priceChange1h !== undefined) {
        const e1 = dx.priceChange1h >= 0 ? '🟢' : '🔴';
        changes.push(`${e1} 1h: ${dx.priceChange1h > 0 ? '+' : ''}${dx.priceChange1h}%`);
      }
      if (dx.priceChange24h !== undefined) {
        const e24 = dx.priceChange24h >= 0 ? '🟢' : '🔴';
        changes.push(`${e24} 24h: ${dx.priceChange24h > 0 ? '+' : ''}${dx.priceChange24h}%`);
      }
      if (changes.length) {
        marketLines.push('');
        marketLines.push('📉 **涨跌幅:** ' + changes.join(' | '));
      }
    }

    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: marketLines.join('\n') },
    });

    elements.push({ tag: 'hr' });

    // ═══════════════════════════════════════
    // 🏊 流动性池信息
    // ═══════════════════════════════════════
    if (dx) {
      const poolLines = ['🏊 **流动性池**', ''];
      // Show full DEX name with version (e.g., "PancakeSwap V2")
      if (dx.dexFullName) {
        poolLines.push(`🏪 DEX: **${dx.dexFullName}**`);
      } else if (dx.dexName) {
        poolLines.push(`🏪 DEX: **${dx.dexName}**`);
      }
      if (dx.pairAddress) {
        const poolUrl = this.getExplorerUrl(analysis.chain, dx.pairAddress);
        poolLines.push(`📍 池地址: [${dx.pairAddress.slice(0, 6)}...${dx.pairAddress.slice(-4)}](${poolUrl})`);
      }
      if (dx.quoteTokenSymbol) {
        poolLines.push(`🪙 交易对: ${analysis.tokenSymbol || '?'} / ${dx.quoteTokenSymbol}`);
      }
      if (dx.liquidityBase !== undefined && dx.liquidityQuote !== undefined) {
        poolLines.push(`💧 底池: ${this.formatRawNumber(dx.liquidityBase)} ${analysis.tokenSymbol || ''} + ${this.formatRawNumber(dx.liquidityQuote)} ${dx.quoteTokenSymbol || ''}`);
      }
      poolLines.push(`⏰ 池创建: ${this.timeAgo(analysis.poolCreatedAt)}`);
      if (analysis.deployedAt) {
        poolLines.push(`📅 合约部署: ${this.timeAgo(analysis.deployedAt)}`);
      }
      if (dx.pairCount) poolLines.push(`🔢 交易对数量: ${dx.pairCount}`);

      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: poolLines.join('\n') },
      });
      elements.push({ tag: 'hr' });
    }

    // ═══════════════════════════════════════
    // 📊 交易活跃度
    // ═══════════════════════════════════════
    if (dx && (dx.buyCount24h !== undefined || dx.sellCount24h !== undefined)) {
      const txLines = ['📊 **交易活跃度**', ''];

      if (dx.buyCount1h !== undefined && dx.sellCount1h !== undefined) {
        const r1h = dx.sellCount1h > 0 ? (dx.buyCount1h / dx.sellCount1h).toFixed(2) : '∞';
        txLines.push(`🕐 1h: 🟢买 ${dx.buyCount1h} | 🔴卖 ${dx.sellCount1h} | 比 ${r1h}`);
      }
      if (dx.buyCount24h !== undefined && dx.sellCount24h !== undefined) {
        const r24h = dx.sellCount24h > 0 ? (dx.buyCount24h / dx.sellCount24h).toFixed(2) : '∞';
        txLines.push(`🕐 24h: 🟢买 ${dx.buyCount24h} | 🔴卖 ${dx.sellCount24h} | 比 ${r24h}`);
      }
      if (dx.volume1h) txLines.push(`💵 1h量: ${this.formatNumber(dx.volume1h)}`);

      if (dx.dexUrl) txLines.push(`\n🔗 [查看图表](${dx.dexUrl})`);

      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: txLines.join('\n') },
      });
      elements.push({ tag: 'hr' });
    }

    // ═══════════════════════════════════════
    // 🚀 发射台
    // ═══════════════════════════════════════
    if (analysis.launchpad) {
      const lpContent = analysis.launchpad.isFromLaunchpad
        ? `🚀 **发射台:** ${analysis.launchpad.launchpadName} | 类型: ${analysis.launchpad.launchpadType} | 置信度: ${analysis.launchpad.confidence}%`
        : `🚀 **发射台:** 非台子发射（独立部署）`;
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: lpContent },
      });
      elements.push({ tag: 'hr' });
    }

    // ═══════════════════════════════════════
    // 🛡️ 安全检测
    // ═══════════════════════════════════════
    if (analysis.security) {
      const s = analysis.security;

      const secLines = ['🛡️ **合约安全检测**', ''];

      // Tax info (prominent)
      const buyTax = parseFloat(s.buyTax) || 0;
      const sellTax = parseFloat(s.sellTax) || 0;
      const taxEmoji = (buyTax > 5 || sellTax > 5) ? '🚨' : (buyTax > 0 || sellTax > 0) ? '⚠️' : '✅';
      secLines.push(`${taxEmoji} **税率: 买 ${s.buyTax}% / 卖 ${s.sellTax}%**`);
      secLines.push('');

      // Status grid
      secLines.push(`🍯 蜜罐: ${s.isHoneypot ? '❌ 是！危险！' : '✅ 否'}`);
      secLines.push(`📖 开源: ${s.isOpenSource ? '✅ 是' : '❌ 否'}`);
      secLines.push(`🔄 代理合约: ${s.isProxy ? '⚠️ 是' : '✅ 否'}`);
      secLines.push(`🖨️ 可增发: ${s.isMintable ? '⚠️ 是' : '✅ 否'}`);
      secLines.push(`⏸️ 可暂停交易: ${s.transferPausable ? '⚠️ 是' : '✅ 否'}`);
      secLines.push(`🚫 黑名单功能: ${s.isBlacklisted ? '⚠️ 有' : '✅ 无'}`);
      secLines.push(`👻 隐藏Owner: ${s.hiddenOwner ? '⚠️ 是' : '✅ 否'}`);
      secLines.push(`💀 Owner可改余额: ${s.ownerCanChangeBalance ? '🚨 是' : '✅ 否'}`);
      secLines.push(`🐋 防鲸机制: ${s.antiWhale ? '📌 有' : '无'}`);
      secLines.push(`❄️ 交易冷却: ${s.tradingCooldown ? '📌 有' : '无'}`);

      if (s.ownerAddress && s.ownerAddress !== '0x0000000000000000000000000000000000000000') {
        const ownerUrl = this.getExplorerUrl(analysis.chain, s.ownerAddress);
        secLines.push(`\n👤 Owner: [${s.ownerAddress.slice(0, 6)}...${s.ownerAddress.slice(-4)}](${ownerUrl})`);
      } else if (s.ownerAddress === '0x0000000000000000000000000000000000000000') {
        // Show on-chain verification status
        if (analysis.ownershipStatus?.verifiedOnChain) {
          secLines.push(`\n👤 Owner: ✅ 已放弃 (链上已验证 renounceOwnership)`);
        } else {
          secLines.push(`\n👤 Owner: ⚠️ 零地址 (未确认是否通过 renounce 放弃)`);
        }
      }
      if (s.creatorAddress) {
        const creatorUrl = this.getExplorerUrl(analysis.chain, s.creatorAddress);
        secLines.push(`🏗️ 开发者: [${s.creatorAddress.slice(0, 6)}...${s.creatorAddress.slice(-4)}](${creatorUrl})`);
      }

      // LP Lock status
      if (analysis.lpLock) {
        secLines.push('');
        secLines.push(`🔒 **LP锁定: ${analysis.lpLock.totalLockedPercent}%**`);
        for (const locker of analysis.lpLock.lockers) {
          secLines.push(`  • ${locker.name}: ${locker.percent.toFixed(1)}%`);
        }
      } else if (s.lpHolders && s.lpHolders.length > 0) {
        // Fallback: show GoPlus LP holder data
        const lockedLp = s.lpHolders.filter(h => h.isLocked);
        if (lockedLp.length > 0) {
          const totalLocked = lockedLp.reduce((sum, h) => sum + parseFloat(h.percent || '0'), 0);
          secLines.push(`\n🔒 LP锁定: ${(totalLocked * 100).toFixed(1)}% (GoPlus数据)`);
        }
      }

      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: secLines.join('\n') },
      });
      elements.push({ tag: 'hr' });
    }

    // ═══════════════════════════════════════
    // 💸 税收去向分析
    // ═══════════════════════════════════════
    if (analysis.taxDistribution && analysis.taxDistribution.destinations.length > 0) {
      const td = analysis.taxDistribution;
      const taxLines = ['💸 **税收去向分析**', ''];

      // Summary flags
      const flags: string[] = [];
      if (td.hasBurn) flags.push('🔥 销毁');
      if (td.hasReflection) flags.push('💎 持有者分红');
      if (td.hasAutoLP) flags.push('💧 自动加池');
      if (flags.length > 0) {
        taxLines.push(`📋 税收机制: ${flags.join(' | ')}`);
        taxLines.push('');
      }

      // Destination list
      const typeEmoji: Record<string, string> = {
        marketing: '📢', dev: '👨‍💻', burn: '🔥', liquidity: '💧',
        reflection: '💎', treasury: '🏦', charity: '🎗️', buyback: '🔄',
        team: '👥', unknown: '❓',
      };

      taxLines.push('📍 **税收分配去向:**');
      for (const dest of td.destinations) {
        const emoji = typeEmoji[dest.type] || '❓';
        let line = `  ${emoji} **${dest.label}**`;
        if (dest.percentage) line += ` (${dest.percentage})`;
        if (dest.address) {
          const addrUrl = this.getExplorerUrl(analysis.chain, dest.address);
          line += ` → [${dest.address.slice(0, 6)}...${dest.address.slice(-4)}](${addrUrl})`;
        }
        taxLines.push(line);
        if (dest.notes) {
          taxLines.push(`    ↳ ${dest.notes}`);
        }
      }

      // Tax functions that can modify allocation
      if (td.rawTaxFunctions && td.rawTaxFunctions.length > 0) {
        taxLines.push('');
        taxLines.push(`⚠️ 可修改税收的函数: \`${td.rawTaxFunctions.slice(0, 5).join('`, `')}\``);
      }

      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: taxLines.join('\n') },
      });
      elements.push({ tag: 'hr' });
    }

    // ═══════════════════════════════════════
    // ⚙️ 合约函数详情
    // ═══════════════════════════════════════
    if (analysis.contractSource) {
      const funcLines = ['⚙️ **合约函数分析**', ''];

      if (!analysis.contractSource.isVerified) {
        funcLines.push('❌ 合约未验证（无法获取源码和ABI）');
      } else {
        funcLines.push(`✅ 合约已验证 | 📛 **${analysis.contractSource.contractName || '-'}**`);

        const funcs = analysis.contractSource.contractFunctions || [];
        const allWriteFuncs = funcs.filter(f => f.stateMutability !== 'view' && f.stateMutability !== 'pure');
        const viewFuncs = funcs.filter(f => f.stateMutability === 'view' || f.stateMutability === 'pure');
        const highRiskFuncs = funcs.filter(f => f.riskLevel === 'high');
        const mediumRiskFuncs = funcs.filter(f => f.riskLevel === 'medium');

        if (funcs.length > 0) {
          funcLines.push(`📊 共 **${funcs.length}** 个函数 | 写入: ${allWriteFuncs.length} | 只读: ${viewFuncs.length}`);
          funcLines.push('');

          // 高风险函数
          if (highRiskFuncs.length > 0) {
            funcLines.push('🚨 **高风险函数:**');
            highRiskFuncs.slice(0, 8).forEach(f => {
              const ownerTag = f.isOwnerOnly ? ' 🔒Owner' : '';
              funcLines.push(`  • \`${f.name}(${f.inputs})\`${ownerTag}`);
              funcLines.push(`    → ${f.riskNote}`);
            });
            funcLines.push('');
          }

          // 中风险函数
          if (mediumRiskFuncs.length > 0) {
            funcLines.push('⚠️ **中风险函数:**');
            mediumRiskFuncs.slice(0, 6).forEach(f => {
              const ownerTag = f.isOwnerOnly ? ' 🔒Owner' : '';
              funcLines.push(`  • \`${f.name}(${f.inputs})\`${ownerTag}`);
              funcLines.push(`    → ${f.riskNote}`);
            });
            funcLines.push('');
          }

          // 其他写入函数（非 high/medium 的）
          const otherWriteFuncs = allWriteFuncs.filter(f => f.riskLevel !== 'high' && f.riskLevel !== 'medium');
          if (otherWriteFuncs.length > 0) {
            funcLines.push('📝 **其他写入函数:**');
            otherWriteFuncs.slice(0, 10).forEach(f => {
              const ownerTag = f.isOwnerOnly ? ' 🔒' : '';
              funcLines.push(`  • \`${f.name}(${f.inputs})\`${ownerTag} → ${f.stateMutability || 'nonpayable'}`);
            });
            if (otherWriteFuncs.length > 10) {
              funcLines.push(`  ... 还有 ${otherWriteFuncs.length - 10} 个`);
            }
            funcLines.push('');
          }

          if (highRiskFuncs.length === 0 && mediumRiskFuncs.length === 0) {
            funcLines.push('✅ 未检测到高/中风险函数');
          }
        } else if (analysis.contractSource.dangerousFunctions?.length) {
          // ABI 解析失败但源码检测有结果
          funcLines.push('');
          funcLines.push('⚠️ **源码检测到的风险项:**');
          analysis.contractSource.dangerousFunctions.forEach(f => {
            funcLines.push(`  • ${f}`);
          });
        } else {
          funcLines.push('📄 ABI 无可解析函数');
        }
      }

      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: funcLines.join('\n') },
      });
      elements.push({ tag: 'hr' });
    }

    // ═══════════════════════════════════════
    // 👥 持仓分析
    // ═══════════════════════════════════════
    if (analysis.rawData?.holders) {
      const h = analysis.rawData.holders;
      const holderLines = ['👥 **持仓分析**', ''];
      const holderCountStr = h.totalHolders && h.totalHolders > 0
        ? h.totalHolders.toLocaleString()
        : '数据暂不可用';
      holderLines.push(`👤 总持有者: **${holderCountStr}**`);
      holderLines.push(`🎯 Top10集中度: **${h.top10Concentration}%** | Top20: **${h.top20Concentration}%**`);

      if (h.creatorHolding) {
        holderLines.push(`🏗️ 创建者持仓: **${h.creatorHolding}**`);
      }

      if (h.topHolders?.length) {
        holderLines.push('');
        holderLines.push('🏆 **前5大持仓地址:**');
        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
        h.topHolders.slice(0, 5).forEach((holder: any, i: number) => {
          const label = holder.isContract ? ' 📦合约' : '';
          const holderUrl = this.getExplorerUrl(analysis.chain, holder.address);
          holderLines.push(`${medals[i]} [${holder.address.slice(0, 6)}...${holder.address.slice(-4)}](${holderUrl}) **${holder.percent}**${label}`);
        });
      }

      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: holderLines.join('\n') },
      });
      elements.push({ tag: 'hr' });
    }

    // ═══════════════════════════════════════
    // 🤖 AI 分析
    // ═══════════════════════════════════════
    if (analysis.aiAnalysis) {
      // Feishu lark_md blocks truncate at ~2000 chars; split long AI output into chunks
      const MAX_BLOCK_LEN = 1800;
      const fullText = `🤖 **AI 合约审计**\n\n${analysis.aiAnalysis}`;

      if (fullText.length <= MAX_BLOCK_LEN) {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: fullText },
        });
      } else {
        // Split at paragraph boundaries (double newline)
        const paragraphs = fullText.split(/\n\n/);
        let chunk = '';
        for (const para of paragraphs) {
          if (chunk.length + para.length + 2 > MAX_BLOCK_LEN && chunk.length > 0) {
            elements.push({
              tag: 'div',
              text: { tag: 'lark_md', content: chunk.trim() },
            });
            chunk = '';
          }
          chunk += (chunk ? '\n\n' : '') + para;
        }
        if (chunk.trim()) {
          elements.push({
            tag: 'div',
            text: { tag: 'lark_md', content: chunk.trim() },
          });
        }
      }
    } else {
      // AI analysis not yet available - show loading placeholder
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '🤖 **AI 合约审计**\n\n⏳ AI 深度分析中，请稍候...' },
      });
    }

    const header: any = {
      title: {
        tag: 'plain_text',
        content: `🔬 合约分析 │ ${analysis.tokenSymbol || analysis.address.slice(0, 8)} │ ${analysis.chain.toUpperCase()}`,
      },
      template: riskColor,
    };

    // Add token image to card body if available (small thumbnail via column_set)
    if (tokenImgKey) {
      elements.unshift({
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'default',
        columns: [
          {
            tag: 'column',
            width: '64px',
            vertical_align: 'center',
            elements: [
              {
                tag: 'img',
                img_key: tokenImgKey,
                alt: { tag: 'plain_text', content: analysis.tokenName || 'Token' },
              },
            ],
          },
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            vertical_align: 'center',
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: `**${analysis.tokenName || 'Unknown'}** (\`${analysis.tokenSymbol || '?'}\`)`,
                },
              },
            ],
          },
        ],
      });
    }

    return {
      config: { wide_screen_mode: true },
      header,
      elements,
    };
  }

  private getRiskColor(analysis: ContractAnalysis): string {
    if (analysis.security?.isHoneypot) return 'red';
    if (analysis.security?.ownerCanChangeBalance) return 'red';
    const sellTax = parseFloat(analysis.security?.sellTax || '0');
    const buyTax = parseFloat(analysis.security?.buyTax || '0');
    if (sellTax > 10 || buyTax > 10) return 'red';
    if (sellTax > 5 || buyTax > 5) return 'orange';
    if (analysis.security?.isMintable || analysis.security?.hiddenOwner) return 'orange';
    return 'green';
  }

  private buildTextResult(analysis: ContractAnalysis): string {
    let text = `🔬 合约分析 │ ${analysis.chain.toUpperCase()}\n`;
    text += `━━━━━━━━━━━━━━━━━━━━\n`;
    text += `🪙 ${analysis.tokenName || 'Unknown'} (${analysis.tokenSymbol || '?'})\n`;
    text += `📝 ${analysis.address}\n`;
    text += `━━━━━━━━━━━━━━━━━━━━\n`;
    text += `💲 价格: ${this.formatNumber(analysis.priceUsd)}\n`;
    text += `📊 市值: ${this.formatNumber(analysis.marketCap)}\n`;
    text += `🏦 流动性: ${this.formatNumber(analysis.liquidity)}\n`;

    if (analysis.security) {
      text += `━━━━━━━━━━━━━━━━━━━━\n`;
      text += `🍯 蜜罐: ${analysis.security.isHoneypot ? '❌是' : '✅否'}\n`;
      text += `💸 税率: 买${analysis.security.buyTax}% / 卖${analysis.security.sellTax}%\n`;
    }

    if (analysis.aiAnalysis) {
      text += `━━━━━━━━━━━━━━━━━━━━\n`;
      text += `🤖 ${analysis.aiAnalysis}\n`;
    }

    return text;
  }
}
