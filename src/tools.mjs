import { tool } from '@langchain/core/tools'
import fs from 'fs/promises'
import { execSync } from 'child_process'
import { z } from 'zod'

const TOOL_TIMEOUT = 30000
const BLOCKED_COMMANDS = ['rm -rf /', 'mkfs', 'dd if=', 'shutdown', 'reboot']
const ENABLED_TOOLSETS = ["terminal", "file", "web"]

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

  getDefinitions(enabledToolsets = ENABLED_TOOLSETS) {
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

export const shellTool = tool(
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

export const readFileTool = tool(
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

export const writeFileTool = tool(
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

export const webSearchTool = tool(
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

export { toolRegistry }