import { SystemMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import readline from 'readline/promises'
import chalk from 'chalk'

import { model, MAX_ITERATIONS } from './common.mjs'
import { toolRegistry } from './tools.mjs'
import { initDB, createSession, searchSessions, getSessionMessages, addMessage } from './persistent.mjs'

const tools = toolRegistry.getDefinitions()
const modelWithTools = model.bindTools(tools)

const systemMessage = new SystemMessage('你是一个能执行终端命令/读写文件/网络搜索的 AI 助手，会话信息都存储在 SQLite 数据库中')

async function runConversation(input, db, sessionId) {
  const messages = getSessionMessages(db, sessionId)
  const humanMsg = new HumanMessage(input)
  messages.push(humanMsg)
  addMessage(db, sessionId, { role: humanMsg.type, content: humanMsg.content })

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const roundLabel = `第 ${i + 1} 轮`
    console.log(chalk.yellow(`⏳ ${roundLabel} - 正在等待 AI 思考...`));

    const response = await modelWithTools.invoke([systemMessage, ...messages]);
    // response 是 AIMessage 类型
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
  
  console.log('=== s03: Session Store ===')
  console.log(`模型名称: ${process.env.AI_MODEL_NAME}`, `数据库路径: ${process.env.DB_PATH}`)
  console.log(`会话ID: ${sessionId}`)
  console.log("输入exit退出\n")

  while (true) {
    const input = await rl.question('You: ')
    const str = input.trim()
    
    if (!str || str === 'exit') {
      break
    }

    if(str.startsWith('/search'))  {
      const results = searchSessions(db, str.slice(8))
      console.log('results', results, '\n')
      continue
    }
    await runConversation(input.trim(), db, sessionId)
  }
  db.close()
  rl.close()
}

main()