/**
 * Diagnostic only: actual retained list facets, lossless roster regrouping and schema costs.
 * From apps/hub: node --import tsx ../../scripts/benchmark-mcp-list-candidates.mjs
 *   <db> <isolated-deps-dir> <captured-list-agents-sample-json>
 * Captured JSON shape: [{name:'list_agents',result:<MCP response>}]. Kept private.
 * Dependency versions and limitations are in docs/mcp-toon-evaluation-2026-09-09.md.
 * Does not invoke a live tool, change the journal, or print response content.
 */
import {createRequire} from 'node:module'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import fs from 'node:fs'
import {isDeepStrictEqual} from 'node:util'
import {runAgentTool,AGENT_TOOLS,AGENT_TOOLS_INSTRUCTIONS} from '../apps/hub/src/agentToolCore.ts'
import {inputSchemaFor} from '../apps/hub/src/agentMcpServer.ts'
const [dbPath,depsDir,samplesPath]=process.argv.slice(2)
if(!dbPath||!depsDir||!samplesPath)throw new Error('Expected database, isolated dependency directory, captured list_agents sample JSON')
const researchRequire=createRequire(path.join(path.resolve(depsDir),'package.json'))
const {encode,decode}=await import(pathToFileURL(researchRequire.resolve('@toon-format/toon')).href)
const {getEncoding}=researchRequire('js-tiktoken')
const require=createRequire(new URL('../apps/hub/package.json',import.meta.url))
const Database=require('better-sqlite3')
const db=new Database(dbPath,{readonly:true,fileMustExist:true,timeout:1000})
let rows
try{db.pragma('query_only=ON');rows=db.prepare(`SELECT e.kind,e.payload FROM journal_session_event_index i JOIN events e ON i.seq=e.seq WHERE i.session=? AND i.seq<=10871328 ORDER BY i.seq DESC LIMIT 20000`).all('ee63e095-2400-4081-bf43-49a6a251fe46')}finally{db.close()}
const encs=Object.fromEntries(['o200k_base','cl100k_base'].map(n=>[n,getEncoding(n)]))
const totals={},unique={}
let checks=0
function measure(group,value,original){
 const json=JSON.stringify(value),toon=encode(value)
 if(!isDeepStrictEqual(value,decode(toon)))throw new Error('Codec roundtrip failed in '+group)
 checks++
 const stat=totals[group]??={count:0,rows:0,tokens:Object.fromEntries(Object.keys(encs).map(n=>[n,{original:0,json:0,toon:0,toonLabeled:0}]))}
 stat.count++;if(Array.isArray(value))stat.rows+=value.length
 ;(unique[group]??=new Set()).add(json)
 for(const[n,e]of Object.entries(encs))for(const[k,s]of Object.entries({original:original??json,json,toon,toonLabeled:'TOON v4.1\n'+toon}))stat.tokens[n][k]+=e.encode(s,[],[]).length
}
const queries=[]
for(const r of rows){
 if(r.kind!=='codex/item/completed')continue
 const item=JSON.parse(r.payload).item
 if(item?.type!=='mcpToolCall'||item.tool!=='query_team')continue
 const text=item.result?.content?.find(x=>x.type==='text')?.text
 if(typeof text!=='string'||Buffer.byteLength(text)>524288)continue
 let value;try{value=JSON.parse(text)}catch{continue}
 queries.push({value,text})
 for(const[k,v]of Object.entries(value))if(Array.isArray(v)&&v.length)measure('query_facet/'+k,v)
 measure('query/'+(value.runs?.length?'with_runs':'without_runs'),value,text)
 if(value.runs?.length){
  const compact=await runAgentTool('inspect_runs',{}, {identity:{sessionId:'benchmark',profileId:'codex-a',provider:'codex',label:'benchmark'},services:{inspectRuns:()=>({ok:true,runs:value.runs})}})
  const summary=JSON.parse(compact).runs
  measure('query/candidate_summary_runs',{...value,runs:summary})
 }
}
const samples=JSON.parse(fs.readFileSync(samplesPath,'utf8'))
const rosterText=samples.find(x=>x.name==='list_agents').result.content.find(c=>c.type==='text').text
const roster=rosterText.split('\n').map(line=>{
 const m=line.match(/^- (.*?) — session ([\w-]+) \(([^,]+), ([^,]+), (project [^,]+|no project|Application Overseer)(?:, (.*))?\)$/u)
 if(!m)throw new Error('Unsupported roster line; do not guess a conversion')
 return {label:m[1],sessionId:m[2],provider:m[3],status:m[4],scope:m[5],role:m[6]??''}
})
const rerender=roster.map(a=>`- ${a.label} — session ${a.sessionId} (${a.provider}, ${a.status}, ${a.scope}${a.role?', '+a.role:''})`).join('\n')
if(rerender!==rosterText)throw new Error('Roster conversion did not preserve exact text')
measure('live_roster/flat',roster,rosterText)
const grouped=[]
for(const a of roster){let g=grouped.find(g=>g.scope===a.scope);if(!g){g={scope:a.scope,agents:[]};grouped.push(g)}const{scope,...rest}=a;g.agents.push(rest)}
measure('live_roster/grouped',grouped,rosterText)
const groupedProse=grouped.map(g=>g.scope+'\n'+g.agents.map(a=>`- ${a.label} — session ${a.sessionId} (${a.provider}, ${a.status}${a.role?', '+a.role:''})`).join('\n')).join('\n\n')
const catalog=AGENT_TOOLS.map(t=>({name:t.name,description:t.description,inputSchema:inputSchemaFor(t)}))
const schemaCosts=catalog.map(t=>({name:t.name,tokens:encs.o200k_base.encode(JSON.stringify(t),[],[]).length,descriptionTokens:encs.o200k_base.encode(t.description,[],[]).length})).sort((a,b)=>b.tokens-a.tokens)
console.log(JSON.stringify({queryCount:queries.length,checks,totals,uniqueCounts:Object.fromEntries(Object.entries(unique).map(([k,v])=>[k,v.size])),rosterGroupedProseTokens:Object.fromEntries(Object.entries(encs).map(([n,e])=>[n,e.encode(groupedProse,[],[]).length])),schemaCosts,
 repeatedHeaderProxy:Object.fromEntries(Object.entries(encs).map(([n,e])=>[n,e.encode(AGENT_TOOLS_INSTRUCTIONS,[],[]).length*catalog.length])),
},null,2))
