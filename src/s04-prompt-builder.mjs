import { SystemMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import readline from 'readline/promises'
import chalk from 'chalk'

import { model, MAX_ITERATIONS } from './common/model.mjs'
import { initDB, getSessionMessages, addMessage, createSession } from './common/persistent.mjs'
import { toolRegistry } from './common/tools.mjs'
import { buildSystemPrompt } from './common/system-prompt-builder.mjs'

const modelWithTools = model.bindTools(toolRegistry.getDefinitions())

async function runConversation(input, db, sessionId, systemPrompt) {
  const messages = getSessionMessages(db, sessionId)
  const humanMsg = new HumanMessage(input)
  messages.push(humanMsg)
  addMessage(db, sessionId, { role: humanMsg.type, content: humanMsg.content })

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const roundLabel = `第 ${i + 1} 轮`
    console.log(chalk.yellow(`⏳ ${roundLabel} - 正在等待 AI 思考...`));

    const response = await modelWithTools.invoke([new SystemMessage(systemPrompt), ...messages]);
    messages.push(response);

    let toolCalls = null
    if (response.tool_calls && response.tool_calls.length > 0) {
      toolCalls = response.tool_calls.map(item => ({
        id: item.id,
        name: item.name,
        args: item.args
      }))
    }
    addMessage(db, sessionId, { tool_calls: toolCalls, role: response.type, content: response.content })

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
  
  console.log('=== s04: Prompt Builder ===')
  console.log(`模型名称: ${process.env.AI_MODEL_NAME}`, `HERMES_HOME: ${process.env.HERMES_HOME}`)
  console.log(`系统提示词: ${cacheSystemPrompt.length} 字符`)
  console.log("输入exit退出\n")

  while (true) {
    const input = await rl.question('You: ')
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