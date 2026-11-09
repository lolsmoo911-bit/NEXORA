/**
 * Live loopback RPC probe (Phase 6 compatibility observations).
 *
 * Talks ONLY to an explicit loopback URL (default http://127.0.0.1:8545).
 * Never invents values: when the node is down it returns connected:false.
 * Used to fill the compatibility matrix with LOCAL-LIVE observations.
 */
import { hexToBigInt } from './gas.mjs';

export async function rpcCall(rpcUrl, method, params, { timeoutMs = 3000, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    const body = await r.text();
    if (body.length > 2 * 1024 * 1024) return { ok: false, error: 'response_too_large' };
    const j = JSON.parse(body);
    if (j && j.error) return { ok: false, error: String(j.error.message || j.error.code || 'rpc_error'), code: j.error.code ?? null };
    return { ok: true, result: j ? j.result : null };
  } catch (e) {
    return { ok: false, error: 'upstream_unreachable', detail: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Probe identity + gas methods. Returns { connected, chainIdDec, chainIdHex,
 * netVersion, blockNumber, gasPriceWei, estimateGas } with nulls when down.
 * estimateGas targets a simple value transfer from a genesis-funded address;
 * callers pass from/to token addresses (test-only, never mainnet keys).
 */
export async function probeNode(rpcUrl = 'http://127.0.0.1:8545', { from, to, fetchImpl } = {}) {
  const chain = await rpcCall(rpcUrl, 'eth_chainId', [], { fetchImpl });
  if (!chain.ok) {
    return { connected: false, chainIdDec: null, chainIdHex: null, netVersion: null, blockNumber: null, gasPriceWei: null, estimateGas: null, via: null };
  }
  const hex = chain.result;
  const dec = Number(hexToBigInt(hex));
  const [netv, blk, gas] = await Promise.all([
    rpcCall(rpcUrl, 'net_version', [], { fetchImpl }),
    rpcCall(rpcUrl, 'eth_blockNumber', [], { fetchImpl }),
    rpcCall(rpcUrl, 'eth_gasPrice', [], { fetchImpl }),
  ]);
  let estimate = null;
  if (from && to && /^0x[0-9a-fA-F]{40}$/.test(from) && /^0x[0-9a-fA-F]{40}$/.test(to)) {
    const est = await rpcCall(rpcUrl, 'eth_estimateGas', [{ from, to, value: '0x0' }], { fetchImpl });
    if (est.ok) estimate = est.result;
  }
  return {
    connected: true,
    chainIdDec: dec, chainIdHex: hex,
    netVersion: netv.ok ? netv.result : null,
    blockNumber: blk.ok ? blk.result : null,
    gasPriceWei: gas.ok && typeof gas.result === 'string' ? gas.result : null,
    estimateGas: estimate,
    via: rpcUrl,
  };
}

/** Assert a probe matches NEXORA devnet identity (902024). Returns true or throws. */
export function assertNEXORAvIdentity(probe) {
  if (!probe || !probe.connected) throw new Error('probe is disconnected');
  if (probe.chainIdDec !== 902024) {
    throw new Error(`chainId ${probe.chainIdDec} (${probe.chainIdHex}) is not NEXORA devnet 902024`);
  }
  return true;
}
