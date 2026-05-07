// s19 新增
export async function collectStream(streamResponse, fireDelta) {
  const collectedContent = []
  const collectedToolCalls = new Map()

  let finishReason = null
  let responseId = null
  let additionalKwargs = null
  let responseMetadata = null
  let usageMetadata = null

  // 收集流式响应，chunk 类型为 AIMessageChunk
  for await (const chunk of streamResponse) {
    responseId = chunk.id || responseId
    responseMetadata = chunk.response_metadata || responseMetadata
    usageMetadata = chunk.usage_metadata || usageMetadata
    finishReason = chunk.response_metadata.finish_reason || finishReason
    additionalKwargs = chunk.additional_kwargs || additionalKwargs

    if(chunk.content) {
      collectedContent.push(chunk.content)
      fireDelta(chunk.content)
    }

    if (chunk.tool_call_chunks && chunk.tool_call_chunks.length > 0) {
      for (const tc of chunk.tool_call_chunks) {
        const idx = tc.index // 工具索引

        if (!collectedToolCalls.has(idx)) {
          collectedToolCalls.set(idx, {
            id: tc.id || '',
            // name 和 args 要置为空
            name: '' ,
            args: '',
            // type: tc.type ||'tool_call' || 'tool_call_chunk'
          })
        }
        const entry = collectedToolCalls.get(idx)
        if (tc.id) {
          entry.id = tc.id
        }
        if (tc.name) {
          entry.name += tc.name
        }
        if(tc.args) {
          entry.args += tc.args
        }
      }
    }
  }

  const content = collectedContent.join('') || null
  let tcs = null

  if (collectedToolCalls.size > 0) {
    const sortedEntries = Array.from(collectedToolCalls.entries()).sort((a, b) => a[0] - b[0])
    tcs = sortedEntries.map(([_, v]) => ({
      ...v,
      args: JSON.parse(v.args || '{}'),
    }))
  }

  // 构建一个模拟的AIMessage实例，匹配非流式响应
  return {
    content: content || '',
    tool_calls: tcs || [],
    id: responseId,
    additional_kwargs: additionalKwargs,
    response_metadata: {
      ...(responseMetadata || {}),
      finish_reason: finishReason || 'stop',
    },
    invalid_tool_calls: [],
    usage_metadata: usageMetadata,
    type: 'ai',
  }
}