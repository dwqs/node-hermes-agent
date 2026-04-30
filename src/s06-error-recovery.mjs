import readline from 'readline/promises'
import chalk from 'chalk'
import { HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'

import { model, MAX_ITERATIONS, FALLBACK_MODEL, MAX_RETRIES, MAX_CONTINUATIONS, CONTINUE_MESSAGE } from './common/model.mjs'
import { initDB, createSession, getSessionMessages, addMessage } from './common/persistent.mjs'
import { buildSystemPrompt } from './common/system-prompt-builder.mjs'
import { toolRegistry } from './common/tools.mjs'
import { compress } from './common/context-compression.mjs'
import { classifyError, exponentialBackoff, switchFallbackModel } from './common/error-recovery.mjs'

let activeClient = model.bindTools(toolRegistry.getDefinitions())
let activeModelName = process.env.AI_MODEL_NAME

async function runConversation(input, db, sessionId, systemPrompt) {
  let messages = getSessionMessages(db, sessionId)
  const humanMsg = new HumanMessage(input)
  messages.push(humanMsg)
  addMessage(db, sessionId, { role: humanMsg.type, content: humanMsg.content })

  let retryCount = 0
  let continuationCount = 0

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const roundLabel = `第 ${i + 1} 轮`
    console.log(chalk.yellow(`⏳ ${roundLabel} - 正在等待 AI 思考...`));

    let response = null
    try {
      response = await activeClient.invoke([new SystemMessage(systemPrompt), ...messages])
      messages.push(response)
    } catch (error) {
      const classified = classifyError(error.status, error)
      console.log(chalk.red(`🔍 错误分类: ${classified.reason}, status: ${error.status}`))
      
      // 优先级：压缩 > 切换模型 > 退避重试；一轮异常至多执行其中一个动作，然后 continue 重试
      if(classified.shouldCompress) {
        messages = await compress(messages)
        continue
      } else if(classified.shouldFallback) {
        console.log(chalk.yellow(`🔍 切换备选模型: ${FALLBACK_MODEL}`))
        activeClient = switchFallbackModel()
        activeModelName = FALLBACK_MODEL
        continue
      } else if(classified.retryable && retryCount < MAX_RETRIES) {
        retryCount++
        const delay = exponentialBackoff(retryCount)
        await new Promise(resolve => setTimeout(resolve, delay * 1000))
        continue
      } else {
        throw error
      }
    }

    console.log('\n===', response, '\n')
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

    // 自动续写：模型因 max_tokens 被截断时，注入 "请继续" 让它接着写
    const finishReason = response.response_metadata.finish_reason
    if(finishReason === 'length' && continuationCount < MAX_CONTINUATIONS) {
      continuationCount++
      const conMsg = new HumanMessage(CONTINUE_MESSAGE)
      messages.push(conMsg)
      addMessage(db, sessionId, { role: conMsg.type, content: conMsg.content })
      continue
    }

    if (!response.tool_calls || response.tool_calls.length === 0) {
      console.log(`\n✨ AI 回复:\n${response.content}\n`);
      return response.content;
    }

    console.log(chalk.bgBlue(`🔍 工具调用: ${response.tool_calls.map(t => t.name).join(', ')}`));
    for (const toolCall of response.tool_calls) {
      console.log(chalk.green(`🔍 工具调用: ${toolCall.name} - 参数: ${JSON.stringify(toolCall.args)}`));
      const toolResult = await toolRegistry.dispatch(toolCall.name, toolCall.args);
      const toolMsg = new ToolMessage({ content: toolResult, tool_call_id: toolCall.id, name: toolCall.name });
      messages.push(toolMsg);
      addMessage(db, sessionId, { role: toolMsg.type, content: toolResult, tool_call_id: toolCall.id  });
    }
  }

  console.log(chalk.red('⚠️  达到最大迭代次数'));
  return messages[messages.length - 1].content;
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  const db = await initDB()
  const sessionId = createSession(db)
  const cacheSystemPrompt = buildSystemPrompt()
  
  console.log('=== s06: Error Recovery ===')
  console.log(`模型名称: ${process.env.AI_MODEL_NAME}`)
  console.log(`备选模型: ${FALLBACK_MODEL}`)
  console.log("输入exit退出\n")

  while (true) {
    const input = await rl.question('> ')
    const str = input.trim()
    
    if (!str || str === 'exit') {
      break
    }

    await runConversation(input.trim(), db, sessionId, cacheSystemPrompt)
  }
  db.close()
  rl.close()
}

main()