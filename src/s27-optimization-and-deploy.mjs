import 'dotenv/config'
import readline from 'node:readline/promises'
import { setTimeout } from 'node:timers/promises'

import { loadEnv, loadYamlConfig } from './common/configuration-system.mjs'
import runConversation from './common/runConversation.mjs'
import { initDB, createSession } from './common/persistent.mjs'
import { buildSystemPrompt } from './common/system-prompt-builder.mjs'
import { GatewayRunner, ConsolePlatformAdapter } from './common/gateway.mjs'
import { HermesCLI } from './common/cli-and-web-interface.mjs'
import { evolveSkill } from './common/skill-evolution.mjs'

loadEnv()
const config = loadYamlConfig()
console.log('\nconfig=======\n', config, '\n========\n')

function runCli() {
  console.log('CLI mode with streaming\n')
  const cli = new HermesCLI(config)
  cli.run()
}

async function runLegacyCli() {
  console.log('Legacy CLI mode\n')
  console.log("输入exit退出\n")

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
  console.log("输入exit退出\n")

  const runner = new GatewayRunner(config, config.dbPath)
  const consoleAdapter = new ConsolePlatformAdapter()

  runner.addAdapter(consoleAdapter)
  await runner.start()

  try {
    while (consoleAdapter._running) {
      await setTimeout(500)
    }
  } catch (err) {
    // KeyboardInterrupt
  } finally {
    await runner.stop()
  }
}

async function runEvolve(skillName) {
  console.log('Evolving skill mode\n')
  const result = await evolveSkill(skillName)
  if (result) {
    const improvementStr = result.improvement >= 0 ? '+' : ''
    console.log(`\nResult: ${result.originalScore.toFixed(3)} -> ${result.evolvedScore.toFixed(3)} (${improvementStr}${result.improvement.toFixed(3)})`)
  } else {
    console.log('\nEvolution failed or skill not found.')
  }
}

function runWebInterface() {
  console.log('Web interface mode\n')
}

function main() {
  console.log('=== s27: Evolving skill ===')
  console.log(`模型名称: ${process.env.model}`)
  console.log(`Profile(Hermes Home): ${config.hermesHome}`)

  if(process.argv.includes('--gateway')) {
    runGateway()
  } else if(process.argv.includes('--web')) {
    runWebInterface()
  } else if(process.argv.includes('--streaming')) {
    runCli()
  } else if(process.argv.includes('--evolve')) {
    const idx = process.argv.indexOf('--evolve')
    const name = idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : ''
    if (name) {
      runEvolve(name)
    } else {
      console.log('Usage: --evolve <skill_name>')
    }
  } else {
    runLegacyCli()
  }
}

main()