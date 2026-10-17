"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { queryTransaction, validateHash } = require("../js/txstatus.js");
const HASH = "0x" + "a".repeat(64);
const DEFAULT_RECEIPT = { transactionHash: HASH, status: "0x1", blockNumber: "0xa", blockHash: "0xabc", gasUsed: "0x5208", effectiveGasPrice: "0x2" };
const DEFAULT_TX = { hash: HASH, gas: "0xa410", blockNumber: "0xa", blockHash: "0xabc", maxFeePerGas: "0xffff" };

function rpc(overrides = {}) {
  const calls = [];
  const data = {
    eth_chainId: "0x279f",
    eth_getTransactionReceipt: DEFAULT_RECEIPT,
    eth_getTransactionByHash: DEFAULT_TX,
    eth_getBlockByNumber: { number: "0xa" },
    ...overrides
  };
  const request = async (method, params) => {
    calls.push({ method, params });
    const value = data[method];
    if (value instanceof Error) throw value;
    if (typeof value === "function") return value(params);
    if (value === undefined) throw new Error("Unexpected method " + method);
    return value;
  };
  return { request, calls };
}
function query(mock, extra = {}) {
  return queryTransaction(HASH, { request: mock.request, explorerBase: "https://testnet.monadexplorer.com/", ...extra });
}

test("validates hashes and rejects malformed inputs without calling RPC", async () => {
  assert.equal(validateHash(HASH), true);
  assert.equal(validateHash("0x" + "F".repeat(64)), true);
  for (const value of ["", HASH + "x", "0x123", HASH + " ", null, {}]) {
    assert.equal(validateHash(value), false);
  }
  let calls = 0;
  await assert.rejects(queryTransaction("bad", { request: async () => { calls++; } }), { code: "INVALID_HASH" });
  assert.equal(calls, 0);
});

test("requires the expected chain before requesting transaction data", async () => {
  const mock = rpc({ eth_chainId: "0x1" });
  await assert.rejects(query(mock), error => {
    assert.equal(error.code, "WRONG_CHAIN");
    assert.equal(error.actualChainId, "0x1");
    return true;
  });
  assert.deepEqual(mock.calls.map(call => call.method), ["eth_chainId"]);
});

test("fetches transaction and receipt concurrently", { timeout: 1500 }, async () => {
  let receiptResolve, txResolve;
  function release() {
    if (receiptResolve && txResolve) {
      receiptResolve(null);
      txResolve(null);
    }
  }
  const mock = rpc({
    eth_getTransactionReceipt: () => new Promise(resolve => { receiptResolve = resolve; release(); }),
    eth_getTransactionByHash: () => new Promise(resolve => { txResolve = resolve; release(); })
  });
  assert.equal((await query(mock)).state, "not_found");
});

test("success uses gas LIMIT multiplied by effective price, not used gas or maximum price", async () => {
  const mock = rpc();
  const result = await query(mock);
  assert.equal(result.state, "success");
  assert.equal(result.finality, "finalized");
  assert.equal(result.finalitySource, "rpc_finalized_tag");
  assert.equal(result.finalizedBlockNumber, "10");
  assert.equal(result.consistency, "consistent");
  assert.equal(result.feeWei, "84000");
  assert.equal(result.feeBasis, "gas_limit");
  assert.equal(result.explorerUrl, "https://testnet.monadexplorer.com/tx/" + HASH);
  assert.deepEqual(mock.calls.at(-1), { method: "eth_getBlockByNumber", params: ["finalized", false] });
});

test("failed execution is separate from finality and does not guess a revert cause", async () => {
  const result = await query(rpc({
    eth_getTransactionReceipt: { ...DEFAULT_RECEIPT, status: "0x0" },
    eth_getBlockByNumber: { number: "0x9" }
  }));
  assert.equal(result.state, "failed");
  assert.equal(result.finality, "unfinalized");
  assert.equal(result.feeWei, "84000");
  assert.match(result.message, /不能确定具体失败原因/);
  assert.doesNotMatch(result.message, /余额不足|储备不足|Gas 不足/);
});

