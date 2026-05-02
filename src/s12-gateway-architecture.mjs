import 'dotenv/config'
import readline from 'node:readline/promises'

import { loadEnv, loadYamlConfig } from './common/configuration-system.mjs'
import runConversation from './common/runConversation.mjs'
import { initDB, createSession } from './common/persistent.mjs'
import { buildSystemPrompt } from './common/system-prompt-builder.mjs'
import { GatewayRunner, ConsolePlatformAdapter } from './common/gateway.mjs'

loadEnv()
const config = loadYamlConfig()
console.log('\nconfig=======\n', config, '\n========\n')

async function runCli() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  const db = await initDB()
  const sessionId = createSession(db)
  const cacheSystemPrompt = buildSystemPrompt()
  
  while (true) {
    const input = await rl.question('> ')
    const str = input.trim()
    
    if (!str || str === 'exit') {
      break
    }

    await runConversation(str, db, sessionId, cacheSystemPrompt)
  }
  db.close()
  rl.close()
}

async function runGateway() {
  console.log('所有消息经由 GatewayRunner → adapter → 核心循环\n')
  const runner = new GatewayRunner(config, config.dbPath)
  const consoleAdapter = new ConsolePlatformAdapter()

  runner.addAdapter(consoleAdapter)
  await runner.start()

  try {
    while (consoleAdapter._running) {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } catch (err) {
    // KeyboardInterrupt
  } finally {
    await runner.stop()
  }
}

function main() {
  console.log('=== s12: Gateway Architecture ===')
  console.log(`模型名称: ${process.env.model}`)
  console.log(`Profile(Hermes Home): ${config.hermesHome}`)
  console.log("输入exit退出\n")

  if(process.argv.includes('--gateway')) {
    runGateway()
  } else {
    runCli()
  }
}

main()