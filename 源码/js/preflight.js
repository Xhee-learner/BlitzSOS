/* BlitzSOS v3 — native MON transfer preflight. No wallet connection or sending. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlitzPreflight = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var UNIT = 1000000000000000000n;
  var SIMPLE_GAS = 21000n;
  var CHAIN_ID = '0x279f';
  var MAX_UINT256 = (1n << 256n) - 1n;

  function fail(code, message, cause) {
    var error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    throw error;
  }

  function integer(value, signed) {
    if (typeof value === 'bigint') {
      if (!signed && value < 0n) fail('INVALID_INPUT', '数值不能为负数。');
      return value;
    }
    if (typeof value !== 'string' || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) {
      fail('INVALID_INPUT', '请使用十进制整数字符串或 BigInt，不能使用浮点数。');
    }
    return BigInt(value);
  }

  function parseMON(value) {
    if (typeof value !== 'string' || value.length > 100 || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) {
      fail('INVALID_AMOUNT', 'MON 金额必须是普通十进制字符串，最多 18 位小数；不支持指数、逗号或前导零。');
    }
    var parts = value.split('.');
    var wei = BigInt(parts[0]) * UNIT + BigInt((parts[1] || '').padEnd(18, '0'));
    if (wei > MAX_UINT256) fail('INVALID_AMOUNT', '金额超出链上数值范围。');
    return wei;
  }

  function formatMON(value) {
    var wei = integer(value, true);
    var prefix = wei < 0n ? '-' : '';
    if (wei < 0n) wei = -wei;
    var fraction = (wei % UNIT).toString().padStart(18, '0').replace(/0+$/, '');
    return prefix + (wei / UNIT).toString() + (fraction ? '.' + fraction : '');
  }

  function toHex(value) { return '0x' + integer(value, false).toString(16); }

  function address(value, field) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      fail('INVALID_ADDRESS', field + '必须是 0x 开头的 40 位十六进制地址。');
    }
    return value;
  }

  function quantity(value, method) {
    if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value) || value.length > 66) {
      fail('RPC_INVALID_RESPONSE', method + ' 返回了无效的十六进制数值。');
    }
    return BigInt(value);
  }

  function validateCode(value) {
    if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
      fail('RPC_INVALID_RESPONSE', 'eth_getCode 返回格式无效，无法确认账户类型。');
    }
    return value;
  }

  async function checkTransfer(input, options) {
    input = input || {};
    options = options || {};
    var from = address(input.from, '付款地址');
    var to = address(input.to, '收款地址');
    var value = parseMON(input.amountMON);
    if (value <= 0n) fail('INVALID_AMOUNT', '转账金额必须大于 0 MON。');
    if (typeof input.candidateGasLimit !== 'string' || !/^[1-9]\d{0,77}$/.test(input.candidateGasLimit)) {
      fail('INVALID_GAS_LIMIT', 'Gas limit 必须是大于 0 的十进制整数字符串。');
    }
    var gas = BigInt(input.candidateGasLimit);
    if (gas > MAX_UINT256) fail('INVALID_GAS_LIMIT', 'Gas limit 超出链上数值范围。');
    var expected = options.expectedChainId === undefined ? CHAIN_ID : options.expectedChainId;
    if (typeof expected !== 'string' || !/^0x[0-9a-f]+$/i.test(expected) || BigInt(expected) !== BigInt(CHAIN_ID)) {
      fail('INVALID_NETWORK_CONFIG', '此版本仅支持 Monad Testnet：10143（0x279f）。');
    }
    var result = {
      state: 'unsupported', title: '', message: '', from: from, to: to,
      valueWei: value.toString(), balanceWei: null, gasPriceWei: null,
      candidateGasLimit: gas.toString(), suggestedGasLimit: SIMPLE_GAS.toString(),
      estimateGas: null, candidateFeeWei: null, suggestedFeeWei: null,
      differenceWei: null, canSend: false, checkedAt: new Date().toISOString(),
      transaction: null,
      scopeNotice: '仅检查普通 MON 转账的 Gas 配置；未完整校验 10 MON 储备线与清空例外、近期委托变更及在途交易。预检不保证交易成功。',
      warnings: [
        '仅适用于发送方和收款方当前代码均为空、不含调用数据的原生 MON 转账；未完整判断近期委托变更。',
        '余额是 RPC 返回的总余额；不减去固定 10 MON，也不判断充值成熟度。',
        '费用按同一次查询的 Gas 单价比较；实际发送由钱包确认，预检不保证上链或成功。',
        '地址只做格式校验，不校验大小写校验和；请再次核对收款地址。'
      ]
    };
    function state(name, title, message) {
      result.state = name; result.title = title; result.message = message;
      result.canSend = name === 'ok';
      result.checkedAt = new Date().toISOString();
      return result;
    }
    if (BigInt(from) <= 65535n || BigInt(to) <= 65535n) {
      return state('unsupported', '暂不支持此地址', '零地址及低位保留地址不属于本工具支持的普通转账范围，请更换地址。');
    }
    var request = options.request || (root.BlitzRPC && root.BlitzRPC.request);
    if (typeof request !== 'function') fail('RPC_UNAVAILABLE', '未提供 RPC request 函数。');
    async function rpc(method, params) {
      try { return await request(method, params); }
      catch (error) {
        var reason = error && error.message ? String(error.message).slice(0, 240) : '请求失败';
        fail(method === 'eth_estimateGas' ? 'ESTIMATE_FAILED' : 'RPC_ERROR', method + ' 查询失败：' + reason, error);
      }
    }
    var chain = quantity(await rpc('eth_chainId', []), 'eth_chainId');
    if (chain !== BigInt(CHAIN_ID)) {
      fail('WRONG_NETWORK', '当前 RPC 网络不是 Monad Testnet。需要 10143（0x279f），实际返回 ' + chain.toString() + '。');
    }
    var values = await Promise.all([
      rpc('eth_getBalance', [from, 'latest']), rpc('eth_gasPrice', []),
      rpc('eth_getCode', [from, 'latest']), rpc('eth_getCode', [to, 'latest'])
    ]);
    var balance = quantity(values[0], 'eth_getBalance');
    var price = quantity(values[1], 'eth_gasPrice');
    if (price <= 0n) fail('RPC_INVALID_RESPONSE', 'RPC 返回的 Gas 单价不是正数，无法可靠比较费用。');
    var fromCode = validateCode(values[2]);
    var toCode = validateCode(values[3]);
    result.balanceWei = balance.toString();
    result.gasPriceWei = price.toString();
    result.candidateFeeWei = (gas * price).toString();
    result.suggestedFeeWei = (SIMPLE_GAS * price).toString();
    result.differenceWei = ((gas - SIMPLE_GAS) * price).toString();
    if (fromCode !== '0x' || toCode !== '0x') {
      return state('unsupported', '此账户类型暂不支持', '付款或收款地址包含代码，可能是合约、智能钱包或委托账户。不能套用普通转账的 21,000 Gas 建议。');
    }
    result.transaction = {
      from: from, to: to, value: toHex(value), gas: toHex(gas), gasPrice: toHex(price), chainId: CHAIN_ID
    };
    if (gas < SIMPLE_GAS) {
      return state('too_low', 'Gas limit 低于普通转账要求', '当前配置低于 21,000 Gas，不能发送。请采用建议值后重新检查。');
    }
    if (balance < value + SIMPLE_GAS * price) {
      return state('insufficient', '总余额不足以覆盖金额与预计费用', '即使采用 21,000 Gas，当前总余额也不足以覆盖金额与预计费用。请减少金额或补充测试币后重新检查。');
    }
    // The fixed-gas estimate is an additional current-state check, not a general-purpose estimator.
    var estimate = quantity(await rpc('eth_estimateGas', [{
      from: from, to: to, value: toHex(value), gas: toHex(SIMPLE_GAS), gasPrice: toHex(price)
    }]), 'eth_estimateGas');
    result.estimateGas = estimate.toString();
    if (estimate !== SIMPLE_GAS) {
      result.transaction = null;
      return state('unsupported', '估算结果不符合普通转账范围', 'RPC 估算不是 21,000 Gas。为避免错误降低限额，本工具不提供可发送建议，请在原钱包核对。');
    }
    if (gas > SIMPLE_GAS) {
      var extra = balance < value + gas * price ? '当前配置还会超过总余额。' : '';
      return state('high', '当前 Gas limit 高于普通转账所需', extra + '按同一 Gas 单价比较，可采用 21,000 Gas 后重新检查；这不是已经实现的节省金额。');
    }
    return state('ok', 'Gas 配置无需下调', '本次地址当前代码、总余额及 RPC 估算检查通过，21,000 Gas 无需下调；这不代表完整验证交易可执行。请在钱包中再次确认收款地址、金额、网络及最终费用。');
  }

  return Object.freeze({ checkTransfer: checkTransfer, parseMON: parseMON, formatMON: formatMON, toHex: toHex });
});