import http from 'node:http'
import {writeFileSync,mkdirSync} from 'node:fs'
mkdirSync('test-results',{recursive:true})
let calls=0
const server=http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS')
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
  if(req.url==='/__health'){res.end(JSON.stringify({calls}));return}
  let body='';for await(const chunk of req)body+=chunk
  let data;try{data=JSON.parse(body)}catch{res.writeHead(400);res.end();return}
  calls++;writeFileSync('test-results/provider-last-request.json',JSON.stringify(data,null,2))
  if(req.url?.includes('messages')){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'})
    const event=value=>res.write('event: '+value.type+'\ndata: '+JSON.stringify(value)+'\n\n')
    event({type:'message_start',message:{id:'fixture-desktop-'+calls,type:'message',role:'assistant',model:data.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}})
    event({type:'content_block_start',index:0,content_block:{type:'text',text:''}})
    event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'桌面 DSH 已收到手机消息，远程连接工作正常。'}})
    event({type:'content_block_stop',index:0});event({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}});event({type:'message_stop'});res.end();return
  }
  if(!req.url?.includes('chat/completions')){res.writeHead(404);res.end(JSON.stringify({error:{message:'Fixture expects chat/completions'}}));return}
  const all=JSON.stringify(data.messages)
  const hasTool=data.messages?.some(x=>x.role==='tool')
  const wantsTool=all.includes('TOOL_TEST')&&!hasTool
  const tool=data.tools?.find(x=>x.function?.name==='write')
  const content=hasTool?'工具已创建 mobile-proof.txt。本机 Harness 工作正常。':'你好，手机上的真实 DSH 内核已完成这次测试。'
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'})
  const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'fixture-'+calls,object:'chat.completion.chunk',model:data.model,choices:[{index:0,delta,finish_reason}]})+'\n\n')
  send({role:'assistant'})
  if(wantsTool && tool){send({tool_calls:[{index:0,id:'fixture-write',type:'function',function:{name:'write',arguments:JSON.stringify({file_path:'/dsh/workspace/mobile-proof.txt',content:'DSH worker tool executed successfully.\n'})}}]});send({},'tool_calls')}
  else{for(const part of content.match(/.{1,8}/gu) || [])send({content:part});send({},'stop')}
  res.end('data: [DONE]\n\n')
})
server.listen(5191,'127.0.0.1',()=>console.log('FIXTURE_PROVIDER http://127.0.0.1:5191 (no real API calls)'))
