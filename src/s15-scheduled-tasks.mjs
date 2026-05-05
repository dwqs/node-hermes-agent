import 'dotenv/config'
import readline from 'node:readline/promises'
import { setTimeout } from 'node:timers/promises'

import { loadEnv, loadYamlConfig } from './common/configuration-system.mjs'
import runConversation from './common/runConversation.mjs'
import { initDB, createSession } from './common/persistent.mjs'
import { buildSystemPrompt } from './common/system-prompt-builder.mjs'
import { GatewayRunner, ConsolePlatformAdapter, MessageEvent, SessionSource, MessageType } from './common/gateway.mjs'
import { SimulatedPlatformAdapter } from './common/platform-adapters.mjs'
import { JobScheduler } from './common/scheduled-tasks.mjs'

loadEnv()
const config = loadYamlConfig()
console.log('\nconfig=======\n', config, '\n========\n')

async function runCli() {
  console.log('CLI mode\n')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  const db = await initDB()
  const sessionId = createSession(db)
  const cacheSystemPrompt = buildSystemPrompt()

  async function fireCli(job) {
    await runConversation(job.prompt, db, sessionId, cacheSystemPrompt)
  }

  // 启动定时任务调度器
  const scheduler = new JobScheduler(fireCli, 10)
  scheduler.start()
  
  while (true) {
    const input = await rl.question('> ')
    const str = input.trim()
    
    if (!str || str === 'exit') {
      scheduler.stop()
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

  function fireGateway(job) {
    const id = `cron-${job.jobId}-${Date.now()}`
    const event = new MessageEvent(
      id,
      job.prompt,
      new SessionSource('cron', id, 'scheduler', 'Scheduler', 'dm'),
      MessageType.TEXT,
      []
    )
    setImmediate(() => {
      runner._handleMessage(event)
    })
  }
  const scheduler = new JobScheduler(fireGateway, 10)
  scheduler.start()

  await runner.start()

  try {
    while (consoleAdapter._running) {
      await setTimeout(500)
    }
  } catch (err) {
    // KeyboardInterrupt
  } finally {
    await runner.stop()
    scheduler.stop()
  }
}

async function runSimulate() {
  console.log('=== s13: Platform Adapters (Simulated Gateway) ===')
  console.log('Replaying scripted messages to demo batching + dedup...\n')
  
  const runner = new GatewayRunner(config, config.dbPath)
  const sim = new SimulatedPlatformAdapter()
  runner.addAdapter(sim)

  await runner.start()

  try {
    while (sim._running) {
      await setTimeout(500)
    }
  } catch (err) {
    // KeyboardInterrupt
  } finally {
    await runner.stop()
  }

  // Report what happened
  console.log('\n--- Simulation Summary ---')
  console.log(`Replies sent: ${sim._replies.length}`)
  for (const [chatId, content] of sim._replies) {
    console.log(`  → ${chatId}: ${content.slice(0, 80)}...`)
  }
}

function main() {
  console.log('=== s15: Scheduled Tasks ===')
  console.log(`模型名称: ${process.env.model}`)
  console.log(`Profile(Hermes Home): ${config.hermesHome}`)
  console.log("输入exit退出\n")

  if(process.argv.includes('--gateway')) {
    runGateway()
  } else if(process.argv.includes('--simulate')) {
    runSimulate()
  } else {
    runCli()
  }
}

main()