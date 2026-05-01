import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'

// 错误恢复相关配置
export const MAX_RETRIES = 3    // 单轮 API 调用的最大重试次数
// 继续执行的提示词
export const CONTINUE_MESSAGE = '从你中断的地方继续执行' 
// 连续被 length 截断时，最多再让模型续写几次   
export const MAX_CONTINUATIONS = 3
export const FALLBACK_MODEL = 'qwen3.6-flash' // 备选模型，在主模型不可用时使用    


export const model = new ChatOpenAI({
  modelName: process.env.AI_MODEL_NAME,
  apiKey: process.env.OPEN_AI_API_KEY,
  temperature: 0,
  timeout: 60000,
  maxRetries: MAX_RETRIES,
  configuration: {
      baseURL: process.env.MODEL_BASE_URL,
  },
})
export const MAX_ITERATIONS = process.env.MAX_ITERATIONS || 30

// 上下文压缩相关配置
export const COMPRESSION_THRESHOLD = 50000       // 估算 token 超过这个阈值就触发压缩
export const PROTECT_FIRST = 3                   // 头部保护区消息数（user 首问 + 早期工具成果往往最关键）
export const KEEP_RECENT_TOOL_RESULTS = 3        // 仅保留最近 N 条 tool 输出原文，更早的清空占位
export const TAIL_TOKEN_BUDGET = 20000           // 尾部预算：从后往前累加，直到撞线，留给模型"最近记忆"   

// Memory 相关
export const MEMORY_DIR = process.env.HERMES_HOME + '/memories'
export const MEMORY_FILE = MEMORY_DIR + '/MEMORY.md'           // 通用知识
export const USER_FILE = MEMORY_DIR + '/USER.md'               // 用户画像
export const ENTRY_SEP = "\n\n\u00a7\n\n"                      // 用罕见的 § 做分隔符，避免与正文冲突
export const MEMORY_CHAR_LIMIT = 2200                          // 字符上限，超出按 FIFO 丢弃末尾
export const USER_CHAR_LIMIT = 1375

// Skill 相关
export const SKILL_DIR = process.env.HERMES_HOME + '/skills'
