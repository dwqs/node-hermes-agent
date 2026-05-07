import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import chalk from 'chalk'

import { initDB, createSession, getSessionMessages } from './persistent.mjs'
import { buildSystemPrompt } from './system-prompt-builder.mjs'
import { compress } from './context-compression.mjs'
import runConversation from './runConversation.mjs'

class CommandDef {
  /**
   * Definition of a slash command.
   * @param {string} name
   * @param {string} description
   * @param {string} category - "Session" / "Configuration" / "Info" / "Exit"
   * @param {string[]} [aliases=[]]
   * @param {string} [argsHint=""]
   * @param {boolean} [cliOnly=false]
   * @param {boolean} [gatewayOnly=false]
   */
  constructor(name, description, category, aliases = [], argsHint = '', cliOnly = false, gatewayOnly = false) {
    this.name = name
    this.description = description
    this.category = category
    this.aliases = aliases
    this.argsHint = argsHint
    this.cliOnly = cliOnly
    this.gatewayOnly = gatewayOnly
  }
}

const COMMAND_REGISTRY = [
  // Session
  new CommandDef('new', 'Start a new session', 'Session', ['reset']),
  new CommandDef('clear', 'Clear screen and start new session', 'Session', [], '', true),
  new CommandDef('history', 'Show conversation history', 'Session', [], '', true),
  new CommandDef('retry', 'Retry the last message', 'Session'),
  new CommandDef('undo', 'Remove the last exchange', 'Session'),
  new CommandDef('compress', 'Manually compress context', 'Session'),
  new CommandDef('background', 'Run prompt in background', 'Session', ['bg'], '<prompt>'),

  // Configuration
  new CommandDef('model', 'Switch model', 'Configuration', [], '[name]'),
  new CommandDef('tools', 'Manage toolsets', 'Configuration', [], '[list|enable|disable]'),
  new CommandDef('config', 'Show or edit configuration', 'Configuration'),

  // Info
  new CommandDef('help', 'Show available commands', 'Info'),
  new CommandDef('status', 'Show session info', 'Info'),
  new CommandDef('profile', 'Show active profile', 'Info'),

  // Exit
  new CommandDef('quit', 'Exit the CLI', 'Exit', ['exit'], '', true),
]

function resolveCommand(name) {
  name = name.toLowerCase().replace(/^\/+/, '')
  for (const cmd of COMMAND_REGISTRY) {
    if (cmd.name === name || cmd.aliases.includes(name)) {
      return cmd
    }
  }
  return null
}

function getCommandNames() {
  const names = []
  for (const cmd of COMMAND_REGISTRY) {
    names.push('/' + cmd.name)
    for (const alias of cmd.aliases) {
      names.push('/' + alias)
    }
  }
  return names.sort()
}

class StreamRenderer {
  constructor(printFn = null) {
    this._print = printFn || console.log
    this._buffer = ''
    this._inResponse = false
  }
  /**
   * Process a stream delta. null = turn boundary.
   * @param {string|null} text
   */
  delta(text) {
    if (text === null) {
      this.flush()
      return
    }
    if (!this._inResponse) {
      this._inResponse = true
      this._print('')  // blank line before response
    }
    this._buffer += text
    while (this._buffer.includes('\n')) {
      const idx = this._buffer.indexOf('\n')
      const line = this._buffer.slice(0, idx)
      this._buffer = this._buffer.slice(idx + 1)
      this._print(line)
    }
  }
  /**
   * Flush any remaining buffered text.
   */
  flush() {
    if (this._buffer) {
      this._print(this._buffer)
      this._buffer = ''
    }
    this._inResponse = false
  }
}

// Interactive CLI with streaming, tool progress, and slash commands
export class HermesCLI {
  constructor(config, streaming = true) {
    this.config = config
    this.streaming = streaming

    this._pendingInput = []
    this._shouldExit = false
    this._agentRunning = false
    this._spinnerText = ''
    this._renderer = new StreamRenderer((text) => this._cliPrint(text))
  }

  async init() {
    this.db = await initDB()
    this.sessionId = createSession(this.db)
    this.cachedPrompt = buildSystemPrompt()
  }

  _cliPrint(text) {
    console.log(text)
  }

  _streamDelta(text) {
    this._renderer.delta(text)
  }

