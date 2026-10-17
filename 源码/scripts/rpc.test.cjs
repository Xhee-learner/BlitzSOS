"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createClient}=require("../js/rpc.js");
const cfg={rpcUrl:"https://example.invalid",chainIdHex:"0x279f",timeoutMs:80};
const response=(body,status=200)=>({ok:status<400,status,json:async()=>body});
test("RPC returns result and sends matching JSON-RPC body",async()=>{
 let body;const client=createClient({config:cfg,fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return response({jsonrpc:"2.0",id:body.id,result:"0x279f"});}});
 assert.equal(await client.request("eth_chainId",[]),"0x279f");assert.equal(body.method,"eth_chainId");
});
test("RPC retains error code and data",async()=>{
 const client=createClient({config:cfg,fetchImpl:async(u,o)=>response({jsonrpc:"2.0",id:JSON.parse(o.body).id,error:{code:-32000,message:"example rejection",data:"0xab"}})});
 await assert.rejects(client.request("eth_call",[]),e=>e.code===-32000&&e.data==="0xab");
});
test("HTTP error cannot become null/not-found",async()=>{
 const client=createClient({config:cfg,fetchImpl:async()=>response({},429)});
 await assert.rejects(client.request("eth_getTransactionReceipt",[]),e=>e.code==="HTTP_429");
});
test("Mismatched response ID is rejected",async()=>{
 const client=createClient({config:cfg,fetchImpl:async()=>response({jsonrpc:"2.0",id:-1,result:null})});
 await assert.rejects(client.request("eth_getTransactionReceipt",[]),e=>e.code==="INVALID_RESPONSE");
});
test("Malformed JSON is rejected",async()=>{
 const client=createClient({config:cfg,fetchImpl:async()=>({ok:true,json:async()=>{throw Error("bad JSON");}})});
 await assert.rejects(client.request("eth_chainId",[]),e=>e.code==="INVALID_RESPONSE");
});
test("Timeout rejects visibly",async()=>{
 const client=createClient({config:{...cfg,timeoutMs:15},fetchImpl:async(u,o)=>new Promise((resolve,reject)=>o.signal.addEventListener("abort",()=>reject(Error("aborted")),{once:true}))});
 await assert.rejects(client.request("eth_chainId",[]),e=>e.code==="TIMEOUT");
});
test("Node probe rejects wrong network",async()=>{
 const client=createClient({config:cfg,fetchImpl:async(u,o)=>response({jsonrpc:"2.0",id:JSON.parse(o.body).id,result:"0x27a3"})});
 await assert.rejects(client.probe(),e=>e.code==="CHAIN_MISMATCH");
});
