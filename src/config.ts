import dotenv from 'dotenv';
import { Chain, ChainConfig } from './types';

dotenv.config();

export const config = {
  feishu: {
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    chatId: process.env.FEISHU_CHAT_ID || process.env.FEISHU_NOTIFY_CHAT_ID || '',
  },
  ai: {
    apiKey: process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    model: process.env.AI_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    baseUrl: process.env.AI_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || '',
  },
  moralis: {
    apiKey: process.env.MORALIS_API_KEY || '',
  },
};

// Chain configurations
// Note: explorerApiUrl/explorerApiKey removed - now using Etherscan V2 unified endpoint
export const chainConfigs: Record<Chain, ChainConfig> = {
  ethereum: {
    name: 'Ethereum',
    geckoNetwork: 'eth',
    goplusChainId: '1',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  bsc: {
    name: 'BSC',
    geckoNetwork: 'bsc',
    goplusChainId: '56',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  base: {
    name: 'Base',
    geckoNetwork: 'base',
    goplusChainId: '8453',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  arbitrum: {
    name: 'Arbitrum',
    geckoNetwork: 'arbitrum',
    goplusChainId: '42161',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  solana: {
    name: 'Solana',
    geckoNetwork: 'solana',
    goplusChainId: 'solana',
    addressPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  },
  tron: {
    name: 'Tron',
    geckoNetwork: 'tron',
    goplusChainId: 'tron',
    addressPattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  },
};

// Additional launchpad factory addresses (supplementary to the main list in launchpad.ts)
// Add newly discovered addresses here for quick updates without modifying service code
export const launchpadFactories: Record<string, { name: string; chains: Chain[] }> = {
  // Reserved for runtime-discovered or user-added factories
};

// ===== Runtime Model Manager =====
// Allows switching AI model at runtime via chat commands
class ModelManager {
  private currentModel: string;
  private _aiCalls: number = 0;
  private _startedAt: Date = new Date();

  constructor() {
    this.currentModel = config.ai.model;
  }

  getModel(): string {
    return this.currentModel;
  }

  setModel(model: string): void {
    this.currentModel = model;
    console.log(`[ModelManager] Model switched to: ${model}`);
  }

  /** Increment AI call counter */
  trackCall(): void {
    this._aiCalls++;
  }

  get aiCalls(): number {
    return this._aiCalls;
  }

  get startedAt(): Date {
    return this._startedAt;
  }
}

export const modelManager = new ModelManager();
