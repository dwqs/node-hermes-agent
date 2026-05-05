import { z } from 'zod'
import { tool as coreTool } from '@langchain/core/tools'

import { toolRegistry } from './tools.mjs'

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
      schema: z.object({
        input: z.string().describe('Input to the tool'),
      }),
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
    const result = server.callTool(toolName, args)
    if (result.isError) {
      return `MCP server error: ${result.content}`
    }
    return result.content
  }
}

export function registerMcpServer(server, config = {}) {
  mcpServers[server.name] = server
  const includeTools = config.tools?.include || []
  const excludeTools = config.tools?.exclude || []

  const tools = server.listTools()
  const registered = []

  for (const tool of tools) {
    const name = tool.name
    if(!includeTools.includes(name) || excludeTools.includes(name)) {
      continue
    }

    // 添加前缀
    const prefixed = `mcp_${server.name}_${name}`
    const handler = makeMcpHandler(server.name, name)
    
    const wrappedTool = coreTool(handler, {
      name: prefixed,
      description: tool.description,
      schema: tool.schema,
    })

    toolRegistry.registerTool(wrappedTool)

    registered.push(prefixed)
  }
  return registered
}

export function unregisterMcpServer(serverName) {
  const server = mcpServers[serverName]
  if (!server) {
    return
  }

  const tools = server.listTools()
  for (const tool of tools) {
    const prefixed = `mcp_${serverName}_${tool.name}`
    toolRegistry.tools.delete(prefixed)
  }

  delete mcpServers[serverName]
  console.log(`Unregistered MCP server: ${serverName}\n`, mcpServers, '\n')
}