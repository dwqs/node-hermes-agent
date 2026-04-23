import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'

export const model = new ChatOpenAI({
  modelName: process.env.AI_MODEL_NAME,
  apiKey: process.env.OPEN_AI_API_KEY,
  temperature: 0,
  timeout: 60000,
  maxRetries: 2,
  configuration: {
      baseURL: process.env.MODEL_BASE_URL,
  },
})