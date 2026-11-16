// ABI values as JSON, from the ABI's own description of them (the raw JSON ABI keeps each
// parameter's internalType, which names enums and structs): uint and int as decimal strings, an
// enum as its member's name, a struct as an object keyed by component name, arrays as arrays;
// addresses (checksummed), bytes (0x hex), strings and bools as ethers decodes them. The record
// mirror and the indexed events are written with this, so they read like the contract's view.
import { STAKE_ATTESTATION_ABI, ENUMS } from './abi.js';

const ENUM_TYPE = /^enum (?:\w+\.)?(\w+)$/;
const ARRAY_TYPE = /^(.*)\[(\d*)\]$/;

/**
 * @param {unknown} value - as ethers decoded it (a Result for a tuple or an array)
 * @param {{ type: string, internalType?: string, components?: object[] }} param - from the JSON ABI
 */
export function toJson(value, param) {
  const array = ARRAY_TYPE.exec(param.type);
  if (array) {
    const child = { ...param, type: array[1], internalType: (param.internalType ?? '').replace(/\[\d*\]$/, '') };
    return Array.from(value, (v) => toJson(v, child));
  }
  if (param.type === 'tuple') {
    return Object.fromEntries(param.components.map((c, i) => [c.name, toJson(value[i], c)]));
  }
  const enumName = ENUM_TYPE.exec(param.internalType ?? '')?.[1];
  if (enumName) {
    const names = ENUMS[enumName];
    if (!names) throw new TypeError(`unknown enum ${enumName}`);
    const name = names[Number(value)];
    if (name === undefined) throw new RangeError(`${value} is not a member of ${enumName}`);
    return name;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function fragment(type, name) {
  const f = STAKE_ATTESTATION_ABI.find((x) => x.type === type && x.name === name);
  if (!f) throw new TypeError(`StakeAttestation has no ${type} ${name}`);
  return f;
}

/** A view's single output, as JSON. */
export function outputJson(functionName, result) {
  return toJson(result, fragment('function', functionName).outputs[0]);
}

/** An event's arguments, as JSON keyed by name. */
export function eventArgsJson(parsedLog) {
  const f = fragment('event', parsedLog.name);
  return Object.fromEntries(f.inputs.map((input, i) => [input.name, toJson(parsedLog.args[i], input)]));
}