test("two null responses mean not_found, never failed or conclusively pending", async () => {
  const mock = rpc({ eth_getTransactionReceipt: null, eth_getTransactionByHash: null });
  const result = await query(mock);
  assert.equal(result.state, "not_found");
  assert.equal(result.finality, "unknown");
  assert.equal(result.feeWei, null);
  assert.match(result.message, /不能判断失败/);
  assert.equal(mock.calls.length, 3);
});

test("returned transaction without a block is distinct from an included transaction awaiting receipt", async () => {
  const pending = await query(rpc({
    eth_getTransactionReceipt: null,
    eth_getTransactionByHash: { ...DEFAULT_TX, blockNumber: null, blockHash: null }
  }));
  const included = await query(rpc({ eth_getTransactionReceipt: null }));
  assert.equal(pending.state, "pending");
  assert.equal(included.state, "receipt_pending");
  assert.equal(included.feeWei, null);
  assert.match(included.message, /入块不代表执行成功/);
});

test("receipt RPC failure propagates its code instead of becoming not_found", async () => {
  const err = new Error("rate limited");
  err.code = 429;
  await assert.rejects(query(rpc({ eth_getTransactionReceipt: err, eth_getTransactionByHash: null })), error => {
    assert.equal(error.code, 429);
    assert.equal(error.method, "eth_getTransactionReceipt");
    return true;
  });
});

test("transaction RPC failure without a receipt propagates instead of becoming not_found", async () => {
  await assert.rejects(query(rpc({
    eth_getTransactionReceipt: null,
    eth_getTransactionByHash: new Error("offline")
  })), { code: "RPC_ERROR" });
});

test("a reliable receipt survives transaction-details failure with unknown fee and a warning", async () => {
  const result = await query(rpc({ eth_getTransactionByHash: new Error("offline") }));
  assert.equal(result.state, "success");
  assert.equal(result.receipt, DEFAULT_RECEIPT);
  assert.equal(result.tx, null);
  assert.equal(result.feeWei, null);
  assert.equal(result.feeBasis, "unknown");
  assert.match(result.warnings.join(" "), /详情查询失败/);
});

test("unsupported or empty finalized response preserves execution with unknown finality", async () => {
  for (const value of [null, {}, 0, false, "0xa", new Error("unsupported")]) {
    const result = await query(rpc({ eth_getBlockByNumber: value }));
    assert.equal(result.state, "success");
    assert.equal(result.finality, "unknown");
    assert.equal(result.finalitySource, null);
    assert.equal(result.finalizedBlockNumber, null);
    assert.equal(result.feeWei, "84000");
    assert.ok(result.warnings.length);
  }
});

test("missing effective price or tx gas never falls back to gasUsed, gasPrice or maxFeePerGas", async () => {
  const missingPrice = { ...DEFAULT_RECEIPT };
  delete missingPrice.effectiveGasPrice;
  const missingGas = { ...DEFAULT_TX, gasPrice: "0x2" };
  delete missingGas.gas;
  for (const mock of [
    rpc({ eth_getTransactionReceipt: missingPrice }),
    rpc({ eth_getTransactionByHash: missingGas }),
    rpc({ eth_getTransactionByHash: null })
  ]) {
    const result = await query(mock);
    assert.equal(result.feeWei, null);
    assert.equal(result.feeBasis, "unknown");
  }
});

test("conflicting block numbers never claim finality even when finalized height exceeds both records", async () => {
  const result = await query(rpc({
    eth_getTransactionByHash: { ...DEFAULT_TX, blockNumber: "0xb", blockHash: "0xdef" },
    eth_getBlockByNumber: { number: "0x20" }
  }));
  assert.equal(result.state, "success");
  assert.equal(result.receipt.status, "0x1");
  assert.equal(result.consistency, "inconsistent");
  assert.equal(result.finality, "unknown");
  assert.equal(result.finalitySource, null);
  assert.equal(result.finalizedBlockNumber, "32");
  assert.equal(result.feeWei, null);
  assert.equal(result.feeBasis, "unknown");
  assert.equal(result.title, "交易与回执区块信息暂不一致，请重新查询");
  assert.match(result.warnings.join(" "), /区块信息暂不一致/);
  assert.doesNotMatch(result.message, /已最终确认/);
});

