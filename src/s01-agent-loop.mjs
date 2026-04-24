import { tool } from '@langchain/core/tools'
import { SystemMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { execSync } from 'child_process'
import readline from 'readline/promises'
import chalk from 'chalk'

import { model, MAX_ITERATIONS, TOOL_TIMEOUT, BLOCKED_COMMANDS } from './common.mjs'

const shellTool = tool(
  ({ command }) => {
    for (const blocked of BLOCKED_COMMANDS) {
      if (command.includes(blocked)) {
        return JSON.stringify({ error: `Blocked: ${blocked}` })
      }
    }
    try {
      const output = execSync(command, { encoding: 'utf-8', timeout: TOOL_TIMEOUT })
      return output.slice(0, 1000) || '(no output)'
    } catch (err) {
      if (err.killed) {
        return '(command timed out after 30s)'
      }
      const output = (err.stdout || '') + (err.stderr || '')
      return output.slice(0, 1000) || `(error: ${err.message})`
    }
  },
  {
    name: 'shell_tool',
    description: '执行 shell 命令并返回输出结果',
    schema: z.object({ command: z.string().describe('执行 shell 命令并返回输出结果') })
  }
)

const messages = [new SystemMessage('你是一个能执行终端命令的 AI 助手')]
const tools = [shellTool]
const modelWithTools = model.bindTools(tools)

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
      const foundTool = tools.find(t => t.name === toolCall.name);
      if (!foundTool) {
        continue;
      }
      const toolResult = await foundTool.invoke(toolCall.args);
      messages.push(new ToolMessage({ content: toolResult, tool_call_id: toolCall.id }));
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

  console.log('=== s01: Minimal Agent Loop ===')
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