  // tool progress callback
  _onToolProgress(eventType, functionName, preview, functionArgs, duration, isError) {
    if (eventType === 'tool.started') {
      this._spinnerText = `\n\n  ⚙ ${functionName}: ${preview.slice(0, 60)}\n\n`
      // 生产环境可以使用 spinner 包
      console.log(chalk.yellow(this._spinnerText))
    } else if (eventType === 'tool.completed') {
      const status = isError ? '[error]' : ''
      console.log(chalk.yellow(`\n\n  [tool] ${functionName}  ${duration.toFixed(1)}s ${status} \n\n`))
    }
  }

  processCommand(command) {
    const parts = command.trim().split(/\s+/, 2)
    const cmdWord = parts[0]
    const cmdArgs = parts[1] || ''
    const resolved = resolveCommand(cmdWord)

    if (!resolved) {
      console.log(chalk.red(`  Unknown command: ${cmdWord}. Type /help for help.`))
      return true
    }
    if (resolved.name === 'quit') {
      return false
    } else if (resolved.name === 'help') {
      this._showHelp()
    } else if (resolved.name === 'new') {
      this.sessionId = createSession(this.db)
      console.log('  New session started.')
    } else if (resolved.name === 'clear') {
      // Clear screen
      stdout.write('\x1Bc')
      this.sessionId = createSession(this.db)
      console.log('  Screen cleared, new session.')
    } else if (resolved.name === 'history') {
      const msgs = getSessionMessages(this.db, this.sessionId)
      for (const m of msgs.slice(-10)) {
        const role = m.role || '?'
        const content = (m.content || '').slice(0, 80)
        console.log(`  [${role}] ${content}`)
      }
    } else if (resolved.name === 'status') {
      console.log(`  Session: ${this.sessionId}`)
      console.log(`  Model: ${this.config.model}`)
      console.log(`  Streaming: ${this.streaming}`)
    } else if (resolved.name === 'compress') {
      const msgs = getSessionMessages(this.db, this.sessionId)
      const compressed = compress(msgs)
      console.log(`  Compressed ${msgs.length} → ${compressed.length} messages.`)
    } else {
      console.log(`  Command /${resolved.name} not implemented in teaching version.`)
    }
    return true
  }

  _showHelp() {
    const categories = {}
    for (const cmd of COMMAND_REGISTRY) {
      if (!categories[cmd.category]) {
        categories[cmd.category] = []
      }
      categories[cmd.category].push(cmd)
    }
    for (const [cat, cmds] of Object.entries(categories)) {
      console.log(`\n  ${cat}:`)
      for (const cmd of cmds) {
        const aliases = cmd.aliases.length ? ` (${cmd.aliases.join(', ')})` : ''
        const hint = cmd.argsHint ? ` ${cmd.argsHint}` : ''
        console.log(`    /${cmd.name}${hint}${aliases} — ${cmd.description}`)
      }
    }
    console.log()
  }

  // 主入口
  async run() {
    await this.init()
    
    console.log(`Streaming: ${this.streaming}`)
    console.log(`System prompt: ${this.cachedPrompt.length} chars`)
    console.log('Type /help for commands, /quit to exit.\n')

    const rl = readline.createInterface({
      input: stdin,
      output: stdout,
    })

    while (!this._shouldExit) {
      try {
        let userInput = await rl.question('You: ')
        userInput = userInput.trim()
        if (!userInput) {
          continue
        }
        // Slash command
        if (userInput.startsWith('/')) {
          const shouldContinue = this.processCommand(userInput)
          if (!shouldContinue) {
            break
          }
          continue
        }
        // Normal message → agent
        this._agentRunning = true
        try {
          const result = await runConversation(
            userInput,
            this.db,
            this.sessionId,
            this.cachedPrompt,
            this.streaming ? (text) => this._streamDelta(text) : null,
            (eventType, functionName, preview, functionArgs, duration, isError) =>
              this._onToolProgress(eventType, functionName, preview, functionArgs, duration, isError),
          )
          // If not streaming, print the full response
          if (!this.streaming) {
            console.log(`\nAssistant: ${result.final_response}\n`)
          } else {
            this._renderer.flush()
            console.log() // newline after streamed response
          }
        } catch (e) {
          console.log(`\n  [error] ${e.message}\n`)
        } finally {
          this._agentRunning = false
        }
      } catch (e) {
        if (e.message === 'SIGINT') {
          break
        }
        break
      }
    }
    rl.close()
    this.db.close()
    console.log('Goodbye.')
  }
}