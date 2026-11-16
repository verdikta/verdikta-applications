// Contract reads pinned to one block by its hash (EIP-1898: eth_call with { blockHash,
// requireCanonical }), so everything the site shows for a block is that block's: a read of a
// block that a reorg orphaned fails instead of answering from the branch that replaced it at the
// same height. ethers' blockTag takes only a number or a tag, so the call goes through send.
/**
 * @param {import('ethers').JsonRpcApiProvider} provider - with send (JsonRpcProvider, BrowserProvider)
 * @param {import('ethers').Interface} iface
 * @param {string} to
 * @param {string} blockHash
 * @returns {(fn: string, args?: unknown[]) => Promise<import('ethers').Result>}
 */
export function readerAt(provider, iface, to, blockHash) {
  return async (fn, args = []) => {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await provider.send('eth_call', [{ to, data }, { blockHash, requireCanonical: true }]);
    return iface.decodeFunctionResult(fn, raw);
  };
}
