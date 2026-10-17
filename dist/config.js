/* Official Monad testnet configuration, checked 2026-10-17. */
(function (root) {
  "use strict";
  const config = Object.freeze({
    name: "Monad Testnet", chainId: 10143, chainIdHex: "0x279f",
    rpcUrl: "https://testnet-rpc.monad.xyz",
    explorerBase: "https://testnet.monadscan.com",
    faucetUrl: "https://faucet.monad.xyz", timeoutMs: 12000,
    currency: "MON", decimals: 18, ordinaryTransferGas: "21000"
  });
  root.BlitzConfig = config;
  if (typeof module !== "undefined" && module.exports) module.exports = config;
})(typeof globalThis !== "undefined" ? globalThis : this);
