import { createHash } from 'node:crypto';

/** Binds the directory revision on screen to the native contract, quantity unit and market ID. */
export const terminalIdentity = (listing, native) => createHash('sha256').update(JSON.stringify([listing, native])).digest('hex');
