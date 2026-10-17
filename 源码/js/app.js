(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const cfg = globalThis.BlitzConfig;
  let provider = null, account = null, walletChain = null;
  let lastCheck = null, checkSequence = 0, querySequence = 0;
  let checking = false, sending = false, connecting = false, renderedHash = "";
  const sentGas = new Map();
  const sentTransfers = new Map();
  const fields = ["fromAddress", "toAddress", "amountMON", "gasLimit"];
  function node(tag, className, text) {
    const n = document.createElement(tag); if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = text; return n;
  }
  function formatMON(value) {
    if (value == null) return "未知";
    try { return BlitzPreflight.formatMON(value); } catch (_) { return "未知"; }
  }
  function quantity(value) {
    if (value == null) return "未知";
    try { return BigInt(value).toLocaleString("en-US"); } catch (_) { return String(value); }
  }
  function currentInput() {
    return { from: $("fromAddress").value.trim(), to: $("toAddress").value.trim(),
      amountMON: $("amountMON").value.trim(), candidateGasLimit: $("gasLimit").value.trim() };
  }
  function snapshot() { return JSON.stringify(currentInput()); }
  function empty(target, title, sub) {
    const box = node("div", "empty-state");
    box.append(node("span", "", "⌁"), node("p", "", title), node("small", "", sub || ""));
    target.replaceChildren(box);
  }
  function errorBox(err, heading) {
    const box = node("div", "error-box");
    box.append(node("strong", "", heading || "本次操作未完成"), node("div", "", err.message || String(err)));
    const details = node("details"); details.append(node("summary", "", "查看错误信息"));
    let data = err.data;
    try { if (data && typeof data !== "string") data = JSON.stringify(data); } catch (_) { data = ""; }
    details.append(node("div", "mono", String(err.code ?? "ERROR") + (data ? " · " + data : "")));
    box.append(details); return box;
  }
  function statusCard(tone, title, message) {
    const card = node("div", "status-card " + tone), top = node("div", "status-top");
    top.append(node("span", "state-icon", tone === "good" ? "✓" : tone === "bad" ? "!" : "i"));
    const copy = node("div"); copy.append(node("h3", "", title), node("p", "message", message)); top.append(copy);
    card.append(top); return card;
  }
  function metric(title, value, wide) {
    const m = node("div", "metric" + (wide ? " wide" : ""));
    m.append(node("small", "", title)); const strong = node("strong", "", formatMON(value));
    strong.append(node("span", "unit", value == null ? "" : " MON")); m.append(strong); return m;
  }
  function dataRow(label, value) {
    const r = node("div", "data-row"); r.append(node("span", "", label), node("span", "", value ?? "未知")); return r;
  }
  function updateSendButton() {
    const btn = $("sendTransfer");
    const matches = account && account.toLowerCase() === $("fromAddress").value.trim().toLowerCase();
    const chainOK = walletChain && BigInt(walletChain) === BigInt(cfg.chainIdHex);
    const fresh = lastCheck && lastCheck.snapshot === snapshot() && Date.now() - lastCheck.at < 60000;
    btn.disabled = sending || !provider || !matches || !chainOK || !fresh || !lastCheck?.result.canSend;
    if (sending) btn.textContent = "等待钱包处理…";
    else if (!account) btn.textContent = "连接钱包后确认发送";
    else if (!chainOK) btn.textContent = "请先将钱包切换到测试网";
    else if (!matches) btn.textContent = "发送地址需与钱包一致";
    else if (!fresh || !lastCheck?.result.canSend) btn.textContent = "检查通过后，在钱包确认发送";
    else btn.textContent = "在钱包确认发送";
  }
  function invalidateCheck() {
    checkSequence++; lastCheck = null; checking = false;
    $("checkTransfer").disabled = sending; $("checkTransfer").textContent = "检查转账配置 →";
    $("adoptGas").hidden = true; updateSendButton();
  }
  function renderPreflight(result) {
    const tone = result.state === "ok" ? "good" : ["too_low", "insufficient"].includes(result.state) ? "bad" : "warn";
    const card = statusCard(tone, result.title, result.message);
    card.append(node("p", "scope-notice", result.scopeNotice || "仅检查普通 MON 转账的 Gas 配置；未完整校验 10 MON 储备线与清空例外、近期委托变更及在途交易。预检不保证交易成功。"));
    if (result.gasPriceWei != null && result.state !== "unsupported") {
      const metrics = node("div", "metrics");
      metrics.append(metric("候选配置预计费用", result.candidateFeeWei), metric("建议配置预计费用", result.suggestedFeeWei));
      if (result.differenceWei != null && BigInt(result.differenceWei) > 0n) {
        metrics.append(metric("同一参考单价下的预计差额", result.differenceWei, true));
      }
      card.append(metrics);
      const rows = node("div", "data-rows");
      rows.append(dataRow("候选 / 建议 Gas", quantity(result.candidateGasLimit) + " / " + quantity(result.suggestedGasLimit)),
        dataRow("发送地址总余额", formatMON(result.balanceWei) + " MON"),
        dataRow("RPC 估算", quantity(result.estimateGas) + " Gas"),
        dataRow("参考单价", quantity(result.gasPriceWei) + " wei / Gas"));
      card.append(rows);
    }
    if (result.warnings?.length) { const d = node("details", "scope-details"); d.append(node("summary", "", "检查依据与限制")); result.warnings.forEach(w => d.append(node("p", "warning-line", w))); card.append(d); }
    card.append(node("p", "note", "费用为本次检查时的参考比较，钱包可能调整配置；实际结果以链上记录为准。"));
    $("preflightResult").replaceChildren(card);
    $("adoptGas").hidden = result.state !== "high";
  }
  async function checkTransfer() {
    const seq = ++checkSequence, input = currentInput(), snap = JSON.stringify(input);
    lastCheck = null; checking = true; updateSendButton();
    $("checkTransfer").disabled = true; $("checkTransfer").textContent = "正在读取链上数据…"; $("adoptGas").hidden = true;
    empty($("preflightResult"), "正在检查配置…", "读取地址类型、余额、参考单价和估算结果。");
    try {
      const result = await BlitzPreflight.checkTransfer(input);
      if (seq !== checkSequence || snapshot() !== snap) return;
      lastCheck = { result, snapshot: snap, at: Date.now() }; renderPreflight(result);
    } catch (err) {
      if (seq === checkSequence) $("preflightResult").replaceChildren(errorBox(err, "未完成预检"));
    } finally {
      if (seq === checkSequence) {
        checking = false; $("checkTransfer").disabled = false; $("checkTransfer").textContent = "检查转账配置 →"; updateSendButton();
      }
    }
  }
  async function probeNetwork() {
    $("probeNetwork").disabled = true; $("networkStatus").textContent = "正在核对网络与区块…";
    try {
      const probe = await BlitzRPC.probe();
      $("networkDot").className = "dot online";
      $("networkStatus").textContent = "已连接 · 区块 " + Number(probe.blockNumber).toLocaleString("en-US");
      $("probeDetail").textContent = "链 ID " + BigInt(probe.chainId).toString() + " · 本次检查耗时 " + probe.latencyMs + " ms · " + new Date().toLocaleTimeString("zh-CN");
    } catch (err) {
      $("networkDot").className = "dot offline"; $("networkStatus").textContent = "本次网络检查未完成，可点击重试";
      $("probeDetail").textContent = (err.code || "ERROR") + " · " + err.message;
    } finally { $("probeNetwork").disabled = false; }
  }
  function walletLabel() {
    const btn = $("connectWallet");
    if (!account) { btn.textContent = "连接钱包"; return; }
    if (walletChain && BigInt(walletChain) !== BigInt(cfg.chainIdHex)) { btn.textContent = "切换到测试网"; return; }
    btn.textContent = account.slice(0, 6) + "…" + account.slice(-4);
  }
  async function connectWallet() {
    if (connecting || sending) return;
    const candidate = globalThis.ethereum;
    if (!candidate) {
      $("walletStatus").textContent = "请在已启用钱包扩展的桌面浏览器中连接；费用预检和交易查询也可只读使用。"; return;
    }
    connecting = true; $("connectWallet").disabled = true;
    try {
      if (!provider) {
        provider = candidate.providers?.find(p => p.isMetaMask) || candidate;
        provider.on?.("accountsChanged", accounts => {
          account = accounts[0] || null; $("fromAddress").value = account || ""; invalidateCheck();
          empty($("preflightResult"), "钱包账户已变化，预检已失效", "本次发送检查已作废，请重新检查当前账户和配置。"); walletLabel();
          $("walletStatus").textContent = "钱包账户已变化，预检已失效。若钱包弹窗仍打开，请先核对或取消，不要直接确认。";
        });
        provider.on?.("chainChanged", chain => {
          walletChain = chain; invalidateCheck(); walletLabel(); empty($("preflightResult"), "钱包网络已变化，预检已失效", "本次发送检查已作废，请切回测试网后重新检查。");
          $("walletStatus").textContent = "钱包网络已变化，预检已失效。若钱包弹窗仍打开，请先核对或取消，不要直接确认。";
        });
      }
      if (account && walletChain && BigInt(walletChain) !== BigInt(cfg.chainIdHex)) {
        try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: cfg.chainIdHex }] }); }
        catch (err) {
          if (err.code !== 4902) throw err;
          await provider.request({ method: "wallet_addEthereumChain", params: [{
            chainId: cfg.chainIdHex, chainName: cfg.name,
            nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
            rpcUrls: [cfg.rpcUrl], blockExplorerUrls: [cfg.explorerBase]
          }] });
        }
      }
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      account = accounts[0] || null; walletChain = await provider.request({ method: "eth_chainId" });
      if (account) $("fromAddress").value = account;
      invalidateCheck(); walletLabel();
      $("walletStatus").textContent = walletChain && BigInt(walletChain) === BigInt(cfg.chainIdHex)
        ? "钱包已连接，请检查收款地址、金额和费用后发送。" : "钱包网络与测试网不一致，请点击右上角切换。";
      $("sampleNotice").hidden = true;
    } catch (err) {
      $("walletStatus").textContent = Number(err.code) === 4001 ? "你已取消钱包连接或网络切换。" : "钱包操作未完成：" + err.message;
    } finally { connecting = false; $("connectWallet").disabled = false; walletLabel(); updateSendButton(); }
  }
  function invalidated(reason) {
    const err = new Error(reason || "账户、网络或输入已变化，预检已失效，请重新检查。");
    err.code = "PREFLIGHT_INVALIDATED"; return err;
  }
  function assertSendContext(guard) {
    if (guard.provider !== provider || guard.sequence !== checkSequence || guard.snapshot !== snapshot()) throw invalidated();
  }
  async function readWalletContext() {
    const [accounts, chain] = await Promise.all([
      provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })
    ]);
    return { account: Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null, chain };
  }
  function verifyWalletContext(context, input, guard) {
    assertSendContext(guard);
    if (!context.account || context.account.toLowerCase() !== input.from.toLowerCase()) {
      throw invalidated("钱包账户与发送地址不一致，预检已失效，请重新连接并检查。");
    }
    if (typeof context.chain !== "string" || !/^0x[0-9a-f]+$/i.test(context.chain) || BigInt(context.chain) !== BigInt(cfg.chainIdHex)) {
      throw invalidated("钱包网络不是 Monad Testnet（10143），预检已失效，请切换后重新检查。");
    }
  }
  async function sendTransfer() {
    if (sending || !provider || !lastCheck?.result.canSend || lastCheck.snapshot !== snapshot() || Date.now() - lastCheck.at >= 60000) return;
    const input = currentInput();
    const guard = { sequence: checkSequence, snapshot: snapshot(), provider };
    sending = true; updateSendButton(); fields.forEach(id => $(id).disabled = true);
    $("checkTransfer").disabled = true; $("adoptGas").disabled = true; $("demoGas").disabled = true; $("loadReadOnlySample").disabled = true;
    try {
      verifyWalletContext(await readWalletContext(), input, guard);
      $("walletStatus").textContent = "正在重新检查发送条件…";
      const result = await BlitzPreflight.checkTransfer(input);
      assertSendContext(guard);
      if (!result.canSend || !result.transaction) throw new Error(result.message || "当前配置未通过检查。");
      // No awaited work between this final actual-wallet validation and send.
      const context = await readWalletContext();
      verifyWalletContext(context, input, guard);
      $("walletStatus").textContent = "请在钱包中核对 Monad Testnet、收款地址、测试金额与费用，并自行确认。";
      const hash = await provider.request({ method: "eth_sendTransaction", params: [result.transaction] });
      lastCheck = null;
      if (!BlitzTx.validateHash(hash)) throw new Error("钱包未返回可识别的交易哈希，请先在钱包中核对记录，勿直接重复发送。");
      sentGas.set(hash.toLowerCase(), result.suggestedGasLimit);
      sentTransfers.set(hash.toLowerCase(), { walletChanged: guard.sequence !== checkSequence, verified: false });
      $("walletStatus").textContent = "钱包已返回哈希，尚未核实该交易属于 Monad Testnet，正在回查。勿重复发送。";
      $("txHash").value = hash; await queryTransaction();
    } catch (err) {
      invalidateCheck();
      if (err.code === "PREFLIGHT_INVALIDATED") {
        empty($("preflightResult"), "预检已失效，请重新检查", err.message);
        $("walletStatus").textContent = err.message + " 本工具未继续请求发送；若已有钱包弹窗，请先核对钱包记录。";
      } else {
        $("walletStatus").textContent = Number(err.code) === 4001 ? "你已取消钱包操作，本工具未获得交易哈希。请重新检查后再发送。"
          : "发送流程未完成：" + err.message + "；请先核对钱包记录，再决定是否重试。";
      }
    } finally {
      sending = false; fields.forEach(id => $(id).disabled = false);
      $("checkTransfer").disabled = false; $("adoptGas").disabled = false; $("demoGas").disabled = false; $("loadReadOnlySample").disabled = false;
      updateSendButton();
    }
  }
  function renderTransaction(result) {
    const submitted = sentTransfers.get(result.hash.toLowerCase());
    const foundOnTarget = Boolean(result.tx || result.receipt);
    if (submitted) {
      submitted.verified = foundOnTarget;
      if (foundOnTarget) {
        $("walletStatus").textContent = "已在 Monad Testnet 查到此哈希。执行结果与最终性以右侧查询为准。";
      } else {
        result = { ...result, title: "尚未核实交易网络归属", explorerUrl: null,
          message: "Monad Testnet 当前节点尚未收录此哈希。可能尚未传播，也可能网络不一致；请先核对钱包记录中的网络与状态，稍后重查，勿重复发送。" };
        $("walletStatus").textContent = "网络归属待核实：Monad Testnet 暂未查到此哈希。请核对钱包网络和记录，勿重复发送。";
      }
    }
    const inconsistent = result.consistency === "inconsistent";
    const tone = inconsistent ? "warn" : result.state === "success" ? "good" : result.state === "failed" ? "bad" : "warn";
    const card = statusCard(tone, result.title, result.message);
    if (result.receipt) {
      const finalityText = { finalized: "已最终确认", unfinalized: "尚未最终确认", unknown: "最终确认状态未知" };
      card.append(node("span", "tag" + (result.finality === "finalized" ? " confirmed" : ""), finalityText[result.finality] || "最终确认状态未知"));
    }
    const rows = node("div", "data-rows"), tx = result.tx, receipt = result.receipt;
    rows.append(dataRow(submitted && !foundOnTarget ? "钱包返回哈希（网络归属待核实）" : "交易哈希", result.hash));
    if (receipt || tx) {
      rows.append(dataRow(inconsistent ? "回执区块号（待复核）" : "区块号", quantity(receipt?.blockNumber ?? tx?.blockNumber)),
        dataRow("From", inconsistent ? receipt?.from || "未知" : tx?.from || receipt?.from || "未知"),
        dataRow("To", inconsistent ? receipt?.to || "未知" : tx?.to || receipt?.to || "未知"));
      if (!inconsistent) rows.append(dataRow("链上 Gas 限额", quantity(tx?.gas)));
      rows.append(dataRow("回执 Gas 用量", quantity(receipt?.gasUsed)));
      if (inconsistent) {
        rows.append(dataRow("费用", "暂不展示：交易与回执区块信息不一致"));
      } else {
        rows.append(dataRow("有效 Gas 单价", receipt?.effectiveGasPrice == null ? "未知" : quantity(receipt.effectiveGasPrice) + " wei / Gas"),
          dataRow("按链上限额计算的费用", result.feeWei == null ? "未知：缺少必要字段" : formatMON(result.feeWei) + " MON"));
      }
      if (result.finalizedBlockNumber != null && !inconsistent) {
        rows.append(dataRow("最终性依据", "RPC finalized · 高度 " + quantity(result.finalizedBlockNumber)));
      } else if (receipt) {
        rows.append(dataRow("最终性依据", inconsistent ? "记录不一致，暂不判定" : "RPC 未提供可用 finalized 高度"));
      }
    }
    card.append(rows);
    const expected = sentGas.get(result.hash.toLowerCase());
    if (expected && tx?.gas != null && !inconsistent) {
      card.append(node("p", "warning-line", BigInt(tx.gas) === BigInt(expected)
        ? "钱包最终采用了本次建议限额：" + quantity(tx.gas) + " Gas。"
        : "钱包改写了建议限额：链上实际为 " + quantity(tx.gas) + " Gas；请以链上配置为准。"));
    }
    if (result.warnings?.length) { const d = node("details", "scope-details"); d.append(node("summary", "", "检查依据与限制")); result.warnings.forEach(w => d.append(node("p", "warning-line", w))); card.append(d); }
    if (result.explorerUrl) {
      const a = node("a", "result-link", "在区块浏览器中核对 ↗"); a.href = result.explorerUrl; a.target = "_blank"; a.rel = "noopener noreferrer"; card.append(a);
    }
    card.append(node("p", "note", "查询时间：" + new Date().toLocaleString("zh-CN") + " · 数据来自当前 RPC。"));
    $("txResult").replaceChildren(card); renderedHash = result.hash.toLowerCase();
  }
  async function queryTransaction() {
    const hash = $("txHash").value.trim(), seq = ++querySequence;
    $("txError").hidden = true; $("txError").replaceChildren();
    const same = renderedHash === hash.toLowerCase();
    if (!same) { renderedHash = ""; empty($("txResult"), "正在读取交易结果…", "核对网络、交易和回执。"); }
    $("queryTransaction").disabled = true; $("queryTransaction").textContent = "正在查询…"; $("refreshTx").disabled = true;
    try {
      const result = await BlitzTx.queryTransaction(hash);
      if (seq !== querySequence || $("txHash").value.trim().toLowerCase() !== hash.toLowerCase()) return;
      renderTransaction(result);
    } catch (err) {
      if (seq !== querySequence) return;
      $("txError").hidden = false; $("txError").replaceChildren(errorBox(err, err.code === "INVALID_HASH" ? "请检查交易哈希" : "本次查询未完成"));
      if (sentTransfers.has(hash.toLowerCase())) $("walletStatus").textContent = "回查尚未完成，交易网络归属或执行结果尚未核实。请核对钱包记录，勿重复发送。";
      if (!same) empty($("txResult"), "尚无可展示的结果", "核对输入与网络后，可以重新查询。");
    } finally {
      if (seq === querySequence) {
        $("queryTransaction").disabled = false; $("queryTransaction").textContent = "查询交易结果 ↗"; $("refreshTx").disabled = !hash;
      }
    }
  }
  $("preflightForm").addEventListener("submit", e => { e.preventDefault(); if (!checking && !sending) checkTransfer(); });
  fields.forEach(id => $(id).addEventListener("input", () => {
    invalidateCheck(); empty($("preflightResult"), "配置已修改，请重新检查", "检查结果只适用于当次输入。");
    $("demoNotice").hidden = true; $("sampleNotice").hidden = true;
  }));
  $("adoptGas").addEventListener("click", () => { $("gasLimit").value = lastCheck?.result.suggestedGasLimit || "21000"; $("demoNotice").hidden = true; invalidateCheck(); checkTransfer(); });
  $("demoGas").addEventListener("click", () => {
    $("gasLimit").value = "42000"; invalidateCheck(); $("demoNotice").hidden = false;
    empty($("preflightResult"), "已填入过量演示配置", "点击检查，读取真实单价并比较费用。");
  });
  $("loadReadOnlySample").addEventListener("click", () => {
    const sample = globalThis.BlitzSamples;
    if (!sample?.from) { $("sampleNotice").textContent = "尚未生成可用地址样例，请粘贴你自己的测试网地址。"; $("sampleNotice").hidden = false; return; }
    $("fromAddress").value = sample.from; $("toAddress").value = sample.to || sample.from; $("amountMON").value = "0.001";
    $("gasLimit").value = "21000"; invalidateCheck(); $("demoNotice").hidden = true;
    $("sampleNotice").textContent = "公开链上地址样例，仅供只读检查。样例采集于 " + sample.capturedAt + "，余额会随链上活动变化。"; $("sampleNotice").hidden = false;
    empty($("preflightResult"), "已填入真实链上地址", "点击检查。此操作不会连接钱包或发送交易。");
  });
  $("connectWallet").addEventListener("click", connectWallet); $("sendTransfer").addEventListener("click", sendTransfer);
  $("probeNetwork").addEventListener("click", probeNetwork);
  $("txForm").addEventListener("submit", e => { e.preventDefault(); queryTransaction(); });
  $("refreshTx").addEventListener("click", queryTransaction);
  $("txHash").addEventListener("input", () => {
    querySequence++; renderedHash = ""; $("txError").hidden = true;
    $("queryTransaction").disabled = false; $("queryTransaction").textContent = "查询交易结果 ↗";
    $("refreshTx").disabled = !$("txHash").value.trim(); empty($("txResult"), "准备查询新的交易", "点击查询读取当前网络的数据。");
  });
  $("useSampleTx").addEventListener("click", () => {
    const hash = globalThis.BlitzSamples?.successHash;
    if (!hash) { $("txError").hidden = false; $("txError").replaceChildren(errorBox(new Error("尚未生成真实交易样例，请粘贴目标网络的交易哈希。"))); return; }
    $("txHash").value = hash; queryTransaction();
  });
  $("rpcLabel").textContent = cfg.rpcUrl;
  globalThis.TXSTATUS = Object.freeze({ show(hash) { $("txHash").value = hash; return queryTransaction(); } });
  probeNetwork();
})();
