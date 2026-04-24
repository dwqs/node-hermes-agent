import { tool } from '@langchain/core/tools'
import { SystemMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { execSync } from 'child_process'
import readline from 'readline/promises'
import chalk from 'chalk'
import fs from 'fs/promises' 

import { model, MAX_ITERATIONS, TOOL_TIMEOUT, BLOCKED_COMMANDS, ENABLED_TOOLSETS } from './common.mjs'


class ToolRegistry {
  constructor() {
    this.tools = new Map()
  }

  registerTool(tool) {
    this.tools.set(tool.name, tool)
  }

  async dispatch(name, args) {
    const tool = this.tools.get(name)
    if (!tool) {
      return JSON.stringify({ error: `Tool not found: ${name}` })
    }
    return await tool.invoke(args)
  }

  getDefinitions(enabledToolsets = []) {
    const definitions = []
    for (const [name, tool] of this.tools.entries()) {
      const item = enabledToolsets.find(t => name.includes(t))
      if (item) {
        definitions.push(tool)
      }
    }
    return definitions
  }
}

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
    name: 'terminal',
    description: '执行 shell 命令并返回输出结果',
    schema: z.object({ command: z.string().describe('执行 shell 命令并返回输出结果') })
  }
)

const readFileTool = tool(
  async ({ filePath }) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return `文件内容:\n${content}`;
    } catch (error) {
      console.log(`  [工具调用] read_file("${filePath}") - 错误: ${error.message}`);
      return `读取文件失败: ${error.message}`;
    }
  },
  {
    name: 'read_file',
    description: '用此工具来读取文件内容。当用户要求读取文件、查看代码、分析文件内容时，调用此工具。输入文件路径（可以是相对路径或绝对路径）。',
    schema: z.object({
      filePath: z.string().describe('要读取的文件路径'),
    }),
  }
)

const writeFileTool = tool(
  async ({ filePath, content }) => {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      return `文件写入成功: ${filePath}`;
    } catch (error) {
      return `写入文件失败: ${error.message}`;
    }
  },
  {
    name: 'write_file',
    description: '向指定路径写入文件内容，自动创建目录',
    schema: z.object({
      filePath: z.string().describe('文件路径'),
      content: z.string().describe('要写入的文件内容'),
    }),
  }
)

const webSearchTool = tool(
  ({ query }) => {
    return `抱歉，搜索功能目前正在开发中...: ${query}`;
  },
  {
    name: 'web_search',
    description: '使用此工具进行网络搜索',
    schema: z.object({
      query: z.string().describe('要搜索的查询'),
    }),
  }
)


const toolRegistry = new ToolRegistry()
toolRegistry.registerTool(shellTool)
toolRegistry.registerTool(readFileTool)
toolRegistry.registerTool(writeFileTool)
toolRegistry.registerTool(webSearchTool)

const tools = toolRegistry.getDefinitions(ENABLED_TOOLSETS)
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
      const foundTool = tools.find(t => t.name === toolCall.name);
      if (!foundTool) {
        continue;
      }
      console.log(chalk.green(`🔍 工具调用: ${toolCall.name} - 参数: ${JSON.stringify(toolCall.args)}`));
      const toolResult = await toolRegistry.dispatch(toolCall.name, toolCall.args);
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