test("same-height different block hashes suppress finality and derived fee for a failed receipt", async () => {
  const result = await query(rpc({
    eth_getTransactionReceipt: { ...DEFAULT_RECEIPT, status: "0x0" },
    eth_getTransactionByHash: { ...DEFAULT_TX, blockHash: "0xdef" },
    eth_getBlockByNumber: { number: "0x20" }
  }));
  assert.equal(result.state, "failed");
  assert.equal(result.receipt.status, "0x0");
  assert.equal(result.consistency, "inconsistent");
  assert.equal(result.finality, "unknown");
  assert.equal(result.finalitySource, null);
  assert.equal(result.feeWei, null);
  assert.equal(result.feeBasis, "unknown");
  assert.match(result.message, /暂不确认最终性或费用/);
});

test("an explicitly foreign transaction chain is rejected even if the RPC reports Monad", async () => {
  for (const receipt of [DEFAULT_RECEIPT, null]) {
    const mock = rpc({
      eth_getTransactionReceipt: receipt,
      eth_getTransactionByHash: { ...DEFAULT_TX, chainId: "0x1" }
    });
    await assert.rejects(query(mock), error => {
      assert.equal(error.code, "WRONG_CHAIN");
      assert.equal(error.expectedChainId, "0x279f");
      assert.equal(error.actualChainId, "0x1");
      return true;
    });
    assert.equal(mock.calls.some(call => call.method === "eth_getBlockByNumber"), false);
  }
});

test("transaction chainId is optional for older RPCs but validated when present", async () => {
  assert.equal((await query(rpc())).state, "success");
  assert.equal((await query(rpc({ eth_getTransactionByHash: { ...DEFAULT_TX, chainId: "0x279f" } }))).state, "success");
  await assert.rejects(query(rpc({ eth_getTransactionByHash: { ...DEFAULT_TX, chainId: "invalid" } })), { code: "INVALID_RPC_RESPONSE" });
});

test("invalid receipt status or a different returned hash is an error rather than a guessed result", async () => {
  for (const overrides of [
    { eth_getTransactionReceipt: { ...DEFAULT_RECEIPT, status: "0x2" } },
    { eth_getTransactionReceipt: { ...DEFAULT_RECEIPT, transactionHash: "0x" + "b".repeat(64) } },
    { eth_getTransactionByHash: { ...DEFAULT_TX, hash: "0x" + "b".repeat(64) } }
  ]) {
    await assert.rejects(query(rpc(overrides)), { code: "INVALID_RPC_RESPONSE" });
  }
});

test("unsafe explorer URLs are not returned and surrounding pasted whitespace is trimmed", async () => {
  const result = await queryTransaction(" \n" + HASH + "\n", {
    request: rpc().request, explorerBase: "javascript:alert(1)"
  });
  assert.equal(result.hash, HASH);
  assert.equal(result.explorerUrl, null);
});

test("browser global and Node export expose the same two API functions", async () => {
  const vm = require("node:vm");
  const fs = require("node:fs");
  const path = require("node:path");
  const context = { URL, BlitzRPC: { request: rpc().request }, BlitzConfig: { explorerBase: "https://testnet.monadexplorer.com" } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/txstatus.js"), "utf8"), context);
  assert.equal(typeof context.BlitzTx.queryTransaction, "function");
  assert.equal(typeof context.BlitzTx.validateHash, "function");
  const result = await context.BlitzTx.queryTransaction(HASH);
  assert.equal(result.state, "success");
  assert.equal(result.explorerUrl, "https://testnet.monadexplorer.com/tx/" + HASH);
});
