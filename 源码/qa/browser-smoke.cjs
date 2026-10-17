"use strict";
/*
 * MOCK-ONLY browser integration smoke test.
 * Every remote request is intercepted. Injected wallet records eth_sendTransaction
 * arguments locally; it never signs, broadcasts or calls a real wallet.
 * All browser profiles, screenshots and reports stay under this qa folder.
 */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const EXE = "C:/Users/admin/.cache/hyperframes/chrome/chrome-headless-shell/win64-152.0.7977.30/chrome-headless-shell-win64/chrome-headless-shell.exe";
const BASE = process.argv[2] || "http://127.0.0.1:4174";
if (!/^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/?$/.test(BASE)) throw new Error("Smoke test only accepts an explicit localhost HTTP origin.");
const QA = __dirname;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-") + "-" + process.pid;
const RUN = path.join(QA, "mock-browser-" + STAMP);
fs.mkdirSync(RUN, { recursive: false });
const FROM = "0x" + "1".repeat(40), TO = "0x" + "2".repeat(40), OTHER = "0x" + "3".repeat(40);
const HASH = letter => "0x" + letter.repeat(64);
const SUCCESS = HASH("a"), FAILED = HASH("b"), MISSING = HASH("c"), RPC_ERROR = HASH("d"), SENT = HASH("e");
const records = [], pageErrors = [], blockedRemote = [], rpcCalls = [];
const state = { offline: false, delayHash: null, delayMS: 0, estimateGate: null, finalizedMode: "normal", inconsistentHash: null, unknownSent: false };
let context;
const reportPath = path.join(RUN, "MOCK-browser-test-records.json");

async function ready() {
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(BASE)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error("Local server not ready: " + BASE);
}
function tx(hash) {
  return { hash, from: FROM, to: TO, gas: "0x5208", blockNumber: "0x64", blockHash: HASH("9"), value: "0x38d7ea4c68000" };
}
function receipt(hash) {
  return { transactionHash: hash, from: FROM, to: TO, status: hash === FAILED ? "0x0" : "0x1",
    blockNumber: "0x64", blockHash: HASH("9"), gasUsed: "0x5208", effectiveGasPrice: "0x174876e800" };
}
async function check(name, body) {
  const started = Date.now();
  try { await body(); records.push({ name, passed: true, durationMs: Date.now() - started, evidenceType: "MOCK integration" }); console.log("PASS " + name); }
  catch (error) { records.push({ name, passed: false, durationMs: Date.now() - started, error: error.stack, evidenceType: "MOCK integration" }); console.log("FAIL " + name + ": " + error.message); }
}

