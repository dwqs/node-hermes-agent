import path from 'node:path'
import yaml from 'js-yaml'
import { readdir, readFile } from 'node:fs/promises'
import chalk from 'chalk'


// 内置 hook：在 Gateway 启动时运行 BOOT.md 作为代理提示词
async function handleBootMd() {
  const bootPath = path.join(process.env.HERMES_HOME, 'BOOT.md')

  let content
  try {
    content = await readFile(bootPath, 'utf-8')
    content = content.trim()
  } catch {
    return
  }
  
  if (!content) {
    return
  }

  // 实际要调用 runConversation 函数，这里只是模拟
  console.log(chalk.green(`  [hooks] Running BOOT.md: ${bootPath}`))
}

/** 
 * 两套 hook 系统：Gateway hooks（事件驱动）和 Plugin hooks（回调驱动）
 * 异常永远不传播——一个坏 hook 不能搞崩核心循环。
*/

class GatewayHookRegistry {
  constructor() {
    this._handlers = {}
    this._loadedHooks = []
  }

  /**
   * 为事件类型注册处理器。
   * @param {string} eventType
   * @param {Function} handler
   */
  register(eventType, handler) {
    if (!this._handlers[eventType]) {
      this._handlers[eventType] = []
    }
    this._handlers[eventType].push(handler)
  }

  async emit(eventType, context = null) {
    const handlers = [...(this._handlers[eventType] || [])]

    // 通配符："command:*" 匹配任何 "command:xxx"
    if (eventType.includes(':')) {
      const base = eventType.split(':')[0]
      const wildcardKey = `${base}:*`
      if (this._handlers[wildcardKey]) {
        handlers.push(...this._handlers[wildcardKey])
      }
    }

    for (const fn of handlers) {
      try {
        const result = fn(eventType, context || {})
        if (result && typeof result.then === 'function') {
          await result
        }
      } catch (e) {
        console.log(chalk.red(`  [hooks] Error in handler for '${eventType}': ${e.message}`))
      }
    }
  }

  // 扫描 hooks 目录查找 HOOK.yaml + handler.js
  async discoverAndLoad(hooksDir) {
    this._registerBuiltinHooks()

    try {
      await readdir(hooksDir)
    } catch {
      return
    }

    const entries = await readdir(hooksDir, { withFileTypes: true })
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of sorted) {
      if (!entry.isDirectory()) {
        continue
      }

      const hookDir = path.join(hooksDir, entry.name)
      const manifestPath = path.join(hookDir, 'HOOK.yaml')
      const handlerPath = path.join(hookDir, 'handler.js')

      try {
        await readFile(manifestPath)
        await readFile(handlerPath)
      } catch {
        continue
      }

      try {
        const manifestContent = await readFile(manifestPath, 'utf-8')
        const meta = yaml.load(manifestContent)
        if (!meta || !meta.events) {
          continue
        }
        // 动态导入 handler.js
        const moduleUrl = 'file://' + handlerPath
        const module = await import(moduleUrl)
        const handleFn = module.handle
        if (!handleFn) {
          console.log(chalk.red(`  [hooks] ${entry.name}: no 'handle' function`))
          continue
        }
        for (const event of meta.events) {
          this.register(event, handleFn)
        }
        this._loadedHooks.push({
          name: meta.name || entry.name,
          description: meta.description || '',
          events: meta.events,
          path: hookDir,
        })
      } catch (e) {
        console.log(chalk.red(`  [hooks] Failed to load ${entry.name}: ${e.message}`))
      }
    }
  }

  // 注册内置的 BOOT.md hook
  _registerBuiltinHooks() {
    this.register('gateway:startup', handleBootMd)
    this._loadedHooks.push({
      name: 'boot-md',
      description: 'Run HERMES_HOME/BOOT.md on gateway startup',
      events: ['gateway:startup'],
      path: '(builtin)',
    })
  }

  listHooks() {
    return [...this._loadedHooks]
  }
}

/** 
 * 代理级别生命周期事件的同步回调注册表
 * 在 CLI 和 Gateway 模式下都可用。回调通过 registerHook 注册，通过 invokeHook 触发。
*/
class PluginHookRegistry {
   // 有效的 hook 名称
  static VALID_HOOKS = new Set([
    'pre_tool_call',
    'post_tool_call',
    'pre_llm_call',
    'post_llm_call',
    'on_session_start',
    'on_session_end',
  ])

  constructor() {
    this._hooks = {}
  }

  registerHook(hookName, callback) {
    if (!PluginHookRegistry.VALID_HOOKS.has(hookName)) {
      const validHooks = Array.from(PluginHookRegistry.VALID_HOOKS).sort()
      throw new Error(`Unknown hook: ${hookName}. Valid: ${validHooks}`)
    }
    if (!this._hooks[hookName]) {
      this._hooks[hookName] = []
    }
    this._hooks[hookName].push(callback)
  }

  invokeHook(hookName, kwargs = {}) {
    const results = []
    const callbacks = this._hooks[hookName] || []
    for (const cb of callbacks) {
      try {
        const ret = cb(kwargs)
        if (ret !== null && ret !== undefined) {
          results.push(ret)
        }
      } catch (e) {
        const cbName = cb.name || 'anonymous'
        console.log(chalk.red(`  [hook] ${hookName} error in ${cbName}: ${e.message}`))
      }
    }
    return results
  }

  listHooks() {
    const result = {}
    for (const [name, cbs] of Object.entries(this._hooks)) {
      if (cbs.length > 0) {
        result[name] = cbs.length
      }
    }
    return result
  }
}

export const gatewayHookRegistry = new GatewayHookRegistry()
export const pluginHookRegistry = new PluginHookRegistry()