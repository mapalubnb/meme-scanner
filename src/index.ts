import * as lark from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import { config, modelManager } from './config';
import { FeishuService } from './services/feishu';
import { ContractAnalyzer } from './services/analyzer';
import { DeepSeekService } from './services/deepseek';
import { extractAddresses, autoDetectEVMChain } from './utils/chainDetector';

const feishu = new FeishuService();
const analyzer = new ContractAnalyzer();
const deepseek = new DeepSeekService();

// Dedup: avoid processing same message twice
const processedMessages = new Set<string>();

/**
 * Handle bot commands
 */
async function handleCommand(content: string, messageId: string, _chatId: string) {
  const trimmed = content.trim();
  const cmd = trimmed.toLowerCase();

  if (cmd.startsWith('/ask ')) {
    const question = trimmed.slice('/ask '.length).trim();
    if (!question) {
      await feishu.replyText(messageId, '用法: /ask <你的问题>');
      return;
    }
    try {
      const reply = await deepseek.chat(question);
      await feishu.replyText(messageId, reply);
    } catch (error: any) {
      await feishu.replyText(messageId, `❌ AI回复失败: ${error?.message || error}`);
    }
    return;
  }

  if (cmd.startsWith('/model ')) {
    const newModel = trimmed.slice('/model '.length).trim();
    if (!newModel) {
      await feishu.replyText(messageId, `当前模型: ${modelManager.getModel()}\n\n用法: /model <模型名称>`);
      return;
    }
    const oldModel = modelManager.getModel();
    modelManager.setModel(newModel);
    await feishu.replyText(messageId, `✅ AI模型已切换\n\n旧模型: ${oldModel}\n新模型: ${newModel}`);
    return;
  }

  switch (cmd) {
    case '/help':
      await feishu.replyText(messageId, [
        '━━ Meme Scanner 使用说明 ━━',
        '',
        '发送合约地址即可自动分析：',
        '• EVM地址 (0x...): 默认为ETH链',
        '• 指定链: bsc:0x1234... / base:0x1234...',
        '• Solana地址: 直接发送base58地址',
        '• Tron地址: T开头地址',
        '',
        '支持的链: ETH / BSC / Base / Arbitrum / Solana / Tron',
        '',
        '命令:',
        '/help - 显示帮助',
        '/status - 服务状态',
        '/models - 查看可用模型列表',
        '/model <name> - 切换AI模型',
        '/ask <问题> - 直接与AI对话',
      ].join('\n'));
      break;

    case '/status':
      try {
        const baseURL = config.ai.baseUrl.endsWith('/v1')
          ? config.ai.baseUrl
          : `${config.ai.baseUrl}/v1`;
        const today = new Date();
        const startDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
        const endDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        const [usageRes] = await Promise.allSettled([
          axios.get(`${baseURL}/dashboard/billing/usage`, {
            headers: { Authorization: `Bearer ${config.ai.apiKey}` },
            params: { start_date: startDate, end_date: endDate },
            timeout: 8000,
          }),
        ]);

        const uptime = Math.floor((Date.now() - modelManager.startedAt.getTime()) / 60000);
        const lines = [
          `✅ 服务运行中（飞书长连接）`,
          `⏰ 时间: ${new Date().toISOString()}`,
          `🤖 当前模型: ${modelManager.getModel()}`,
          `🔗 API: ${config.ai.baseUrl}`,
          `📞 本次启动AI调用: ${modelManager.aiCalls} 次`,
          `⏱️ 运行时长: ${uptime >= 60 ? Math.floor(uptime / 60) + '小时' + (uptime % 60) + '分' : uptime + '分钟'}`,
        ];

        if (usageRes.status === 'fulfilled') {
          const usageCents = usageRes.value.data?.total_usage;
          if (usageCents !== undefined) {
            const usageYuan = Number(usageCents) / 100;
            lines.push(`💰 本月已用: ¥${usageYuan.toFixed(4)}`);
          }
        }

        await feishu.replyText(messageId, lines.join('\n'));
      } catch (error: any) {
        await feishu.replyText(messageId, [
          `✅ 服务运行中（飞书长连接）`,
          `⏰ 时间: ${new Date().toISOString()}`,
          `🤖 当前模型: ${modelManager.getModel()}`,
          `🔗 API: ${config.ai.baseUrl}`,
          `💰 计费查询失败: ${error?.message || 'unknown'}`,
        ].join('\n'));
      }
      break;

    case '/model':
      await feishu.replyText(messageId, `🤖 当前模型: ${modelManager.getModel()}\n\n用法: /model <模型名称>\n示例: /model claude-sonnet-4-20250514`);
      break;

    case '/models':
      try {
        await feishu.replyText(messageId, '⏳ 正在获取模型列表...');
        const models = await deepseek.listModels();
        if (models.length === 0) {
          await feishu.replyText(messageId, '❌ 未获取到模型列表');
        } else {
          const currentModel = modelManager.getModel();
          const lines = [
            `━━ 可用模型列表 (共 ${models.length} 个) ━━`,
            `🤖 当前使用: ${currentModel}`,
            '',
          ];
          const displayModels = models.slice(0, 80);
          for (const m of displayModels) {
            const marker = m === currentModel ? ' ◀️ 当前' : '';
            lines.push(`• ${m}${marker}`);
          }
          if (models.length > 80) {
            lines.push(`\n... 还有 ${models.length - 80} 个模型`);
          }
          lines.push('', '切换模型: /model <模型名称>');
          await feishu.replyText(messageId, lines.join('\n'));
        }
      } catch (error: any) {
        await feishu.replyText(messageId, `❌ 获取模型列表失败: ${error?.message || error}`);
      }
      break;

    default:
      await feishu.replyText(messageId, '未知命令，发送 /help 查看帮助');
  }
}

