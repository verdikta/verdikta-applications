// How an ABI value is expected to appear in the server's JSON (the store's events, the record
// mirror): written here from the ABI and the contract's source, independently of the server's
// codec, so the tests compare two implementations. uint and int are decimal strings, enums the
// member's name (read from StakeAttestation.sol), tuples objects keyed by component name, arrays
// arrays; addresses, bytes, strings and bools as ethers decodes them.
import { stakeAttestationSource } from './chain.js';

/** The contract's enums, read from its source. */
export function solidityEnums() {
  const out = {};
  for (const m of stakeAttestationSource().matchAll(/enum (\w+) \{([^}]*)\}/g)) out[m[1]] = m[2].split(',').map((s) => s.trim());
  return out;
}

export function expectedJson(value, param, enums = solidityEnums()) {
  const enumName = /^enum (?:\w+\.)?(\w+)$/.exec(param.internalType ?? '')?.[1];
  if (enumName) return enums[enumName][Number(value)];
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array) {
    const child = { ...param, type: array[1], internalType: (param.internalType ?? '').replace(/\[\d*\]$/, '') };
    return [...value].map((v) => expectedJson(v, child, enums));
  }
  if (param.type === 'tuple') return Object.fromEntries(param.components.map((c, i) => [c.name, expectedJson(value[i], c, enums)]));
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** A view function's single output, from the merged ABI. */
export function outputOf(abi, name) {
  const f = abi.find((x) => x.type === 'function' && x.name === name);
  if (!f) throw new Error(`no ${name} in the ABI`);
  return f.outputs[0];
}
