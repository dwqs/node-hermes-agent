import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'

export const model = new ChatOpenAI({
  modelName: process.env.AI_MODEL_NAME,
  apiKey: process.env.OPEN_AI_API_KEY,
  temperature: 0,
  timeout: 60000,
  maxRetries: 2,
  configuration: {
      baseURL: process.env.MODEL_BASE_URL,
  },
})
export const MAX_ITERATIONS = process.env.MAX_ITERATIONS || 30


export const COMPRESSION_THRESHOLD = 50       // 估算 token 超过这个阈值就触发压缩
export const PROTECT_FIRST = 3                   // 头部保护区消息数（user 首问 + 早期工具成果往往最关键）
export const KEEP_RECENT_TOOL_RESULTS = 3        // 仅保留最近 N 条 tool 输出原文，更早的清空占位
export const TAIL_TOKEN_BUDGET = 20           // 尾部预算：从后往前累加，直到撞线，留给模型"最近记忆"
