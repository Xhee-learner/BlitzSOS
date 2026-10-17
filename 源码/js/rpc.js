(function (root) {
  "use strict";
  function error(message, code, details) {
    const err = new Error(message); err.code = code; if (details !== undefined) err.data = details; return err;
  }
  function createClient(options = {}) {
    const config = options.config || root.BlitzConfig || {};
    const url = options.url || config.rpcUrl;
    const timeoutMs = options.timeoutMs || config.timeoutMs || 12000;
    const fetchImpl = options.fetchImpl || root.fetch?.bind(root);
    if (!url || !fetchImpl) throw error("当前环境缺少 RPC 配置或 fetch 支持。", "ENVIRONMENT");
    let nextId = 1;
    async function request(method, params = [], requestOptions = {}) {
      const id = nextId++;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const abort = () => controller.abort();
      if (requestOptions.signal?.aborted) abort();
      requestOptions.signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetchImpl(url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer"
        });
        if (!response.ok) throw error("RPC HTTP " + response.status + "，本次查询未完成。", "HTTP_" + response.status);
        let payload;
        try { payload = await response.json(); }
        catch (_) { throw error("RPC 返回了无法解析的 JSON。", "INVALID_RESPONSE"); }
        if (!payload || payload.jsonrpc !== "2.0" || payload.id !== id) {
          throw error("RPC 响应标识无效，本次查询未完成。", "INVALID_RESPONSE");
        }
        if (payload.error) {
          throw error(payload.error.message || "RPC 调用失败", payload.error.code ?? "RPC_ERROR", payload.error.data);
        }
        if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
          throw error("RPC 响应缺少 result。", "INVALID_RESPONSE");
        }
        return payload.result;
      } catch (err) {
        if (timedOut) throw error("RPC 请求超时，请稍后重试。", "TIMEOUT");
        if (controller.signal.aborted) throw error("本次查询已取消。", "ABORTED");
        if (err.code) throw err;
        throw error("网络请求未完成：" + (err.message || String(err)), "NETWORK");
      } finally {
        clearTimeout(timer); requestOptions.signal?.removeEventListener("abort", abort);
      }
    }
    async function probe() {
      const start = Date.now();
      const chainId = await request("eth_chainId", []);
      if (BigInt(chainId) !== BigInt(config.chainIdHex || "0x279f")) {
        throw error("节点返回的网络不是 Monad Testnet，请检查 RPC 配置。", "CHAIN_MISMATCH");
      }
      const block = await request("eth_blockNumber", []);
      return { chainId, blockNumber: BigInt(block).toString(), latencyMs: Date.now() - start };
    }
    return Object.freeze({ request, probe, url });
  }
  const api = { createClient };
  if (root.BlitzConfig && root.fetch) Object.assign(api, createClient());
  root.BlitzRPC = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
