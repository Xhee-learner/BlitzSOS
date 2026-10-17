(function (root, factory) {
  "use strict";
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BlitzTx = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  function fail(code, message, cause) {
    var error = new Error(message);
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function validateHash(hash) {
    return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash);
  }

  function quantity(value) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
    try { return BigInt(value); } catch (_) { return null; }
  }

  function rpcError(error, method) {
    var wrapped = fail(
      error && error.code !== undefined ? error.code : "RPC_ERROR",
      "查询节点失败（" + method + "），请检查网络后重试。",
      error
    );
    wrapped.method = method;
    return wrapped;
  }

  function explorerLink(base, hash) {
    if (!base) return null;
    try {
      var url = new URL(String(base));
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/\/+$/, "") + "/tx/" + hash;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function checkRecord(record, field, hash) {
    if (record === null) return;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw fail("INVALID_RPC_RESPONSE", "节点返回的交易数据格式不正确，请更换节点后重试。");
    }
    if (record[field] !== undefined &&
        (typeof record[field] !== "string" || record[field].toLowerCase() !== hash.toLowerCase())) {
      throw fail("INVALID_RPC_RESPONSE", "节点返回的交易哈希与查询不一致，请重试或更换节点。");
    }
  }

  async function queryTransaction(input, options) {
    options = options || {};
    var hash = typeof input === "string" ? input.trim() : input;
    if (!validateHash(hash)) {
      throw fail("INVALID_HASH", "请输入以 0x 开头、后接 64 位十六进制字符的交易哈希。");
    }
    var request = options.request === undefined
      ? root.BlitzRPC && root.BlitzRPC.request
      : options.request;
    if (typeof request !== "function") {
      throw fail("RPC_UNAVAILABLE", "尚未配置可用的 RPC 查询方法。");
    }
    var explorerBase = options.explorerBase === undefined
      ? root.BlitzConfig && root.BlitzConfig.explorerBase
      : options.explorerBase;
    var expected = quantity(options.expectedChainId === undefined ? "0x279f" : options.expectedChainId);
    if (expected === null) throw fail("INVALID_CONFIG", "预期网络的 chainId 格式不正确。");

    async function call(method, params) {
      try { return await request(method, params); }
      catch (error) { throw rpcError(error, method); }
    }

    var actualChainId = quantity(await call("eth_chainId", []));
    if (actualChainId === null) {
      throw fail("INVALID_RPC_RESPONSE", "节点没有返回有效的 chainId，请更换节点后重试。");
    }
    if (actualChainId !== expected) {
      var networkError = fail("WRONG_CHAIN", "查询节点不属于指定的 Monad 网络，请先切换正确网络。");
      networkError.expectedChainId = "0x" + expected.toString(16);
      networkError.actualChainId = "0x" + actualChainId.toString(16);
      throw networkError;
    }

    var results = await Promise.allSettled([
      call("eth_getTransactionReceipt", [hash]),
      call("eth_getTransactionByHash", [hash])
    ]);
    var receiptResult = results[0], txResult = results[1];
    // A missing/failed receipt query never proves that a transaction is pending or failed.
    if (receiptResult.status === "rejected") throw receiptResult.reason;
    var receipt = receiptResult.value;
    checkRecord(receipt, "transactionHash", hash);
    if (txResult.status === "rejected" && receipt === null) throw txResult.reason;
    var tx = txResult.status === "fulfilled" ? txResult.value : null;
    checkRecord(tx, "hash", hash);
    if (tx && tx.chainId !== undefined && tx.chainId !== null) {
      var transactionChainId = quantity(tx.chainId);
      if (transactionChainId === null) {
        throw fail("INVALID_RPC_RESPONSE", "节点返回的交易 chainId 无效，请重试或更换节点。");
      }
      if (transactionChainId !== expected) {
        var transactionNetworkError = fail("WRONG_CHAIN", "节点返回的交易不属于指定的 Monad 网络，请核对钱包网络与交易哈希。");
        transactionNetworkError.expectedChainId = "0x" + expected.toString(16);
        transactionNetworkError.actualChainId = "0x" + transactionChainId.toString(16);
        throw transactionNetworkError;
      }
    }

    var result = {
      hash: hash,
      state: null,
      title: "",
      message: "",
      tx: tx,
      receipt: receipt,
      finality: "unknown",
      finalitySource: null,
      finalizedBlockNumber: null,
      consistency: "unknown",
      feeWei: null,
      feeBasis: "unknown",
      explorerUrl: explorerLink(explorerBase, hash),
      warnings: []
    };
    if (txResult.status === "rejected") {
      result.warnings.push("交易详情查询失败，已保留回执结果；费用暂未知。");
    }

    if (receipt === null) {
      if (tx === null) {
        result.state = "not_found";
        result.title = "暂未查到交易";
        result.message = "当前节点尚未返回交易或执行回执。Monad 不通过此接口返回待处理交易，因此不能判断失败；请核对网络和哈希，稍后重查，不要立即重复发送。";
      } else if (tx.blockNumber === null || tx.blockNumber === undefined) {
        result.state = "pending";
        result.title = "尚无入块和执行回执";
        result.message = "节点返回了交易记录，但尚无入块信息和执行回执。请稍后重查；仅凭此结果不能确认执行成功。";
      } else {
        if (quantity(tx.blockNumber) === null) {
          throw fail("INVALID_RPC_RESPONSE", "节点返回的交易区块编号无效，请重试。");
        }
        result.state = "receipt_pending";
        result.title = "已有入块记录，等待执行回执";
        result.message = "节点返回了交易所在区块，但暂未提供执行回执。入块不代表执行成功，请稍后重查。";
      }
      return result;
    }

    var status = quantity(receipt.status);
    if (status !== 0n && status !== 1n) {
      throw fail("INVALID_RPC_RESPONSE", "节点回执缺少有效执行状态，暂时无法判断成功或失败。");
    }
    result.state = status === 1n ? "success" : "failed";
    result.title = status === 1n ? "执行成功" : "执行失败";

    var receiptBlock = quantity(receipt.blockNumber);
    if (receiptBlock === null) {
      result.warnings.push("回执缺少有效区块编号，无法确认最终性。");
    } else {
      try {
        var finalized = await call("eth_getBlockByNumber", ["finalized", false]);
        var finalizedHeight = finalized && typeof finalized === "object" ? quantity(finalized.number) : null;
        if (finalizedHeight === null) {
          result.warnings.push("节点未提供有效的 finalized 区块，最终性未知。");
        } else {
          result.finality = receiptBlock <= finalizedHeight ? "finalized" : "unfinalized";
          result.finalitySource = "rpc_finalized_tag";
          result.finalizedBlockNumber = finalizedHeight.toString(10);
        }
      } catch (_) {
        result.warnings.push("最终确认高度查询失败，已保留执行结果；最终性未知。");
      }
    }

    var consistent = true;
    if (tx && tx.blockNumber != null && receiptBlock !== null) {
      var txBlock = quantity(tx.blockNumber);
      if (txBlock === null || txBlock !== receiptBlock) consistent = false;
    }
    if (tx && tx.blockHash && receipt.blockHash &&
        String(tx.blockHash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
      consistent = false;
    }
    result.consistency = !consistent ? "inconsistent" : tx ? "consistent" : "unknown";
    if (!consistent) {
      result.finality = "unknown";
      result.finalitySource = null;
      result.warnings.push("交易与回执区块信息暂不一致，请重新查询；最终性与费用暂未知。");
    }
    var gasLimit = tx ? quantity(tx.gas) : null;
    var paidPrice = quantity(receipt.effectiveGasPrice);
    if (consistent && gasLimit !== null && paidPrice !== null) {
      result.feeWei = (gasLimit * paidPrice).toString(10);
      result.feeBasis = "gas_limit";
    } else if (txResult.status === "fulfilled" && consistent) {
      result.warnings.push("缺少 gas limit 或实际有效 Gas 单价，费用暂未知；不会用 gasUsed 或最高报价代替。");
    }

    var finalityMessage = result.finality === "finalized"
      ? "所在区块已最终确认。"
      : result.finality === "unfinalized"
        ? "所在区块尚未最终确认，当前回执仍可能变化，请稍后重查。"
        : "最终性暂未知，请稍后重查。";
    result.message = result.state === "success"
      ? "当前回执显示执行成功。" + finalityMessage
      : "当前回执显示执行失败。" + finalityMessage + "仅凭回执不能确定具体失败原因，请查看交易详情或开发日志，确认原因后再决定是否重试。";
    if (!consistent) {
      result.title = "交易与回执区块信息暂不一致，请重新查询";
      result.message = "当前回执报告执行" + (result.state === "success" ? "成功" : "失败") + "，但交易与回执的区块信息冲突，暂不确认最终性或费用。请重新查询；不要据此重复发送。";
    }
    return result;
  }

  return Object.freeze({ validateHash: validateHash, queryTransaction: queryTransaction });
});
