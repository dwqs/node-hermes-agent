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

/**
 * 权限相关
 */
export const PERMISSION_ALLOWLIST = process.env.HERMES_HOME + '/allowlist.json'
// 危险命令
export const DANGEROUS_PATTERNS = [
  {
    pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--no-preserve-root)/,
    description: 'Recursive/force file deletion'
  },
  {
    pattern: /rm\s+-[a-zA-Z]*r/,
    description: 'Recursive file deletion'
  },
  {
    pattern: /mkfs\./,
    description: 'Filesystem format'
  },
  {
    pattern: /dd\s+if=/,
    description: 'Raw disk write'
  },
  {
    pattern: />\s*\/dev\/sd[a-z]/,
    description: 'Direct device write'
  },
  {
    pattern: /chmod\s+(-R\s+)?777/,
    description: 'World-writable permissions'
  },
  {
    pattern: /chown\s+-R\s+/,
    description: 'Recursive ownership change'
  },
  {
    pattern: /shutdown|reboot|poweroff|init\s+[06]/,
    description: 'System shutdown/reboot'
  },
  {
    pattern: /kill\s+-9\s+(-1|1\b)/,
    description: 'Kill all processes'
  },
  {
    pattern: /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;/,
    description: 'Fork bomb'
  },
  {
    pattern: /DROP\s+(TABLE|DATABASE|INDEX)/i,
    description: 'SQL destructive operation'
  },
  {
    pattern: /TRUNCATE\s+TABLE/i,
    description: 'SQL truncate'
  },
  {
    pattern: /DELETE\s+FROM\s+\w+\s*;?\s*$/i,
    description: 'SQL delete without WHERE'
  },
  {
    pattern: /curl\s+.*\|\s*(bash|sh|zsh)/,
    description: 'Pipe remote script to shell'
  },
  {
    pattern: /wget\s+.*\|\s*(bash|sh|zsh)/,
    description: 'Pipe remote script to shell'
  },
  // 用于测试
  {
    pattern: /exit|quit|logout/,
    description: 'Exit session'
  },
  {
    pattern: /ls/,
    description: 'List files and directories'
  }
]
// 预编译
export const compiledPatterns = DANGEROUS_PATTERNS.map(({ pattern, description }) => ({
  pattern: new RegExp(pattern.source, pattern.flags.includes('i') ? pattern.flags : pattern.flags + 'i'),
  description
}))
// 本次会话的审批缓存
export const sessionApproved = new Set()

// Sub Agent
export const SUB_AGENT_MAX_ITERATIONS = 15
export const SUB_AGENT_BLOCKED_TOOLS = ['memory', 'skill_manage', 'delegate_task']