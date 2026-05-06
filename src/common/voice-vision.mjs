import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 
 * mock 视觉模型
 * 辅助模型：视觉用单独的模型，和主模型分开。
 * STT 在适配器层做，TTS 在工具层做 + Gateway 层投递。
*/
class SimulatedVisionModel {
  analyze(imageBase64, question) {
    const lowerBase64 = imageBase64.toLowerCase()
    if (lowerBase64.includes('error') || lowerBase64.includes('traceback')) {
      return (
        'The image shows a Python traceback with a TypeError: ' +
        "'NoneType' object is not iterable. This typically happens " +
        'when you try to loop over a variable that is None.'
      )
    }
    if (lowerBase64.includes('chart') || lowerBase64.includes('graph')) {
      return (
        'The image shows a bar chart with 5 categories. ' +
        'The tallest bar is the third one, approximately 85 units.'
      )
    }
    return `The image appears to be a general screenshot. Question: ${question}`
  }
}

export const visionModel = new SimulatedVisionModel()

function imageToBase64(imagePath) {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`)
  }

  const data = fs.readFileSync(imagePath)
  // 大小检查（真实实现里是 20MB）
  if (data.length > 20 * 1024 * 1024) {
    throw new Error('Image too large (>20MB)')
  }

  // 格式检测
  let mime
  if (data.slice(0, 4).toString('hex') === '89504e47') {
    mime = 'image/png'
  } else if (data.slice(0, 2).toString('hex') === 'ffd8') {
    mime = 'image/jpeg'
  } else {
    mime = 'image/png' // fallback
  }

  const encoded = data.toString('base64')
  return `data:${mime};base64,${encoded}`
}

export function handleVisionAnalyze(args) {
  const imageUrl = args.image_url || ''
  const question = args.question || 'Describe this image.'

  try {
    let imageData
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      // 真实实现：下载图片 → 验证 → base64
      // 教学简化：用 URL 本身作为"内容"传给模拟模型
      imageData = imageUrl
    } else {
      // 本地文件
      imageData = imageToBase64(imageUrl)
    }
    const analysis = visionModel.analyze(imageData, question)
    return JSON.stringify({ result: analysis })
  } catch (exc) {
    return JSON.stringify({ error: exc.message })
  }
}

// Text-to-Speech(TTS)
export function handleTextToSpeech(args) {
  const text = args.text || ''
  if (!text) {
    return JSON.stringify({ error: 'No text provided' })
  }

  const audioDir = path.join(process.env.HERMES_HOME, 'cache', 'audio')
  fs.mkdirSync(audioDir, { recursive: true })

  const filename = `tts_${crypto.randomUUID().slice(0, 8)}.ogg`
  const audioPath = path.join(audioDir, filename)

  // 真实实现会调 Edge TTS / OpenAI TTS 生成真音频
  // 这里写一个占位文件
  fs.writeFileSync(audioPath, `[simulated audio: ${text.slice(0, 50)}]`)
  return JSON.stringify({
    success: true,
    file_path: audioPath,
    media_tag: `MEDIA:${audioPath}`,
  })
}

// Speech-to-Text (STT)
export function transcribeAudio(audioPath) {
  if (!fs.existsSync(audioPath)) {
    return { success: false, error: `File not found: ${audioPath}` }
  }
  // 模拟转写
  return {
    success: true,
    transcript: `[simulated transcript of ${path.basename(audioPath)}]`,
    provider: 'simulated',
  }
}