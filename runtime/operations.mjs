/** Shared service adapter. Both hosts execute the real DSH SessionController. */
function userError(message) { const error = new Error(message); error.expose = true; return error }
export async function dispatchOperation(context, fs, operation, input, onFrame, signal) {
  const controller = context.get('sessionController')
  if (!controller) throw userError('DSH SessionController 尚未就绪')
  switch (operation) {
    case 'list': return controller.list({}, signal)
    case 'create': return controller.create({ cwd: fs.root, agentPreset: 'standard' }, signal)
    case 'history': {
      const abort = new AbortController()
      const iterator = controller.follow({ address: { kind: 'session', sessionId: input.id }, maxMessages: 200 }, abort.signal)[Symbol.asyncIterator]()
      try { return (await iterator.next()).value }
      finally { abort.abort(); await iterator.return?.() }
    }
    case 'catalog': {
      // 官方模型目录（名称/描述/推理等级），供手机端选择器使用。
      const llm = context.get('llm')
      if (!llm) throw new Error('LLM 服务尚未就绪')
      const groups = []
      for (const provider of llm.listProviders()) {
        try {
          const models = await llm.listModels(provider.id)
          const entries = []
          for (const model of models) {
            const resolved = await llm.resolveModelInfo(provider.id, model.id)
            const efforts = resolved?.reasoning?.efforts
            entries.push({
              id: model.id,
              name: model.name || model.id,
              ...(model.description === undefined ? {} : { description: model.description }),
              ...(efforts === undefined ? {} : { reasoning: {
                efforts: efforts.map(effort => ({ id: effort.id, name: effort.name, ...(effort.description === undefined ? {} : { description: effort.description }) })),
                ...(resolved.reasoning.defaultEffort === undefined ? {} : { defaultEffort: resolved.reasoning.defaultEffort })
              } })
            })
          }
          groups.push({ id: provider.id, name: provider.name || provider.id, models: entries })
        } catch (error) {
          groups.push({ id: provider.id, name: provider.name || provider.id, models: [], error: error?.message || String(error) })
        }
      }
      return { groups }
    }
    case 'send': {
      if(input.model) await controller.selectModel({sessionId:input.id, provider:'deepseek-official',model:input.model, ...(input.reasoningEffort ? {reasoningEffort:input.reasoningEffort} : {})}, signal)
      const abort = new AbortController()
      const cancel = () => abort.abort(signal.reason)
      signal.addEventListener('abort', cancel, {once:true})
      if(signal.aborted) cancel()
      const iterator = controller.follow({address:{kind:'session',sessionId:input.id},maxMessages:1,assistantStream:true},abort.signal)[Symbol.asyncIterator]()
      try {
        await iterator.next()
        const content=[{type:'text',text:input.text}, ...(Array.isArray(input.images)?input.images.filter(image=>image&&image.mediaType&&image.data).map(image=>({type:'image',mediaType:image.mediaType,data:image.data,...(image.name?{name:image.name}:{})})):[])]
        await controller.prompt({sessionId:input.id,requestId:input.requestId,mode:'queue',content,clientTimeZone:input.timeZone || 'UTC'}, abort.signal)
        while(!abort.signal.aborted) {
          const next = await iterator.next(); if(next.done) break
          onFrame(next.value)
          if(next.value.type === 'event' && next.value.event?.type === 'turn/end') break
        }
        if(signal.aborted) throw userError('已停止生成')
        return {completed:true}
      } finally {abort.abort(); signal.removeEventListener('abort',cancel); await iterator.return?.()}
    }
    case 'cancel': return controller.cancel({sessionId:input.id})
    case 'files': return fs.list()
    case 'write': return fs.write(input.name, input.text)
    case 'flush': return fs.flush()
    default: throw userError('未知操作：' + operation)
  }
}
