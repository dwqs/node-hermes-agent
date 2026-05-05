import { z } from 'zod'
import { tool as coreTool } from '@langchain/core/tools'

import { toolRegistry } from './tools.mjs'

/** 
 * LangChain 的 tool() 需要 zod schema，但 MCP 返回的是 JSON Schema。
 * 需要一个简单的转换器
*/

function jsonSchemaToZod(schema) {
  if (!schema || schema.type !== 'object') {
    return z.object({ input: z.string().optional() })
  }

  const shape = {}
  const props = schema.properties || {}
  const required = new Set(schema.required || [])
  for (const [key, prop] of Object.entries(props)) {
    let field
    switch (prop.type) {
      case 'number':
      case 'integer':
        field = z.number()
        break
      case 'boolean':
        field = z.boolean()
        break
      case 'array':
        field = z.array(z.any())
        break
      default:
        field = z.string()
    }
    if (prop.description) {
      field = field.describe(prop.description)
    }
    if (!required.has(key)) {
      field = field.optional()
    }
    shape[key] = field
  }
  return z.object(shape)
}

export class SimulatedMCPServer {
  constructor(name, tools) {
    this.name = name
    this._tools = tools
  }

  listTools() {
    if(!this._tools) {
      return []
    }
    return Object.keys(this._tools).map(name => ({
      name,
      description: `模拟工具: ${name}`,
      inputSchema: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'Input to the tool',
          },
        },
      },
    }))
  }

  callTool(name, args) {
    if(!this._tools[name]) {
      return {
        isError: true,
        content: `Tool not found: ${name}`,
      }
    }
    try {
      return { isError: false, content: this._tools[name](args) }
    } catch (error) {
      return { isError: true, content: error.message }
    }
  }
}

const mcpServers = {}

function makeMcpHandler(serverName, toolName) {
  return async (args) => {
    const server = mcpServers[serverName];
    if (!server) {
      return `MCP server not found: ${serverName}`
    }
    const result = await server.callTool(toolName, args)
    if (result.isError) {
      return `MCP server error: ${result.content}`
    }

    if(typeof result.content === 'string') {
      return result.content
    }

    // mcp 协议返回的是数组，需要转换为字符串
    if (Array.isArray(result.content)) {
      const texts = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
      return texts || '没有找到相关信息'
    }
    return '你好'
  }
}

export async function registerMcpServer(server, config = {}) {
  mcpServers[server.name] = server
  const includeTools = config.tools?.include || []
  const excludeTools = config.tools?.exclude || []

  const tools = await server.listTools()
  const registered = []

  for (const tool of tools) {
    const name = tool.name
    if(includeTools.length && !includeTools.includes(name)) {
      continue
    }
    if(excludeTools.includes(name)) {
      continue
    }

    // 添加前缀
    const prefixed = `mcp_${server.name}_${name}`
    const handler = makeMcpHandler(server.name, name)

    const schema = jsonSchemaToZod(tool.inputSchema)
    
    const wrappedTool = coreTool(handler, {
      name: prefixed,
      description: tool.description,
      schema,
    })

    toolRegistry.registerTool(wrappedTool)
    registered.push(prefixed)
  }
  return registered
}

export async function unregisterMcpServer(serverName) {
  const server = mcpServers[serverName]
  if (!server) {
    return
  }

  const tools = awaitserver.listTools()
  for (const tool of tools) {
    const prefixed = `mcp_${serverName}_${tool.name}`
    toolRegistry.tools.delete(prefixed)
  }

  delete mcpServers[serverName]
  console.log(`Unregistered MCP server: ${serverName}\n`, mcpServers, '\n')
}

// 进程退出时关闭所有 MCP 连接
process.on('SIGINT', async () => {
  for (const server of Object.values(mcpServers)) {
    if (server.disconnect) {
      await server.disconnect()
    }
  }
  process.exit(0)
})