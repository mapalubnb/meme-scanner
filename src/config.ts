import dotenv from 'dotenv';
import { Chain, ChainConfig } from './types';

dotenv.config();

// ===== AI Provider Types =====
export interface AIProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

export const config = {
  feishu: {
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    chatId: process.env.FEISHU_CHAT_ID || process.env.FEISHU_NOTIFY_CHAT_ID || '',
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || '',
  },
  moralis: {
    apiKey: process.env.MORALIS_API_KEY || '',
  },
};

// ===== Load AI Providers from env =====
function loadAIProviders(): AIProvider[] {
  const providers: AIProvider[] = [];
  const providerList = process.env.AI_PROVIDERS;

  if (providerList) {
    // Multi-provider mode: AI_PROVIDERS=deepseek,openai,siliconflow
    const names = providerList.split(',').map(s => s.trim()).filter(Boolean);
    for (const name of names) {
      const upper = name.toUpperCase();
      const baseUrl = process.env[`AI_${upper}_URL`];
      const apiKey = process.env[`AI_${upper}_KEY`];
      const model = process.env[`AI_${upper}_MODEL`] || '';
      if (baseUrl && apiKey) {
        providers.push({ name, baseUrl, apiKey, defaultModel: model });
      } else {
        console.warn(`[Config] Provider "${name}" skipped: missing AI_${upper}_URL or AI_${upper}_KEY`);
      }
    }
  }

  // Fallback: legacy single-provider config
  if (providers.length === 0) {
    const apiKey = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || '';
    const baseUrl = process.env.AI_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    const model = process.env.AI_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    if (apiKey) {
      providers.push({ name: 'default', baseUrl, apiKey, defaultModel: model });
    }
  }

  return providers;
}

const aiProviders = loadAIProviders();

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

// ===== Runtime AI Provider Manager =====
// Allows switching AI providers and models at runtime via chat commands
class AIProviderManager {
  private providers: AIProvider[];
  private currentProviderIndex: number = 0;
  private currentModel: string;
  private _aiCalls: number = 0;
  private _startedAt: Date = new Date();

  constructor(providers: AIProvider[]) {
    this.providers = providers;
    this.currentModel = providers.length > 0 ? providers[0].defaultModel : 'deepseek-chat';
  }

  // --- Provider management ---

  getProviders(): AIProvider[] {
    return this.providers;
  }

  getProviderNames(): string[] {
    return this.providers.map(p => p.name);
  }

  getCurrentProvider(): AIProvider {
    return this.providers[this.currentProviderIndex];
  }

  getCurrentProviderName(): string {
    return this.getCurrentProvider()?.name || 'none';
  }

  /**
   * Switch to a different provider by name.
   * Returns true if switch succeeded, false if provider not found.
   */
  setProvider(name: string): boolean {
    const idx = this.providers.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    if (idx === -1) return false;
    this.currentProviderIndex = idx;
    // Auto-switch to the provider's default model
    this.currentModel = this.providers[idx].defaultModel;
    console.log(`[AIManager] Provider switched to: ${name}, model: ${this.currentModel}`);
    return true;
  }

  /**
   * Add a new provider at runtime.
   * Returns false if a provider with the same name already exists.
   */
  addProvider(provider: AIProvider): boolean {
    const exists = this.providers.some(p => p.name.toLowerCase() === provider.name.toLowerCase());
    if (exists) return false;
    this.providers.push(provider);
    console.log(`[AIManager] Provider added: ${provider.name} (${provider.baseUrl})`);
    return true;
  }

  /**
   * Remove a provider by name.
   * Cannot remove the currently active provider.
   * Returns true if removed, false if not found or is active.
   */
  removeProvider(name: string): { success: boolean; reason?: string } {
    const idx = this.providers.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    if (idx === -1) return { success: false, reason: '未找到该提供商' };
    if (idx === this.currentProviderIndex) return { success: false, reason: '不能删除当前正在使用的提供商' };
    this.providers.splice(idx, 1);
    // Adjust currentProviderIndex if needed
    if (this.currentProviderIndex > idx) {
      this.currentProviderIndex--;
    }
    console.log(`[AIManager] Provider removed: ${name}`);
    return { success: true };
  }

  // --- Model management ---

  getModel(): string {
    return this.currentModel;
  }

  setModel(model: string): void {
    this.currentModel = model;
    console.log(`[AIManager] Model switched to: ${model}`);
  }

  // --- Current AI config (used by DeepSeekService) ---

  getBaseUrl(): string {
    return this.getCurrentProvider()?.baseUrl || 'https://api.deepseek.com';
  }

  getApiKey(): string {
    return this.getCurrentProvider()?.apiKey || '';
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

export const modelManager = new AIProviderManager(aiProviders);

// Legacy compat: expose a config.ai-like getter for code that still references it
export const aiConfig = {
  get apiKey() { return modelManager.getApiKey(); },
  get baseUrl() { return modelManager.getBaseUrl(); },
  get model() { return modelManager.getModel(); },
};