(async () => {
  try {
    await ready();
    context = await chromium.launchPersistentContext(path.join(RUN, "browser-profile"), {
      executablePath: EXE, headless: true, viewport: { width: 1440, height: 1050 },
      downloadsPath: path.join(RUN, "downloads"),
      env: { ...process.env, TEMP: RUN, TMP: RUN },
      args: ["--disable-crash-reporter", "--no-sandbox"]
    });
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(6500);
    page.on("pageerror", error => pageErrors.push(error.message));
    await context.addInitScript(({ from, sent }) => {
      const handlers = {};
      const mock = { account: from, chainId: "0x279f", cancelNext: false, holdSend: false, sendPending: false, releaseSend: null, sendCalls: [], calls: [] };
      const provider = {
        isMetaMask: true,
        on(event, cb) { (handlers[event] ||= []).push(cb); },
        async request({ method, params }) {
          mock.calls.push({ method, params: params || [] });
          if (method === "eth_requestAccounts" || method === "eth_accounts") return mock.account ? [mock.account] : [];
          if (method === "eth_chainId") return mock.chainId;
          if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
            mock.chainId = params[0].chainId;
            for (const fn of handlers.chainChanged || []) fn(mock.chainId);
            return null;
          }
          if (method === "eth_sendTransaction") {
            mock.sendCalls.push({ transaction: params[0], mockOnly: true, cancelled: mock.cancelNext });
            if (mock.cancelNext) { mock.cancelNext = false; const error = new Error("MOCK user rejected"); error.code = 4001; throw error; }
            if (mock.holdSend) { mock.sendPending = true; await new Promise(resolve => { mock.releaseSend = resolve; }); mock.sendPending = false; mock.holdSend = false; mock.releaseSend = null; }
            return sent;
          }
          throw new Error("Unexpected MOCK wallet method " + method);
        }
      };
      mock.emitChain = value => { mock.chainId = value; for (const fn of handlers.chainChanged || []) fn(value); };
      mock.emitAccount = value => { mock.account = value; for (const fn of handlers.accountsChanged || []) fn(value ? [value] : []); };
      window.__MOCK_WALLET__ = mock;
      Object.defineProperty(window, "ethereum", { value: provider, configurable: false });
    }, { from: FROM, sent: SENT });
    await context.route("**/*", async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();
      if (url.hostname !== "testnet-rpc.monad.xyz") {
        blockedRemote.push(req.url()); return route.abort("blockedbyclient");
      }
      if (state.offline) return route.abort("internetdisconnected");
      const body = req.postDataJSON();
      rpcCalls.push({ method: body.method, params: body.params });
      if (state.delayHash && body.params?.[0] === state.delayHash) await new Promise(resolve => setTimeout(resolve, state.delayMS));
      if (body.method === "eth_estimateGas" && state.estimateGate) {
        const gate = state.estimateGate; state.estimateGate = null; gate.markEntered(); await gate.promise;
      }
      let result;
      switch (body.method) {
        case "eth_chainId": result = "0x279f"; break;
        case "eth_blockNumber": result = "0x66"; break;
        case "eth_getBalance": result = "0x8ac7230489e80000"; break;
        case "eth_getCode": result = "0x"; break;
        case "eth_gasPrice": result = "0x174876e800"; break;
        case "eth_estimateGas": result = "0x5208"; break;
        case "eth_getBlockByNumber":
          if (state.finalizedMode === "error") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "MOCK finalized unsupported" } }) });
          result = state.finalizedMode === "null" ? null : { number: "0x65", hash: HASH("8") }; break;
        case "eth_getTransactionByHash":
        case "eth_getTransactionReceipt": {
          const hash = body.params[0];
          if (hash === RPC_ERROR) {
            return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32005, message: "MOCK rate limit" } }) });
          }
          result = hash === MISSING || (hash === SENT && state.unknownSent) ? null : body.method === "eth_getTransactionReceipt" ? receipt(hash) : tx(hash);
          if (result && hash === state.inconsistentHash && body.method === "eth_getTransactionByHash") result = { ...result, blockNumber: "0x63", blockHash: HASH("7") };
          break;
        }
        default: throw new Error("Unexpected MOCK RPC method " + body.method);
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    });
    await page.goto(BASE, { waitUntil: "networkidle" });
    const text = sel => page.locator(sel).innerText();
    async function waitText(sel, expected) {
      await page.waitForFunction(({ sel, expected }) => document.querySelector(sel)?.textContent.includes(expected), { sel, expected });
    }
    async function fillTransfer(gas) {
      await page.locator("#fromAddress").fill(FROM);
      await page.locator("#toAddress").fill(TO);
      await page.locator("#amountMON").fill("0.001");
      await page.locator("#gasLimit").fill(gas);
    }
    async function preflight(gas = "21000") {
      await fillTransfer(gas); await page.locator("#checkTransfer").click();
      await waitText("#preflightResult", gas === "21000" ? "无需下调" : "高于普通转账");
    }
    async function query(hash) {
      await page.locator("#txHash").fill(hash); await page.locator("#queryTransaction").click();
      await page.waitForFunction(() => !document.getElementById("queryTransaction").disabled);
    }

    function estimateGate() {
      let release, markEntered;
      const promise = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { markEntered = resolve; });
      const gate = { promise, entered, release, markEntered };
      state.estimateGate = gate; return gate;
    }
    async function awaitEntered(gate) {
      let timeout;
      try { await Promise.race([gate.entered, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("MOCK estimate gate was not reached")), 6500); })]); }
      finally { clearTimeout(timeout); }
    }
    async function walletReady() {
      await page.evaluate(({ from }) => { const wallet = window.__MOCK_WALLET__; wallet.cancelNext = false; wallet.emitAccount(from); wallet.emitChain("0x279f"); }, { from: FROM });
      await preflight();
      assert.equal(await page.locator("#sendTransfer").isEnabled(), true);
    }
    async function sentCount() { return page.evaluate(() => window.__MOCK_WALLET__.sendCalls.length); }
    async function idleSend() { await page.waitForFunction(() => !document.getElementById("fromAddress").disabled); }

    await check("initial local UI renders with MOCK network data", async () => {
      await waitText("#networkStatus", "已连接");
      assert.match(await page.title(), /BlitzSOS/);
      assert.equal(await page.locator("h1").count(), 1);
    });
    await check("overconfigured gas 42000 -> suggest 21000 -> apply and recheck ok", async () => {
      await fillTransfer("21000"); await page.locator("#demoGas").click(); await page.locator("#checkTransfer").click();
      await waitText("#preflightResult", "高于普通转账");
      assert.equal(await page.locator("#gasLimit").inputValue(), "42000");
      assert.match(await text("#preflightResult"), /0\.0021/);
      assert.equal(await page.locator("#adoptGas").isVisible(), true);
      assert.equal(await page.locator("#demoNotice").isVisible(), true);
      await page.screenshot({ path: path.join(RUN, "MOCK-high-gas.png"), fullPage: true });
      await page.locator("#adoptGas").click(); await waitText("#preflightResult", "无需下调");
      assert.equal(await page.locator("#gasLimit").inputValue(), "21000");
      assert.equal(await page.locator("#adoptGas").isVisible(), false);
    });
    await check("reasonable 21000 is retained without forced gas change", async () => {
      await preflight("21000");
      assert.equal(await page.locator("#gasLimit").inputValue(), "21000");
      assert.equal(await page.locator("#adoptGas").isVisible(), false);
    });
    await check("MOCK scope notice is visible beside the precise gas-only conclusion", async () => {
      await preflight();
      const notice = page.locator("#preflightResult .scope-notice");
      assert.equal(await notice.isVisible(), true);
      assert.match(await notice.innerText(), /未完整校验 10 MON 储备线与清空例外/);
      assert.match(await notice.innerText(), /预检不保证交易成功/);
      assert.equal(await page.locator("#preflightResult h3").innerText(), "Gas 配置无需下调");
      assert.equal(await notice.locator("xpath=ancestor::details").count(), 0);
    });
    await check("invalid hash shows validation error, never chain failure", async () => {
      await query("0x123"); await waitText("#txError", "请检查交易哈希");
      assert.doesNotMatch(await text("#txResult"), /执行失败/);
    });
    await check("MOCK success and failed receipts are separately rendered", async () => {
      await query(SUCCESS); await waitText("#txResult", "执行成功"); await waitText("#txResult", "已最终确认");
      assert.match(await text("#txResult"), /0\.0021 MON/);
      await page.screenshot({ path: path.join(RUN, "MOCK-success.png"), fullPage: true });
      await query(FAILED); await waitText("#txResult", "执行失败");
      assert.match(await text("#txResult"), /不能确定具体失败原因/);
    });
    await check("MOCK null responses are not_found and RPC errors stay query errors", async () => {
      await query(MISSING); await waitText("#txResult", "暂未查到交易");
      assert.doesNotMatch(await text("#txResult"), /当前回执显示执行失败/);
      await query(RPC_ERROR); await waitText("#txError", "本次查询未完成");
      assert.doesNotMatch(await text("#txResult"), /执行失败/);
    });
    for (const mode of ["null", "error"]) {
      await check("MOCK finalized " + mode + " preserves execution success and reports unknown finality", async () => {
        state.finalizedMode = mode;
        try {
          await query(SUCCESS); await waitText("#txResult", "执行成功");
          assert.match(await text("#txResult"), /最终确认状态未知/);
          assert.doesNotMatch(await text("#txResult"), /已最终确认/);
          assert.equal(await page.locator("#txError").isVisible(), false);
        } finally { state.finalizedMode = "normal"; }
      });
    }
    await check("MOCK inconsistent transaction/receipt prominently warns and hides derived fees", async () => {
      state.inconsistentHash = SUCCESS;
      try {
        await query(SUCCESS);
        const resultText = await text("#txResult");
        assert.match(resultText, /交易与回执区块信息暂不一致/);
        assert.doesNotMatch(resultText, /已最终确认|0\.0021 MON|100,000,000,000|链上 Gas 限额/);
        assert.match(resultText, /回执 Gas 用量/);
        assert.match(resultText, /21,000/);
        assert.equal(await page.locator("#txResult .status-card.warn").count(), 1);
        assert.match(await page.locator("#txResult h3").innerText(), /暂不一致/);
      } finally { state.inconsistentHash = null; }
    });
    await check("changing preflight inputs clears a previous result and disables send", async () => {
      await preflight(); await page.locator("#amountMON").fill("0.002");
      await waitText("#preflightResult", "配置已修改");
      assert.equal(await page.locator("#sendTransfer").isDisabled(), true);
      assert.doesNotMatch(await text("#preflightResult"), /检查通过|无需下调/);
    });
    await check("new hash invalidates stale transaction results, including a late response", async () => {
      await query(SUCCESS);
      await page.locator("#txHash").fill(MISSING);
      await waitText("#txResult", "准备查询新的交易");
      assert.doesNotMatch(await text("#txResult"), /执行成功/);
      state.delayHash = SUCCESS; state.delayMS = 350;
      await page.locator("#txHash").fill(SUCCESS); await page.locator("#queryTransaction").click();
      await page.locator("#txHash").fill(MISSING);
      await page.waitForTimeout(600);
      assert.doesNotMatch(await text("#txResult"), /执行成功/);
      state.delayHash = null; state.delayMS = 0;
    });
    await check("MOCK wallet cancellation is not labeled an on-chain failure", async () => {
      await page.locator("#txHash").fill("");
      await page.locator("#connectWallet").click();
      await waitText("#walletStatus", "钱包已连接");
      await preflight();
      assert.equal(await page.locator("#sendTransfer").isEnabled(), true);
      await page.evaluate(() => { window.__MOCK_WALLET__.cancelNext = true; });
      await page.locator("#sendTransfer").click(); await waitText("#walletStatus", "你已取消钱包操作");
      assert.doesNotMatch(await text("#txResult"), /执行失败/);
      assert.equal(await page.evaluate(() => window.__MOCK_WALLET__.sendCalls.at(-1).cancelled), true);
    });
    await check("wallet chain and account changes invalidate send eligibility", async () => {
      await preflight();
      await page.evaluate(() => window.__MOCK_WALLET__.emitChain("0x1"));
      assert.equal(await page.locator("#sendTransfer").isDisabled(), true);
      await waitText("#walletStatus", "钱包网络已变化");
      await page.evaluate(() => window.__MOCK_WALLET__.emitChain("0x279f"));
      assert.equal(await page.locator("#sendTransfer").isDisabled(), true);
      await preflight();
      await page.evaluate(other => window.__MOCK_WALLET__.emitAccount(other), OTHER);
      assert.equal(await page.locator("#sendTransfer").isDisabled(), true);
      await waitText("#preflightResult", "钱包账户已变化");
      await page.evaluate(from => window.__MOCK_WALLET__.emitAccount(from), FROM);
    });
    const contextCases = [
      { name: "chain change", action: () => window.__MOCK_WALLET__.emitChain("0x1") },
      { name: "account change", action: other => window.__MOCK_WALLET__.emitAccount(other), argument: OTHER },
      { name: "chain change away and back", action: () => { window.__MOCK_WALLET__.emitChain("0x1"); window.__MOCK_WALLET__.emitChain("0x279f"); } },
      { name: "account change away and back", action: ({ from, other }) => { window.__MOCK_WALLET__.emitAccount(other); window.__MOCK_WALLET__.emitAccount(from); }, argument: { from: FROM, other: OTHER } },
      { name: "programmatic input mutation without event", action: () => { document.getElementById("amountMON").value = "0.002"; } },
      { name: "silent chain change", action: () => { window.__MOCK_WALLET__.chainId = "0x1"; }, silent: true },
      { name: "silent account change", action: other => { window.__MOCK_WALLET__.account = other; }, argument: OTHER, silent: true }
    ];
    for (const scenario of contextCases) {
      await check("MOCK second-preflight " + scenario.name + " aborts send and visibly invalidates", async () => {
        await walletReady();
        const before = await sentCount();
        const walletCallsBefore = await page.evaluate(() => window.__MOCK_WALLET__.calls.length);
        const gate = estimateGate();
        try {
          await page.locator("#sendTransfer").click(); await awaitEntered(gate);
          await page.evaluate(scenario.action, scenario.argument);
          gate.release(); await idleSend();
          assert.equal(await sentCount(), before);
          await waitText("#preflightResult", "预检已失效");
          assert.equal(await page.locator("#sendTransfer").isDisabled(), true);
          assert.match(await text("#walletStatus"), /预检已失效/);
          if (scenario.silent) {
            const methods = await page.evaluate(start => window.__MOCK_WALLET__.calls.slice(start).map(call => call.method), walletCallsBefore);
            assert.equal(methods.filter(method => method === "eth_accounts").length, 2);
            assert.equal(methods.filter(method => method === "eth_chainId").length, 2);
          }
        } finally { gate.release(); state.estimateGate = null; }
      });
    }
    await check("MOCK sent hash absent on target remains unattributed until a later successful lookup", async () => {
      await walletReady(); state.unknownSent = true;
      try {
        const before = await sentCount();
        await page.locator("#sendTransfer").click(); await idleSend();
        assert.equal(await sentCount(), before + 1);
        await waitText("#txResult", "尚未核实交易网络归属");
        assert.equal(await page.locator("#txResult a.result-link").count(), 0);
        assert.match(await text("#walletStatus"), /网络归属待核实/);
        assert.doesNotMatch(await text("#txResult"), /执行失败/);
        state.unknownSent = false;
        await page.locator("#refreshTx").click(); await waitText("#txResult", "执行成功");
        assert.equal(await page.locator("#txResult a.result-link").count(), 1);
        assert.match(await text("#walletStatus"), /已在 Monad Testnet 查到/);
      } finally { state.unknownSent = false; }
    });
    await check("MOCK wallet popup chain change still looks up returned hash without guessing failure", async () => {
      await walletReady(); state.unknownSent = true;
      await page.evaluate(() => { window.__MOCK_WALLET__.holdSend = true; });
      try {
        const before = await sentCount();
        await page.locator("#sendTransfer").click();
        await page.waitForFunction(() => window.__MOCK_WALLET__.sendPending);
        await page.evaluate(() => window.__MOCK_WALLET__.emitChain("0x1"));
        await waitText("#preflightResult", "预检已失效");
        await page.evaluate(() => window.__MOCK_WALLET__.releaseSend());
        await idleSend();
        assert.equal(await sentCount(), before + 1);
        assert.equal(await page.locator("#txHash").inputValue(), SENT);
        await waitText("#txResult", "尚未核实交易网络归属");
        assert.equal(await page.locator("#txResult a.result-link").count(), 0);
        assert.doesNotMatch(await text("#txResult"), /执行失败/);
        state.unknownSent = false;
        await page.locator("#refreshTx").click(); await waitText("#txResult", "执行成功");
        assert.match(await text("#walletStatus"), /已在 Monad Testnet 查到/);
      } finally {
        state.unknownSent = false;
        await page.evaluate(() => { window.__MOCK_WALLET__.releaseSend?.(); window.__MOCK_WALLET__.emitChain("0x279f"); });
      }
    });
    await check("sending records MOCK wallet parameters and queries its MOCK hash only", async () => {
      await preflight(); await page.locator("#sendTransfer").click();
      await waitText("#txResult", "执行成功");
      await page.waitForFunction(() => !document.getElementById("fromAddress").disabled);
      const sent = await page.evaluate(() => window.__MOCK_WALLET__.sendCalls.at(-1));
      assert.equal(sent.mockOnly, true);
      assert.equal(sent.cancelled, false);
      assert.equal(sent.transaction.from.toLowerCase(), FROM);
      assert.equal(sent.transaction.to.toLowerCase(), TO);
      assert.equal(sent.transaction.gas, "0x5208");
      assert.equal(sent.transaction.chainId, "0x279f");
      assert.equal(await page.locator("#txHash").inputValue(), SENT);
      await waitText("#txResult", "钱包最终采用了本次建议限额");
    });
    await check("MOCK offline errors stay visible and UI recovers without a blank page", async () => {
      state.offline = true;
      await page.locator("#probeNetwork").click(); await waitText("#networkStatus", "本次网络检查未完成");
      await query(MISSING); await waitText("#txError", "本次查询未完成");
      await fillTransfer("21000"); await page.locator("#checkTransfer").click();
      await waitText("#preflightResult", "未完成预检");
      assert.equal(await page.locator("h1").isVisible(), true);
      state.offline = false;
      await page.locator("#probeNetwork").click(); await waitText("#networkStatus", "已连接");
      await query(SUCCESS); await waitText("#txResult", "执行成功");
    });
    await check("mobile layout keeps controls within viewport", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(RUN, "MOCK-mobile.png"), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(overflow, false);
    });
    await check("no uncaught browser JavaScript errors", async () => { assert.deepEqual(pageErrors, []); });
    const wallet = await page.evaluate(() => ({
      sendCalls: window.__MOCK_WALLET__.sendCalls,
      calls: window.__MOCK_WALLET__.calls
    }));
    fs.writeFileSync(reportPath, JSON.stringify({
      evidenceType: "MOCK ONLY: intercepted JSON-RPC + injected wallet. No real transaction signed or broadcast.",
      baseURL: BASE, createdAt: new Date().toISOString(), records, pageErrors, blockedRemote, wallet, rpcCalls
    }, null, 2), { flag: "wx" });
    console.log("MOCK report: " + reportPath);
    if (records.some(record => !record.passed)) process.exitCode = 1;
  } catch (error) {
    fs.writeFileSync(path.join(RUN, "MOCK-fatal-error.json"), JSON.stringify({ evidenceType: "MOCK ONLY", error: error.stack, records }, null, 2), { flag: "wx" });
    console.error(error.stack); process.exitCode = 1;
  } finally {
    if (context) await context.close();
  }
})();
