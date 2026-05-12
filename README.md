# Meme Scanner

多链 Meme 币合约分析飞书机器人。发送合约地址即可自动分析安全风险、市场数据、持仓分布，并提供 AI 审计报告。

## 功能

- 多链支持: ETH / BSC / Base / Arbitrum / Solana / Tron
- GoPlus 安全扫描 (蜜罐、税率、权限检测)
- 合约函数风险分析
- DexScreener / GeckoTerminal 市场数据
- 持仓集中度分析 (Moralis)
- AI 合约审计 (兼容任意 OpenAI 协议 API)
- 飞书长连接 (WebSocket)，无需公网 IP 和端口

## 安装

### 1. 环境要求

- Node.js >= 18
- PM2 (推荐)

### 2. 部署

```bash
# 克隆项目
git clone https://github.com/mapalubnb/meme-scanner.git
cd meme-scanner

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入实际配置
vim .env

# 编译 TypeScript
npm run build

# 启动
npm start
# 或使用 PM2
mkdir -p logs
pm2 start memescanner.config.js
pm2 save
```

### 3. 飞书应用配置

1. 进入 [飞书开放平台](https://open.feishu.cn/) → 创建/选择应用
2. 「事件订阅」→ 选择 **使用长连接接收事件**
3. 添加事件: `im.message.receive_v1` (接收消息)
4. 「权限管理」→ 开通:
   - `im:message` (读取消息)
   - `im:message:send_as_bot` (以机器人身份发消息)
   - `im:resource` (上传图片，用于代币头像)
5. 「机器人」→ 启用机器人能力
6. 发布应用版本，等待审批通过
7. 将机器人添加到群聊

### 4. AI 配置 (多提供商)

支持同时配置多个 AI 提供商，运行时通过飞书命令 `/provider` 切换：

```env
# .env 示例
AI_PROVIDERS=deepseek,openai,siliconflow

AI_DEEPSEEK_URL=https://api.deepseek.com
AI_DEEPSEEK_KEY=sk-xxx
AI_DEEPSEEK_MODEL=deepseek-chat

AI_OPENAI_URL=https://api.openai.com
AI_OPENAI_KEY=sk-xxx
AI_OPENAI_MODEL=gpt-4o

AI_SILICONFLOW_URL=https://api.siliconflow.cn
AI_SILICONFLOW_KEY=sk-xxx
AI_SILICONFLOW_MODEL=deepseek-ai/DeepSeek-V3
```

兼容的 OpenAI 协议 API 提供商:

| 提供商 | URL | 模型示例 |
|--------|-----|---------|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI | `https://api.openai.com` | `gpt-4o` |
| SiliconFlow | `https://api.siliconflow.cn` | `deepseek-ai/DeepSeek-V3` |
| Groq | `https://api.groq.com/openai` | `llama-3.3-70b-versatile` |
| Ollama | `http://localhost:11434` | `llama3` |

> 向后兼容：如果不设置 `AI_PROVIDERS`，仍可使用旧的 `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` 单一配置。

## 使用

在飞书群中 @机器人 或私聊发送:

- **合约地址**: 自动检测链并分析 (0x... 默认 ETH)
- **指定链**: `bsc:0x1234...` / `base:0x1234...`
- **Solana**: 直接发送 base58 地址
- **Tron**: T 开头地址
- `/help` - 帮助
- `/status` - 服务状态
- `/providers` - 查看已配置的 AI 提供商
- `/provider <name>` - 切换 AI 提供商
- `/models` - 查看当前提供商可用模型
- `/model <name>` - 切换 AI 模型
- `/ask <问题>` - 与 AI 对话

## 管理

```bash
pm2 logs meme-scanner      # 查看日志
pm2 restart meme-scanner   # 重启
pm2 stop meme-scanner      # 停止
```
