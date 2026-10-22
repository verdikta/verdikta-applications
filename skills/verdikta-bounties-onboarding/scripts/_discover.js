// The sibling verdikta-discover skill (skills/verdikta-discover beside this one) is loaded only for work orders:
// commissioning a work-order draft (approve_work_order.js, create_bounty.js) and submitting to a work-order bounty.
// A plain bounty or a wager never runs its code. When it is needed and missing, the step stops before any upload or
// transaction, so a work order is never handled without its checks.
export const DISCOVER_REQUIRED = 'the sibling verdikta-discover skill (skills/verdikta-discover beside this skill, with its locked dependencies: npm ci --ignore-scripts there) from the same reviewed revision';

export async function importDiscover(file, purpose, loadModule = (url) => import(url)) {
  const url = new URL(`../../verdikta-discover/scripts/${file}`, import.meta.url).href;
  try { return await loadModule(url); }
  catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw Object.assign(new Error(`${purpose} needs ${DISCOVER_REQUIRED}. It could not be loaded (${error.message}). Install it, then retry; nothing was uploaded or signed.`), { code: 'DISCOVER_UNAVAILABLE', cause: error });
  }
}
