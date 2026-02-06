import './_env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, Contract, parseEther } from 'ethers';

export const LINK = {
  base: '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196',
  'base-sepolia': '0xE4aB69C077896252FAFBD49EFD26B5D171A32410'
};

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address,uint256) returns (bool)'
];

export function getNetwork() {
  return process.env.VERDIKTA_NETWORK || 'base';
}

export function getRpcUrl(network) {
  if (network === 'base') return process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  return process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
}

export function resolvePath(p) {
  if (!p) return p;
  // Resolve relative paths against the scripts directory (not the caller's CWD).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.isAbsolute(p) ? p : path.resolve(here, p);
}

export async function loadWallet() {
  const keystorePathRaw = process.env.VERDIKTA_KEYSTORE_PATH;
  const password = process.env.VERDIKTA_WALLET_PASSWORD;
  if (!keystorePathRaw || !password) throw new Error('Set VERDIKTA_KEYSTORE_PATH and VERDIKTA_WALLET_PASSWORD');
  const keystorePath = resolvePath(keystorePathRaw);
  const json = await fs.readFile(keystorePath, 'utf-8');
  return Wallet.fromEncryptedJson(json, password);
}

export function providerFor(network) {
  return new JsonRpcProvider(getRpcUrl(network));
}

export async function linkBalance(network, provider, address) {
  const linkAddr = LINK[network];
  const link = new Contract(linkAddr, ERC20_ABI, provider);
  const [bal, dec] = await Promise.all([link.balanceOf(address), link.decimals()]);
  return { bal, dec, linkAddr };
}

export function parseEth(s) {
  return parseEther(String(s));
}
