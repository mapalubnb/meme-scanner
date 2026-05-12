import axios from 'axios';
import { SolanaSecurityInfo } from '../types';

const BASE_URL = 'https://api.rugcheck.xyz/v1';
const client = axios.create({ baseURL: BASE_URL, timeout: 15000 });

export class RugCheckService {
  /**
   * Get full token risk report (Solana only)
   */
  async getTokenReport(mintAddress: string): Promise<SolanaSecurityInfo | null> {
    try {
      const res = await client.get(`/tokens/${mintAddress}/report`);
      const data = res.data;

      if (!data) return null;

      const risks: string[] = [];
      if (data.risks) {
        data.risks.forEach((r: any) => risks.push(`${r.name}: ${r.description}`));
      }

      // Calculate top holder concentration
      let topHolderConcentration = 0;
      if (data.topHolders) {
        topHolderConcentration = data.topHolders
          .slice(0, 10)
          .reduce((sum: number, h: any) => sum + (h.pct || 0), 0);
      }

      return {
        mintAuthority: data.mintAuthority || null,
        freezeAuthority: data.freezeAuthority || null,
        lpBurned: data.markets?.[0]?.lp?.lpBurned || false,
        lpBurnPercent: data.markets?.[0]?.lp?.burnPct,
        topHolderConcentration,
        isRugPull: data.score < 300, // RugCheck score below 300 = danger
        riskLevel: data.score >= 700 ? 'Good' : data.score >= 400 ? 'Warning' : 'Danger',
        risks,
      };
    } catch (error) {
      console.error('[RugCheck] Error:', error);
      return null;
    }
  }

}
