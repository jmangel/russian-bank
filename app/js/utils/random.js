/**
 * Deterministic pseudo-random generator (mulberry32) used for every in-play AI
 * decision, so the AI's turn can be replayed identically after a page refresh.
 *
 * Why: the game persists itself to localStorage and re-runs the AI on restore.
 * If the AI drew from Math.random() the replay would diverge, letting a player
 * "reroll" the AI's move (or whether it knocks) by reloading. Persisting this
 * generator's state (a single 32-bit integer) makes the replay deterministic.
 *
 * Only AI decisions route through here. The initial deal shuffle and the joke
 * picker keep using Math.random() on purpose: the dealt board is persisted (not
 * re-shuffled) and jokes are cosmetic.
 */

let state = newSeed();

function newSeed() {
	return (Math.floor(Math.random() * 0x100000000)) >>> 0;
}

/** Reseed for a brand-new game. */
export function seed(seedValue) {
	state = (seedValue === undefined ? newSeed() : seedValue) >>> 0;
}

/** Current generator state — persisted with the saved game. */
export function getState() {
	return state;
}

/** Restore the generator state from a saved game. */
export function setState(savedState) {
	state = savedState >>> 0;
}

/** Next float in [0, 1) — drop-in replacement for Math.random(). */
export function random() {
	state = (state + 0x6D2B79F5) >>> 0;
	let t = state;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
}
