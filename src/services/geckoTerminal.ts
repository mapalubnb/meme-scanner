import axios from 'axios';
import { Chain } from '../types';
import { chainConfigs } from '../config';

const BASE_URL = 'https://api.geckoterminal.com/api/v2';
const client = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
  headers: { Accept: 'application/json;version=20230302' },
});

// Rate limiter: max 30 req/min (1 request per 2.5 seconds, with safety buffer)
let lastRequestTime = 0;
let requestQueue: Promise<any> = Promise.resolve();

async function rateLimitedRequest(url: string, params?: Record<string, any>) {
  // Chain requests sequentially — HTTP request is INSIDE the queue to prevent race conditions
  const result = requestQueue.then(async () => {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < 2500) {
      await new Promise(resolve => setTimeout(resolve, 2500 - elapsed));
    }
    lastRequestTime = Date.now();
    return client.get(url, { params });
  });
  // Keep the queue chain alive regardless of success/failure
  requestQueue = result.then(() => {}, () => {});
  return result;
}

export class GeckoTerminalService {
  /**
   * Get token info by contract address
   */
  async getTokenInfo(chain: Chain, address: string) {
    const network = chainConfigs[chain].geckoNetwork;
    const res = await rateLimitedRequest(`/networks/${network}/tokens/${address}`);
    return res.data?.data;
  }

  /**
   * Get token metadata (name, symbol, description, socials)
   */
  async getTokenMetadata(chain: Chain, address: string) {
    const network = chainConfigs[chain].geckoNetwork;
    const res = await rateLimitedRequest(`/networks/${network}/tokens/${address}/info`);
    return res.data?.data;
  }

  /**
   * Get top pools for a token
   */
  async getTokenPools(chain: Chain, address: string) {
    const network = chainConfigs[chain].geckoNetwork;
    const res = await rateLimitedRequest(`/networks/${network}/tokens/${address}/pools`);
    return res.data?.data;
  }

}
