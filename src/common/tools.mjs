import 'dotenv/config'
import { tool } from '@langchain/core/tools'
import fs from 'fs/promises'
// import { execSync } from 'child_process'
import { z } from 'zod'
import { getJson } from 'serpapi'

import { manageMemory } from './memory.mjs'
import { skillManage, skillView } from './skill-system.mjs'
import { approveDangerousCommand, detectDangerousCommand } from './permission-system.mjs'
import { buildSubAgent, runSubAgent } from './subagent.mjs'
import { createBackendEnv } from './terminal-backends.mjs'
import { loadYamlConfig } from './configuration-system.mjs'
import { handleCronTool } from './scheduled-tasks.mjs'
import { browserTools } from './browser-automation.mjs'

const TOOL_TIMEOUT = 30000
const BLOCKED_COMMANDS = ['rm -rf /', 'mkfs', 'dd if=', 'shutdown', 'reboot']
const ENABLED_TOOLSETS = [
  'terminal', 'file', 'web', 
  'memory', 'skill', 'delegate', 
  'cron', 'mcp_', 'browser'
]

const config = loadYamlConfig()
const backendEnv = createBackendEnv(config)

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

const shellTool = tool(
  async ({ command }) => {
    // 识别危险命令
    const matches = detectDangerousCommand(command)
    if(matches.length > 0) {
      const approved = await approveDangerousCommand(command, matches)
      if(!approved) {
        return JSON.stringify({ error: `拒绝执行危险命令: ${command}` })
      }
    }

    for (const blocked of BLOCKED_COMMANDS) {
      if (command.includes(blocked)) {
        return JSON.stringify({ error: `Blocked: ${blocked}` })
      }
    }
    try {
      // const output = execSync(command, { encoding: 'utf-8', timeout: TOOL_TIMEOUT })
      // return output.slice(0, 1000) || '(no output)'
      // 从 s14 开始，改成终端执行环境执行命令
      const { output, returncode } = await backendEnv.execute(command, TOOL_TIMEOUT)
      if(returncode) {
        return `${output} (exit code: ${output})`
      }
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
  async ({ query }) => {
    try {
      const response = await getJson({
        q: query,
        engine: 'google',
        api_key: process.env.SERP_API_KEY,
        timeout: 60000,
      })
      return `Google 搜索结果:\n${response.organic_results.map(result => `${result.title}\n${result.snippet}\n${result.link}`).join('\n')}`
    } catch (err) {
      if (err.killed) {
        return '搜索请求超时，请稍后重试'
      }
      return `搜索失败: ${err.message}`
    }
  },
  {
    name: 'web_search',
    description: '使用此工具进行网络搜索（通过 Google）',
    schema: z.object({
      query: z.string().describe('要搜索的查询关键词'),
    }),
  }
)

const memoryTool = tool(
  ({ action, target, content }) => {
    return manageMemory(action, target, content)
  },
  {
    name: 'memory',
    description: '跨会话管理持久化记忆。操作：add（保存事实）、remove（按关键词删除）、read（列出所有）。目标：memory（通用知识）或 user（用户画像）。写入会立即生效到磁盘，但系统提示词将在下个会话更新。',
    schema: z.object({
      action: z.enum(['add', 'remove', 'read']).describe('要执行的操作: add, remove, read'),
      target: z.enum(['memory', 'user']).describe('类型'),
      content: z.string().describe('要添加/删除的内容'),
    }),
  }
)

const skillManageTool = tool(
  skillManage,
  {
    name: 'skill_manage',
    description: '管理 Agent 技能。操作：create（新建技能）、edit（更新）、delete（删除）。',
    schema: z.object({ 
      action: z.enum(['create', 'edit', 'delete']).describe('要执行的操作: create, edit, delete'),
      name: z.string().describe('技能名称'),
      description: z.string().describe('技能描述'),
      body: z.string().describe('技能正文') }
    ),
    required: ['action', 'name'],
  }
)

const skillViewTool = tool(
  ({ name }) => skillView(name),
  {
    name: 'skill_view',
    description: '根据技能名称，查看 Agent 技能的详细信息。',
    schema: z.object({ name: z.string().describe('技能名称') }),
    required: ['name'],
  }
)

// 委托任务给子 Agent 执行，在父agent 看来，这是一个工具调用
const delegateTaskTool = tool(
  async ({ goal, context }) => {
    if(!goal || !context) {
      return '任务目标和上下文不能为空'
    }
    const subAgentEnv = buildSubAgent(goal, context, toolRegistry.getDefinitions())
    const result = await runSubAgent(subAgentEnv)
    return result
  },
  {
    name: 'delegate_task',
    description: '将特定任务委派给具有独立上下文的子代理。子代理可使用指定的工具集，但不能再进一步委派、修改记忆或管理技能。仅返回最终结果文本。',
    schema: z.object({
      goal: z.string().describe('任务目标'),
      context: z.string().describe('子 Agent 执行任务的相关上下文'),
    }),
  }
)

const cronJobTool = tool(
  async ({ action, schedule, prompt, job_id }) => {
    return handleCronTool({ action, schedule, prompt, job_id })
  },
  {
    name: 'cron',
    description: "创建、列出或删除定时任务。调度格式：'30m'（一次性延迟）、'每 1s'、'every 2h'（重复间隔）、'0 9 * * 1-5'（cron 表达式）。",
    schema: z.object({
      action: z.enum(['create', 'list', 'delete']).describe('要执行的操作: create, list, delete'),
      schedule: z.string().optional().describe('调度表达式: 30m, 每 1s, every 2h, 0 9 * * 1-5，action=create 时必须'),
      prompt: z.string().optional().describe('触发消息，action=create 时必须'),
      job_id: z.string().optional().describe('删除的 job id，action=delete 时必须'),
    }),
    required: ['action'],
  }
)


const toolRegistry = new ToolRegistry()
toolRegistry.registerTool(shellTool)
toolRegistry.registerTool(readFileTool)
toolRegistry.registerTool(writeFileTool)
toolRegistry.registerTool(webSearchTool)
toolRegistry.registerTool(memoryTool)
toolRegistry.registerTool(skillManageTool)
toolRegistry.registerTool(skillViewTool)
toolRegistry.registerTool(delegateTaskTool)
toolRegistry.registerTool(cronJobTool)

browserTools.forEach(t => toolRegistry.registerTool(tool(t.handler, t.meta)))

export { toolRegistry }