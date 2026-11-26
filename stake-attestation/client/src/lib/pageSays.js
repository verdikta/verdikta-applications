// What a listing's own page says of the listing, and from what (node P42; owner decision, 2026-11-24).
//
//  1. Only a read says what the listing is. That it is on hold, since when, and what its maker may do because of it
//     (push the fix, the order of steps, roll forward, close) are shown from a read that is one snapshot of one block
//     (chain/snapshot.js), and from nothing else. No receipt of a transaction the page sent stands in for a read.
//  2. Off the screen at once, back only from a read. Each transaction the page sends and sees mined, and each read
//     through the wallet that refuses an action because it has the listing otherwise than the page shows it, tells the
//     page that the read it shows is behind. From that instant, before any new read answers, the page shows nothing
//     that read says of the listing's hold or of what the listing takes. It all comes back only from a read of that
//     block or a later one. While it reads for that, the page says so; when its reads are over and none was taken,
//     it names the block its next read has to reach (the floor, below) and offers to read again.
//  3. Never backward. No read of an earlier block is taken after a later one was shown, or after the page was told of
//     a later one.
//
// The page keeps one small record of this (`NOTHING_READ`, moved on by `pageAfter` for each thing that happens to it)
// and `pageSays` decides from that record alone what is on the screen. Nothing else on the page decides it.
// The line an action shows for its own transaction (the transaction, and what its receipt said) is not part of this:
// it stays where the action put it while its listing is on the page, through every re-read of it, and is not checked
// against a later read. A read that says the listing is gone, or not opened, takes the page with its actions.

/** A page that has read nothing and was told of nothing. */
export const NOTHING_READ = Object.freeze({ read: null, needed: 0, behind: false, asked: false, reading: false });

/**
 * What an action hands the page when the read through the wallet, just before sending, has the listing otherwise than
 * the page shows it, and nothing was sent: the block that read was of. After a transaction an action hands over the
 * number of the block it was mined in.
 */
export const disagreedAt = (block) => Object.freeze({ disagreed: true, block });

/** The floor: the block no read from before is taken. The newest the page was told of, or has shown a read of. */
export const floorOf = (page) => Math.max(page.needed, page.read?.block ?? 0);

/**
 * The page's record after one thing happened to it.
 * @param {{ read: object|null, needed: number, behind: boolean, asked: boolean, reading: boolean }} page
 *        `read`: the read on display ({ listing, hold, block }, { missing, block } or { failed }); `needed`: the
 *        newest block the page was told of; `behind`: it was told the read on display is behind, and has taken no
 *        read since; `asked`: a read was asked for (by a transaction, a refusal or the visitor) and none was taken
 *        since; `reading`: the reads made for it are still out
 * @param {object} event
 *   { type: 'loaded', read }: the page's first read answered, or failed. Null while it is made.
 *   { type: 'mined', block }: a transaction the page sent was mined in `block`.
 *   { type: 'disagreed', block, shown }: a wallet's read of `block` refused an action. `shown`: the action was drawn
 *     for the listing now on display. One drawn for a listing the page has since replaced sets the floor and hides
 *     nothing of the listing now shown.
 *   { type: 'again' }: the visitor asked to read again.
 *   { type: 'read', read }: a read answered. It is taken only when it is of the floor's block or a later one.
 *   { type: 'settled' }: the reads made for the block are over, whether or not one was taken.
 */
export function pageAfter(page, event) {
  switch (event.type) {
    case 'loaded': return { ...page, read: event.read };
    case 'mined': return { ...page, needed: Math.max(page.needed, event.block), behind: true, asked: true, reading: true };
    case 'disagreed': return { ...page, needed: Math.max(page.needed, event.block), behind: page.behind || Boolean(event.shown), asked: true, reading: true };
    case 'again': return { ...page, asked: true, reading: true };
    case 'read': return event.read.block >= floorOf(page) ? { ...page, read: event.read, behind: false, asked: false } : page;
    case 'settled': return { ...page, reading: false };
    default: throw new TypeError(`pageAfter: no such event (${event.type})`);
  }
}

/**
 * What the page says, from its record alone.
 * @returns {{ failed: string|null, off: boolean, unread: number|null, reading: boolean }}
 *   failed: the read on display failed, and why: the page's failed-read state, with nothing of a listing.
 *   off: the hold's lines are off the screen, with everything else the read on display says of the listing's state
 *     and of what its maker may do. Each action's line for its own transaction stays. Against a contract with no
 *     hold there is no such line to take off, and nothing is.
 *   unread: a read was asked for and its reads are over with none taken: the block the next read has to reach, said
 *     with "Read again". That block is the floor, never an earlier one the page was told of: a read of a block
 *     between the two was not taken, and the page must not say it has not read that far.
 *   reading: a read was asked for and its reads are still out. Said for every read that was asked for, whether or
 *     not anything is off the page meanwhile.
 */
export function pageSays(page) {
  return {
    failed: page.read?.failed ?? null,
    off: page.behind && Boolean(page.read?.hold?.supported),
    unread: page.asked && !page.reading ? floorOf(page) : null,
    reading: page.asked && page.reading,
  };
}
