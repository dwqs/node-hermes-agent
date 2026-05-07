import { ChatOpenAI } from '@langchain/openai'
import chalk from 'chalk'
import { HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'

import { loadYamlConfig } from './configuration-system.mjs'
import { getSessionMessages, addMessage } from './persistent.mjs'
import { toolRegistry } from './tools.mjs'
import { compress, estimateTokens } from './context-compression.mjs'
import { classifyError, exponentialBackoff, switchFallbackModel } from './error-recovery.mjs'

import { registerMcpServer, SimulatedMCPServer } from './mcp-simulated.mjs'
// import { initMcpServers } from './mcp-real.mjs'
import { collectStream } from './collect-stream.mjs'
import { maybeTriggerReview } from './background-review.mjs'

const streaming = process.argv.includes('--streaming')
const config = loadYamlConfig()
const model = new ChatOpenAI({
  modelName: config.model,
  apiKey: config.apiKey,
  temperature: 0,
  timeout: 60000,
  maxRetries: config.limits.maxRetries,
  streaming: streaming,
  configuration: {
      baseURL: config.baseUrl,
  },
})

const server = new SimulatedMCPServer('test-server', {
  greet: ({ input }) => `Hello, ${input}!`,
  double: ({ input }) => String(Number(input) * 2),
})
registerMcpServer(server, { tools: { include: ['double'], exclude: ['greet'] } })

// 初始化真实 MCP 服务器
// await initMcpServers(config)

let activeClient = model.bindTools(toolRegistry.getDefinitions())
let activeModelName = config.model || config.fallback.model

async function runConversation(
  input,
  db,
  sessionId,
  systemPrompt,
  streamCallback = null,
  toolProgressCallback = null, 
  // s20 新增参数
  maxIterationsOverride = null,
  reviewState = null,
  reviewCallback = null,
) {
  let messages = getSessionMessages(db, sessionId)
  const humanMsg = new HumanMessage(input)
  messages.push(humanMsg)
  addMessage(db, sessionId, { role: humanMsg.type, content: humanMsg.content })

  // s20
  if(reviewState) {
    reviewState.onUserMessage()
  }

  let retryCount = 0
  let continuationCount = 0

  function fireStreamDelta(text) {
    if (streamCallback) {
      try {
        streamCallback(text)
      } catch (err) {
        // ignore
      }
    }
  }

  const maxIterations = maxIterationsOverride || config.limits.maxIterations
  for (let i = 0; i < maxIterations; i++) {
    // 达到阈值，先压缩
    if(estimateTokens(messages) > config.compression.threshold) {
      messages = await compress(messages)
    }

    const roundLabel = `第 ${i + 1} 轮`
    console.log(chalk.yellow(`⏳ ${roundLabel} - 正在等待 AI 思考...`))

    let response = null
    try {
      if(streaming) {
        // s19
        response = await activeClient.stream([new SystemMessage(systemPrompt), ...messages])
      } else {
        response = await activeClient.invoke([new SystemMessage(systemPrompt), ...messages])
      }

      if(streaming) {
        response = await collectStream(response, fireStreamDelta)
      }
      messages.push(response)
    } catch (error) {
      const classified = classifyError(error.status, error)
      console.log(chalk.red(`🔍 错误分类: ${classified.reason}, status: ${error.status}`))

      // 优先级：压缩 > 切换模型 > 退避重试；一轮异常至多执行其中一个动作，然后 continue 重试
      if(classified.shouldCompress) {
        messages = await compress(messages)
        continue
      } else if(classified.shouldFallback) {
        console.log(chalk.yellow(`🔍 切换备选模型: ${config.fallback.model}`))
        activeClient = switchFallbackModel()
        activeModelName = config.fallback.model
        continue
      } else if(classified.retryable && retryCount < config.limits.maxRetries ) {
        retryCount++
        const delay = exponentialBackoff(retryCount)
        await new Promise(resolve => setTimeout(resolve, delay * 1000))
        continue
      } else {
        throw error
      }
    }

    if(!response) {
      continue
    }

    // 成功一次就清零重试计数，下一次异常重新从 0 开始累计
    retryCount = 0

    let toolCalls = null
    if (response.tool_calls && response.tool_calls.length > 0) {
      toolCalls = response.tool_calls.map(item => ({
        id: item.id,
        name: item.name,
        args: item.args
      }))
    }
    addMessage(db, sessionId, { tool_calls: toolCalls, role: response.type, content: response.content })

    // finish_reason 一般有 stop / length / stop_call 等, 当 finish_reason 为 length 时，说明模型因 max_tokens 被截断，需要注入 "请继续" 让它接着写
    const finishReason = response.response_metadata.finish_reason
    if(finishReason === 'length' && continuationCount < config.limits.maxContinuations) {
      continuationCount++
      const conMsg = new HumanMessage(config.continueMessage)
      messages.push(conMsg)
      addMessage(db, sessionId, { role: conMsg.type, content: conMsg.content })
      continue
    }

    if (!response.tool_calls || response.tool_calls.length === 0) {
      // s20: 是否需要回顾
      maybeTriggerReview(reviewState, messages, db, systemPrompt, reviewCallback)
      if(streamCallback) {
        return
      }
      console.log(`\n✨ AI 回复:\n${response.content}\n`)
      return response.content
    }

    continuationCount = 0
    fireStreamDelta(null)

    console.log(chalk.bgBlue(`🔍 工具调用: ${response.tool_calls.map(t => t.name).join(', ')}`));
    for (const toolCall of response.tool_calls) {
      console.log(chalk.green(`🔍 工具调用: ${toolCall.name} - 参数: ${JSON.stringify(toolCall.args)}`));

      const argsPreview = JSON.stringify(toolCall.args).slice(0, 120)
      if(toolProgressCallback) {
        toolProgressCallback('tool.started', toolCall.name, argsPreview, toolCall.args, 0, false)
      }

      const now = Date.now()
      const toolResult = await toolRegistry.dispatch(toolCall.name, toolCall.args);
      const duration = (Date.now() - now) / 1000
      const isError = toolResult.startsWith('(error') || toolResult.slice(0, 50).includes('error')
      if(toolProgressCallback) {
        toolProgressCallback('tool.completed', toolCall.name, argsPreview, toolCall.args, duration, isError)
      }
      const toolMsg = new ToolMessage({ content: toolResult, tool_call_id: toolCall.id, name: toolCall.name });

      // s20 新增
      if(reviewState) {
        reviewState.onToolIteration()
        if(['memory', 'skill_manage'].includes(toolCall.name)) {
          // 显式使用记忆/技能工具时，重置回顾计数器
          reviewState.onManualMemoryOrSkill()
        }
      }

      messages.push(toolMsg);
      addMessage(db, sessionId, { role: toolMsg.type, content: toolResult, tool_call_id: toolCall.id  });
    }
  }

  // s20: 是否需要回顾
  maybeTriggerReview(reviewState, messages, db, systemPrompt, reviewCallback)

  console.log(chalk.red('⚠️  达到最大迭代次数'))
  return messages[messages.length - 1].content
}

export default runConversation