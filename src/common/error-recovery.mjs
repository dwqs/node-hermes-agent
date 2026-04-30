import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'

import { FALLBACK_MODEL, MAX_RETRIES } from './model.mjs'
import { toolRegistry } from './tools.mjs'

// 对大模型的错误进行分类
export function classifyError(code, err) {
  const message = (err.message || '').toLowerCase()
  if(code === 429) {
    // 限流
    return {
      reason: 'rate_limit',
      retryable: true,
      shouldCompress: false,
      shouldFallback: false,
    }
  } else if(code === 400 && message.includes('context')) {
    // 上下文超限，压缩后重试
    return {
      reason: 'context_overflow',
      retryable: true,
      shouldCompress: true,
      shouldFallback: false,
    }
  } else if(code >= 500) {
    // 服务器错误
    return {
      reason: 'server_error',
      retryable: true,
      shouldCompress: false,
      shouldFallback: false,
    }
  } else if(code === 401 || code === 403) {
    // 认证错误，切换备选模型
    return {
      reason: 'auth',
      retryable: false,
      shouldCompress: false,
      shouldFallback: true,
    }
  } else if(code === 404) {
    // 模型不存在
    return {
      reason: 'model_not_found',
      retryable: false,
      shouldCompress: false,
      shouldFallback: true,
    }
  }
  
  return  {
    reason: 'unknown',
    retryable: false,
    shouldCompress: false,
    shouldFallback: false,
  }
}


// 计算带随机抖动的指数退避延迟
export function exponentialBackoff(retryCount, baseDelay = 5, maxDelay = 120) {
  // 指数退避避免雪崩；加随机抖动避免多客户端同时重试造成的"峰谷共振"
  const delay = Math.min(baseDelay * (2 ** (retryCount - 1)), maxDelay)
  return Math.random() * (delay * 0.5) + delay
}

export function switchFallbackModel() {
  const model = new ChatOpenAI({
    modelName: FALLBACK_MODEL,
    apiKey: process.env.OPEN_AI_API_KEY,
    temperature: 0,
    timeout: 60000,
    maxRetries: MAX_RETRIES,
    configuration: {
        baseURL: process.env.MODEL_BASE_URL,
    },
  })
  return model.bindTools(toolRegistry.getDefinitions())
}