/** The sidebar folding away, everything beside it making room, and the grid's cards moving with
 * it: all on this one spring, so they move as one. */
export const FOLD = { type: 'spring', stiffness: 380, damping: 40, mass: 0.9 } as const;
