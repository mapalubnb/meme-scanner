// ===== Chain Types =====
export type Chain = 'ethereum' | 'bsc' | 'base' | 'arbitrum' | 'solana' | 'tron';

export interface ChainConfig {
  name: string;
  geckoNetwork: string;       // GeckoTerminal network ID
  goplusChainId: string;      // GoPlus chain ID
  addressPattern: RegExp;
}

// ===== Token Social Links =====
export interface TokenSocials {
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  github?: string;
  description?: string;
}

// ===== Contract Analysis Result =====
export interface ContractAnalysis {
  chain: Chain;
  address: string;
  tokenName?: string;
  tokenSymbol?: string;

  // Token image
  tokenImageUrl?: string;

  // Token social links
  socials?: TokenSocials;

  // Market Data
  priceUsd?: string;
  marketCap?: string;
  liquidity?: string;
  volume24h?: string;
  poolCreatedAt?: string;

  // Security (GoPlus)
  security?: SecurityInfo;

  // Launchpad Detection
  launchpad?: LaunchpadInfo;

  // Token deployment time
  deployedAt?: string;

  // Ownership status (verified on-chain)
  ownershipStatus?: OwnershipStatus;

  // LP lock info
  lpLock?: LPLockInfo;

  // Tax Distribution Analysis
  taxDistribution?: TaxDistribution;

  // Contract Source (EVM)
  contractSource?: ContractSourceInfo;

  // AI Analysis
  aiAnalysis?: string;

  // Raw data for debugging
  rawData?: Record<string, any>;
}

// ===== Security Info from GoPlus =====
export interface SecurityInfo {
  isHoneypot: boolean;
  buyTax: string;
  sellTax: string;
  isOpenSource: boolean;
  isProxy: boolean;
  canTakeBackOwnership: boolean;
  ownerCanChangeBalance: boolean;
  hiddenOwner: boolean;
  cannotSellAll: boolean;
  selfdestruct: boolean;
  externalCall: boolean;
  isMintable: boolean;
  transferPausable: boolean;
  tradingCooldown: boolean;
  isBlacklisted: boolean;
  isWhitelisted: boolean;
  antiWhale: boolean;
  lpHolders?: LpHolder[];
  holderCount?: number;
  topHolders?: TokenHolder[];
  ownerAddress?: string;
  creatorAddress?: string;
}

export interface LpHolder {
  address: string;
  percent: string;
  isLocked: boolean;
  isContract: boolean;
}

export interface TokenHolder {
  address: string;
  percent: string;
  isContract: boolean;
  isLocked: boolean;
}

// ===== Tax Distribution Analysis =====
export interface TaxDistribution {
  totalBuyTax: string;
  totalSellTax: string;
  destinations: TaxDestination[];
  hasBurn: boolean;
  hasReflection: boolean;       // Holder reflections/dividends
  hasAutoLP: boolean;           // Auto add to liquidity pool
  rawTaxFunctions?: string[];   // Tax-related function names found in source
}

export interface TaxDestination {
  type: 'marketing' | 'dev' | 'burn' | 'liquidity' | 'reflection' | 'treasury' | 'charity' | 'buyback' | 'team' | 'unknown';
  label: string;                // Human-readable label (e.g., "营销钱包", "开发者钱包")
  address?: string;             // Wallet address if detected
  percentage?: string;          // Share of tax (e.g., "3%")
  notes?: string;               // Additional info
}

// ===== Launchpad Detection =====
export interface LaunchpadInfo {
  isFromLaunchpad: boolean;
  launchpadName?: string;
  launchpadType?: 'fairlaunch' | 'presale' | 'bonding_curve' | 'unknown';
  confidence: number; // 0-100
}

// ===== Contract Function Info =====
export interface ContractFunctionInfo {
  name: string;
  type: 'function' | 'event' | 'constructor';
  stateMutability?: string;
  inputs: string;
  outputs?: string;
  isOwnerOnly?: boolean;
  riskLevel?: 'high' | 'medium' | 'low' | 'info';
  riskNote?: string;
}

// ===== Contract Source =====
export interface ContractSourceInfo {
  isVerified: boolean;
  sourceCode?: string;
  compilerVersion?: string;
  contractName?: string;
  abi?: string;
  // Key functions detected
  dangerousFunctions?: string[];
  // Parsed contract functions with risk assessment
  contractFunctions?: ContractFunctionInfo[];
}

// ===== LP Lock Info =====
export interface LPLockInfo {
  isLocked: boolean;
  totalLockedPercent: number;
  lockers: Array<{ name: string; address: string; percent: number }>;
}

// ===== Ownership Renounce Verification =====
export interface OwnershipStatus {
  renounced: boolean;
  verifiedOnChain: boolean;  // true = confirmed via event log, false = only checked owner address
  txHash?: string;
  timestamp?: string;
}

// ===== Solana specific (RugCheck) =====
export interface SolanaSecurityInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  lpBurned: boolean;
  lpBurnPercent?: number;
  topHolderConcentration: number;
  isRugPull: boolean;
  riskLevel: 'Good' | 'Warning' | 'Danger';
  risks: string[];
}

// ===== Feishu Message =====
export interface FeishuEvent {
  event: {
    message: {
      message_id: string;
      chat_id: string;
      content: string;
      message_type: string;
    };
    sender: {
      sender_id: { open_id: string };
    };
  };
}
