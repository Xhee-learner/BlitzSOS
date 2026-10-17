'use strict';
const assert = require('node:assert/strict');
const { checkTransfer, parseMON, formatMON, toHex } = require('../js/preflight.js');
const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const input = (overrides = {}) => ({ from: FROM, to: TO, amountMON: '0.01', candidateGasLimit: '21000', ...overrides });
const makeRPC = (config = {}) => {
  const calls = [];
  const request = async (method, params) => {
    calls.push([method, params]);
    if (method === config.throwOn) throw new Error('fixture unavailable');
    if (method === 'eth_chainId') return config.chain || '0x279f';
    if (method === 'eth_getBalance') return toHex(config.balance ?? parseMON('1'));
    if (method === 'eth_gasPrice') return config.price ?? '0x174876e800'; // 100 MON-gwei
    if (method === 'eth_getCode') return params[0] === FROM ? (config.fromCode ?? '0x') : (config.toCode ?? '0x');
    if (method === 'eth_estimateGas') return config.estimate ?? '0x5208';
    throw new Error('Unexpected RPC ' + method);
  };
  return { request, calls };
};
let passed = 0;
async function test(name, run) { await run(); passed++; process.stdout.write('PASS ' + name + '\n'); }
(async () => {
  await test('exact 18-decimal parsing and round trip beyond Number precision', () => {
    const wei = parseMON('123456789.000000000000000001');
    assert.equal(wei, 123456789000000000000000001n);
    assert.equal(formatMON(wei.toString()), '123456789.000000000000000001');
    assert.equal(parseMON('0'), 0n);
    assert.equal(formatMON(-1n), '-0.000000000000000001');
    assert.equal(toHex(21000n), '0x5208');
  });
  await test('reject excess decimals, exponent, float, whitespace and unsupported notation', () => {
    for (const bad of ['0.0000000000000000001', '1e-3', 0.01, ' 1', '.1', '01', '-1', '1,000']) {
      assert.throws(() => parseMON(bad), { code: 'INVALID_AMOUNT' });
    }
    assert.throws(() => formatMON(0.1), { code: 'INVALID_INPUT' });
  });
  await test('ordinary transfer below 10 MON is supported without blanket reserve subtraction', async () => {
    const rpc = makeRPC({ balance: parseMON('0.1') });
    const result = await checkTransfer(input(), rpc);
    assert.equal(result.state, 'ok'); assert.equal(result.canSend, true);
    assert.equal(result.title, 'Gas 配置无需下调');
    assert.match(result.scopeNotice, /未完整校验 10 MON 储备线与清空例外/);
    assert.match(result.scopeNotice, /预检不保证交易成功/);
    assert.match(result.warnings[0], /当前代码均为空/);
    assert.match(result.message, /不代表完整验证交易可执行/);
    assert.equal(result.balanceWei, parseMON('0.1').toString());
    assert.equal(result.suggestedFeeWei, parseMON('0.0021').toString());
    assert.equal(result.transaction.chainId, '0x279f');
    assert.equal(result.transaction.gas, '0x5208');
    const estimateInput = rpc.calls.find(x => x[0] === 'eth_estimateGas')[1][0];
    assert.equal(estimateInput.gas, '0x5208'); assert.equal(estimateInput.value, toHex(parseMON('0.01')));
    assert.equal('data' in estimateInput, false);
  });
  await test('high limit quotes same-price difference and requires recheck', async () => {
    const result = await checkTransfer(input({ candidateGasLimit: '42000' }), makeRPC());
    assert.equal(result.state, 'high'); assert.equal(result.canSend, false);
    assert.equal(result.differenceWei, parseMON('0.0021').toString());
    assert.equal(BigInt(result.candidateFeeWei), BigInt(result.suggestedFeeWei) * 2n);
  });
  await test('too low blocks before estimation and keeps signed fee difference', async () => {
    const rpc = makeRPC(); const result = await checkTransfer(input({ candidateGasLimit: '20999' }), rpc);
    assert.equal(result.state, 'too_low'); assert.equal(result.canSend, false);
    assert.ok(BigInt(result.differenceWei) < 0n);
    assert.equal(rpc.calls.some(x => x[0] === 'eth_estimateGas'), false);
  });
  await test('insufficient includes transfer plus suggested fee, does not estimate', async () => {
    const rpc = makeRPC({ balance: parseMON('0.011') });
    const result = await checkTransfer(input(), rpc);
    assert.equal(result.state, 'insufficient'); assert.equal(result.canSend, false);
    assert.equal(rpc.calls.some(x => x[0] === 'eth_estimateGas'), false);
  });
  await test('sufficient for suggested but not high limit still requires adoption', async () => {
    const result = await checkTransfer(input({ candidateGasLimit: '42000' }), makeRPC({ balance: parseMON('0.013') }));
    assert.equal(result.state, 'high'); assert.equal(result.canSend, false);
    assert.match(result.message, /超过总余额/);
  });
  await test('network 10147 is rejected before account calls', async () => {
    const rpc = makeRPC({ chain: '0x27a3' });
    await assert.rejects(checkTransfer(input(), rpc), { code: 'WRONG_NETWORK' });
    assert.equal(rpc.calls.length, 1);
    await assert.rejects(checkTransfer(input(), { ...makeRPC(), expectedChainId: '0x27a3' }), { code: 'INVALID_NETWORK_CONFIG' });
  });
  await test('RPC failure stays a query error, never labels funds/transaction failed', async () => {
    await assert.rejects(checkTransfer(input(), makeRPC({ throwOn: 'eth_gasPrice' })), { code: 'RPC_ERROR' });
    await assert.rejects(checkTransfer(input(), makeRPC({ throwOn: 'eth_estimateGas' })), { code: 'ESTIMATE_FAILED' });
  });
  await test('contract or delegation code is unsupported without estimate', async () => {
    for (const override of [{ fromCode: '0xef01000000000000000000000000000000000000000001' }, { toCode: '0x6000' }]) {
      const rpc = makeRPC(override); const result = await checkTransfer(input(), rpc);
      assert.equal(result.state, 'unsupported'); assert.equal(result.canSend, false);
      assert.equal(result.transaction, null);
      assert.equal(rpc.calls.some(x => x[0] === 'eth_estimateGas'), false);
    }
  });
  await test('zero and reserved addresses are unsupported even if getCode would be empty', async () => {
    for (const value of [0n, 1n, 0x1001n, 0xffffn]) {
      const rpc = makeRPC();
      const result = await checkTransfer(input({ to: '0x' + value.toString(16).padStart(40, '0') }), rpc);
      assert.equal(result.state, 'unsupported'); assert.equal(result.balanceWei, null);
      assert.equal(result.transaction, null); assert.equal(rpc.calls.length, 0);
    }
  });
  await test('unexpected estimate cannot be blindly converted to suggested send', async () => {
    const result = await checkTransfer(input(), makeRPC({ estimate: '0x6000' }));
    assert.equal(result.state, 'unsupported'); assert.equal(result.canSend, false); assert.equal(result.transaction, null);
  });
  await test('self transfer is allowed if otherwise supported', async () => {
    const result = await checkTransfer(input({ to: FROM }), makeRPC());
    assert.equal(result.state, 'ok'); assert.equal(result.from, result.to);
  });
  await test('malformed RPC responses are rejected instead of fabricated', async () => {
    await assert.rejects(checkTransfer(input(), makeRPC({ price: '12' })), { code: 'RPC_INVALID_RESPONSE' });
    await assert.rejects(checkTransfer(input(), makeRPC({ price: '0x0' })), { code: 'RPC_INVALID_RESPONSE' });
    await assert.rejects(checkTransfer(input(), makeRPC({ fromCode: '0x0' })), { code: 'RPC_INVALID_RESPONSE' });
  });
  await test('input gas and amount stay exact and reject invalid boundaries', async () => {
    for (const candidateGasLimit of ['0', '-1', '21000.1', '2e4', 21000]) {
      await assert.rejects(checkTransfer(input({ candidateGasLimit }), makeRPC()), { code: 'INVALID_GAS_LIMIT' });
    }
    await assert.rejects(checkTransfer(input({ amountMON: '0' }), makeRPC()), { code: 'INVALID_AMOUNT' });
    await assert.rejects(checkTransfer(input({ to: '0x123' }), makeRPC()), { code: 'INVALID_ADDRESS' });
  });
  process.stdout.write('\n' + passed + ' tests passed; mock RPC only, no transactions sent.\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });