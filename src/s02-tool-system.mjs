import { SystemMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import readline from 'readline/promises'
import chalk from 'chalk'

import { model, MAX_ITERATIONS } from './common/model.mjs'
import { toolRegistry } from './common/tools.mjs'

const tools = toolRegistry.getDefinitions()
const modelWithTools = model.bindTools(tools)

const messages = [new SystemMessage('你是一个能执行终端命令/读写文件/网络搜索的 AI 助手')]

async function runConversation(input) {
  messages.push(new HumanMessage(input))
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const roundLabel = `第 ${i + 1} 轮`
    console.log(chalk.yellow(`⏳ ${roundLabel} - 正在等待 AI 思考...`));

    const response = await modelWithTools.invoke(messages);
    messages.push(response);

    if (!response.tool_calls || response.tool_calls.length === 0) {
      console.log(`\n✨ AI 回复:\n${response.content}\n`);
      return response.content;
    }

    console.log(chalk.bgBlue(`🔍 工具调用: ${response.tool_calls.map(t => t.name).join(', ')}`));
    for (const toolCall of response.tool_calls) {
      console.log(chalk.green(`🔍 工具调用: ${toolCall.name} - 参数: ${JSON.stringify(toolCall.args)}`));
      const toolResult = await toolRegistry.dispatch(toolCall.name, toolCall.args);
      messages.push(new ToolMessage({ content: toolResult, tool_call_id: toolCall.id, name: toolCall.name }));
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
  
  console.log('=== s02: Tool System ===')
  console.log('注册的 tools 列表：', tools.map(t => t.name).join(', '))
  console.log(`模型名称: ${process.env.AI_MODEL_NAME}`)
  console.log("输入exit退出\n")

  while (true) {
    const input = await rl.question('> ')
    
    if (input.trim() === 'exit') {
      break
    }
    await runConversation(input.trim())
  }
  rl.close()
}

main()