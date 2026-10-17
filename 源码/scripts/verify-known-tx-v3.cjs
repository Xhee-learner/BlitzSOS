"use strict";
const fs = require('node:fs'), path = require('node:path'), https = require('node:https'), assert = require('node:assert/strict');
const config = require('../config.js');
const preflight = require('../js/preflight.js');
const status = require('../js/txstatus.js');
const {createClient} = require('../js/rpc.js');
const HASH = '0x259c38e33e254e9eb65e64f49e72f9cd421deb01acf7eb108bbc5f9ad096c46b';
const FROM = '0xe4acb2f569cacddeaa3154053365ade104ae81ca';
function fetchIPv4(url, options) {
  return new Promise((resolve,reject) => {
    const u = new URL(url);
    const req = https.request({hostname:u.hostname,path:u.pathname+u.search,method:options.method,headers:options.headers,family:4}, res => {
      let body=''; res.on('data',chunk=>body+=chunk); res.on('end',()=>resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,json:async()=>JSON.parse(body)}));
    });
    req.on('error',reject); const abort=()=>req.destroy(new Error('Aborted'));
    options.signal?.addEventListener('abort',abort,{once:true}); req.on('close',()=>options.signal?.removeEventListener('abort',abort));
    if(options.signal?.aborted) abort(); req.end(options.body);
  });
}
(async()=>{
  const client = createClient({config,fetchImpl:fetchIPv4});
  const calls=[];
  async function request(method,params) { const result=await client.request(method,params); calls.push({method,params,result}); return result; }
  const result=await status.queryTransaction(HASH,{request,explorerBase:config.explorerBase});
  assert.equal(result.state,'success'); assert.equal(result.consistency,'consistent'); assert.equal(result.finality,'finalized');
  assert.equal(result.feeWei,'2142000000000000'); assert.equal(BigInt(result.tx.gas),21000n); assert.equal(BigInt(result.receipt.gasUsed),21000n);
  assert.equal(BigInt(result.tx.blockNumber),71755949n); assert.equal(BigInt(result.receipt.effectiveGasPrice),102000000000n);
  assert.equal(preflight.formatMON(BigInt(result.tx.value)),'0.001');
  const checks=[];
  for(const gas of ['21000','42000','20000']) {
    const r=await preflight.checkTransfer({from:FROM,to:FROM,amountMON:'0.001',candidateGasLimit:gas},{request});
    assert.equal(r.state,{'21000':'ok','42000':'high','20000':'too_low'}[gas]); checks.push(r);
  }
  const report={build:'v3.20261017.01',capturedAt:new Date().toISOString(),evidenceType:'READ-ONLY live RPC verification of an earlier owner-confirmed transaction. No new signing or broadcast.',result,preflightChecks:checks,rpcResponses:calls};
  const dest=path.join(__dirname,'../qa/真实交易只读复核_v3_20261017.json');
  fs.writeFileSync(dest,JSON.stringify(report,null,2),{flag:'wx',encoding:'utf8'});
  console.log(JSON.stringify({reportPath:dest,state:result.state,finality:result.finality,finalizedHeight:result.finalizedBlockNumber,feeMON:preflight.formatMON(result.feeWei),checks:checks.map(x=>({gas:x.candidateGasLimit,state:x.state}))},null,2));
})().catch(err=>{console.error(err.code||'ERROR',err.message);process.exitCode=1;});
