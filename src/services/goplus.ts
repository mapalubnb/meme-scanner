import axios from 'axios';
import { Chain, SecurityInfo } from '../types';
import { chainConfigs } from '../config';

const BASE_URL = 'https://api.gopluslabs.io/api/v1';
const client = axios.create({ baseURL: BASE_URL, timeout: 15000 });

export class GoPlusService {
  /**
   * Get comprehensive token security info (EVM chains)
   */
  async getTokenSecurity(chain: Chain, address: string): Promise<SecurityInfo | null> {
    if (chain === 'solana') {
      return this.getSolanaTokenSecurity(address);
    }

    const chainId = chainConfigs[chain].goplusChainId;
    // Tron addresses are base58 (case-sensitive), EVM addresses use lowercase
    const queryAddress = chain === 'tron' ? address : address.toLowerCase();
    try {
      const res = await client.get(`/token_security/${chainId}`, {
        params: { contract_addresses: queryAddress },
      });

      const data = res.data?.result?.[queryAddress];
      if (!data) return null;

      // GoPlus returns tax as decimal string (e.g., "0.05" = 5%)
      // Special values: -1 means detection failed, null/empty means 0
      const rawBuyTax = parseFloat(data.buy_tax || '0');
      const rawSellTax = parseFloat(data.sell_tax || '0');
      const buyTaxPct = rawBuyTax < 0 ? '?' : rawBuyTax > 1 ? rawBuyTax.toString() : (rawBuyTax * 100).toFixed(1);
      const sellTaxPct = rawSellTax < 0 ? '?' : rawSellTax > 1 ? rawSellTax.toString() : (rawSellTax * 100).toFixed(1);

      return {
        isHoneypot: data.is_honeypot === '1',
        buyTax: buyTaxPct,
        sellTax: sellTaxPct,
        isOpenSource: data.is_open_source === '1',
        isProxy: data.is_proxy === '1',
        canTakeBackOwnership: data.can_take_back_ownership === '1',
        ownerCanChangeBalance: data.owner_change_balance === '1',
        hiddenOwner: data.hidden_owner === '1',
        cannotSellAll: data.cannot_sell_all === '1',
        selfdestruct: data.selfdestruct === '1',
        externalCall: data.external_call === '1',
        isMintable: data.is_mintable === '1',
        transferPausable: data.transfer_pausable === '1',
        tradingCooldown: data.trading_cooldown === '1',
        isBlacklisted: data.is_blacklisted === '1',
        isWhitelisted: data.is_whitelisted === '1',
        antiWhale: data.is_anti_whale === '1',
        ownerAddress: data.owner_address,
        creatorAddress: data.creator_address,
        holderCount: parseInt(data.holder_count || '0'),
        lpHolders: data.lp_holders?.map((h: any) => ({
          address: h.address,
          percent: h.percent,
          isLocked: h.is_locked === 1,
          isContract: h.is_contract === 1,
        })),
        topHolders: data.holders?.map((h: any) => ({
          address: h.address,
          percent: h.percent,
          isContract: h.is_contract === 1,
          isLocked: h.is_locked === 1,
        })),
      };
    } catch (error) {
      console.error('[GoPlus] Token security error:', error);
      return null;
    }
  }

  /**
   * Solana token security via GoPlus
   */
  private async getSolanaTokenSecurity(address: string): Promise<SecurityInfo | null> {
    try {
      const res = await client.get('/solana/token_security', {
        params: { contract_addresses: address },
      });
      const data = res.data?.result?.[address];
      if (!data) return null;

      return {
        isHoneypot: false, // Solana doesn't have honeypot in same sense
        buyTax: '0',
        sellTax: '0',
        isOpenSource: true, // Solana programs are always visible
        isProxy: data.is_proxy === '1',
        canTakeBackOwnership: false,
        ownerCanChangeBalance: data.mint_authority_not_renounced === '1',
        hiddenOwner: false,
        cannotSellAll: false,
        selfdestruct: false,
        externalCall: false,
        isMintable: data.mint_authority_not_renounced === '1',
        transferPausable: data.freeze_authority_not_renounced === '1',
        tradingCooldown: false,
        isBlacklisted: false,
        isWhitelisted: false,
        antiWhale: false,
        creatorAddress: data.creator_address,
      };
    } catch (error) {
      console.error('[GoPlus] Solana security error:', error);
      return null;
    }
  }

}