/**
 * Process incoming message event from WSClient
 */
async function handleMessage(data: any) {
  try {
    const message = data.message || data.event?.message;
    if (!message) return;

    const messageId = message.message_id;
    const chatId = message.chat_id;
    const msgType = message.message_type;

    // Dedup
    if (processedMessages.has(messageId)) return;
    processedMessages.add(messageId);
    if (processedMessages.size > 500) {
      const arr = Array.from(processedMessages);
      arr.slice(0, 200).forEach(id => processedMessages.delete(id));
    }

    if (msgType !== 'text') return;

    let content: string;
    try {
      const raw = message.content;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      content = parsed.text;
    } catch {
      return;
    }

    content = content.replace(/@_user_\d+/g, '').replace(/@_all/g, '').trim();
    console.log(`[Message] Parsed content: "${content}"`);
    if (!content) return;

    const addresses = extractAddresses(content);

    if (addresses.length === 0) {
      const lowerContent = content.toLowerCase();
      const knownCommands = ['help', 'status', 'models', 'model', '/help', '/status', '/models', '/model'];
      const isCommand = knownCommands.includes(lowerContent)
        || lowerContent.startsWith('/model ') || lowerContent.startsWith('model ')
        || lowerContent.startsWith('/ask ') || lowerContent.startsWith('ask ');
      if (isCommand) {
        const cmd = content.startsWith('/') ? content : '/' + content;
        await handleCommand(cmd, messageId, chatId);
      }
      return;
    }

    for (let { chain, address, needsAutoDetect } of addresses) {
      try {
        if (needsAutoDetect) {
          chain = await autoDetectEVMChain(address);
          console.log(`[AutoDetect] ${address} -> ${chain}`);
        }

        console.log(`[Main] Analyzing ${chain}:${address}...`);

        const result = await analyzer.analyzeData(chain, address);
        const replyMsgId = await feishu.replyAnalysis(chatId, messageId, result);

        if (replyMsgId) {
          analyzer.analyzeAI(result).then(async (aiText) => {
            result.aiAnalysis = aiText;
            await feishu.patchAnalysisCard(replyMsgId, result);
          }).catch((err) => {
            console.error(`[Main] AI analysis patch failed for ${address}:`, err);
          });
        }
      } catch (error) {
        console.error(`[Main] Analysis failed for ${address}:`, error);
        await feishu.replyText(messageId, `❌ 分析失败: ${address}\n错误: ${error}`);
      }
    }
  } catch (error) {
    console.error('[WS] handleMessage error:', error);
  }
}

/**
 * Start Feishu WSClient long connection
 */
function startWSClient() {
  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      try {
        await handleMessage(data);
      } catch (e: any) {
        console.error('[WS] Event handler error:', e?.message || e);
      }
    },
  });

  const wsClient = new lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: lark.LoggerLevel.INFO,
  });

  wsClient.start({ eventDispatcher } as any);

  console.log(`[Server] Meme Scanner running via Feishu WebSocket`);
  console.log(`[Server] AI Model: ${modelManager.getModel()} | API: ${config.ai.baseUrl}`);

  feishu.sendStartupNotification().catch(err => {
    console.error('[Server] Startup notification failed:', err?.message || err);
  });
}

// ============================================================
// Entry
// ============================================================

startWSClient();

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[Process] Uncaught exception:', error);
});

process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Server] Interrupted, shutting down...');
  process.exit(0);
});
