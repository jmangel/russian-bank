# Plan: Persist in-progress game across accidental refreshes

## Goal

A page refresh (or accidental tab reload / browser restart) must restore the
in-progress game exactly where the player left off, instead of dealing a brand
new board.

## Current behavior (the bug)

`app/js/app.js` runs on every page load:

```js
const game = new Game();
game.initializeGame();          // deals a fresh, shuffled board
RenderService.setupLocalStorageFields(game);
```

`initializeGame()` (`game.js:22`) always calls
`PlayboardService.initializePlayboard()`, which shuffles two decks and deals.
There is **no game-state persistence today** — only settings and statistics are
stored in `localstorage_service.js`, all under a `zp` prefix
(`zpSpeed`, `zpLevel`, `zpStatistics*`, …). A refresh discards the match.

## State model (what must be persisted)

The whole game lives in one object graph:

- `Game` (`game.js`) — scalar flags + a `Playboard`.
- `Playboard` (`entities/playboard.js`) — a JS **`Map`** `playboardMap`
  (20 `PilePosition` enum keys → `Pile`) and a **`Map`** `moveHistory`
  (move-number → `Move`).
- `Pile` (`entities/pile.js`) — `position` + an ordered array of `Card2Pile`.
- `Card2Pile` (`entities/card2pile.js`) — a `Card`, an `isFaceUp` flag, plus a
  **derived** `pictureString` and a back-reference `_pile`.
- `Card` (`entities/card.js`) — `suit`, `cardNumber`, `deckcolor`
  (all enumify enum instances).
- `Move` (`entities/move.js`) — `player`, `sourcePilePosition`,
  `targetPilePosition` (all enums).

### The serialization challenge

`JSON.stringify(game)` will **not** work directly:

1. `playboardMap` and `moveHistory` are JS `Map`s (stringify to `{}`).
2. Every card/move field is an **enumify class instance**, not a plain value.
3. There is a **circular reference**: `Pile` → `Card2Pile` → `_pile` → `Pile`.

But the graph is cheap to serialize with a small custom mapper, because:

- Every enum round-trips through `.name` ↔ `EnumClass.enumValueOf(name)`.
  The codebase already relies on this (e.g. `PilePosition.enumValueOf(idSourcePile)`
  in `game.js:211`).
- `Card2Pile._pictureString` is **derived** — `renderPlayboardCards()`
  recomputes it via `setPictureString()` on every render
  (`render_service.js:204, 234, 264, …`), so it is never persisted.
- `Card2Pile._pile` is a back-reference that can be rebuilt while
  reconstructing each pile; never persisted.

### Persisted shape (≈ a few KB)

```jsonc
{
  "version": 1,
  "scalars": {
    "identityPlayer": "PLAYER_A",
    "activePlayer": "PLAYER_A",
    "levelOfDifficulty": 0.5,
    "isGameOver": false,
    "winnerPlayer": null,
    "isInKnockedState": false,
    "isExpectedToPlayReservePileCard": false,
    "counterNumberOfWrongKnocks": 0,
    "counterNumbersOfTurnsToMiss": 0,
    "realPlayerMadeFirstMove": true,
    "intendedMoveOfArtificialIntelligence": null,   // always null at a human resting point;
                                                    // only live during a knock prompt, which we don't save
    "startTimeTs": 1718000000,                      // OMIT when undefined — _startTimeTs is unset until
                                                    // the first real move (game.js:189), so persist it
                                                    // only when realPlayerMadeFirstMove === true
    "showAcesOnCenterPilesSorted": false,
    "isTutorialMode": false
  },
  "playboard": {
    "piles": [
      { "position": "RESERVE_PILE_PLAYER_A",
        "cards": [ { "suit": "CLUBS", "cardNumber": "ACE",
                     "deckColor": "BLUE", "isFaceUp": false }, ... ] },
      ...
    ],
    // moveHistory keys are 1-based, dense, monotonic (addMoveToMoveHistory keys by size+1,
    // playboard_service.js:124-127; nothing ever deletes). Store the literal key `n` and rebuild
    // with map.set(entry.n, move) — NEVER index+1 — because the AI's knock-detection reads
    // moveHistory.get(size) and iterates by numeric key (ai_service.js:132-193).
    "moveHistory": [
      { "n": 1, "player": "PLAYER_A",
        "source": "RESERVE_PILE_PLAYER_A", "target": "RESERVE_PILE_PLAYER_A" },
      ...
    ]
  }
}
```

> `identityPlayer` is always `PLAYER_A` in this single-player build (`game.js:27`);
> persisting it is harmless but never varies. `levelOfDifficulty` should round-trip
> as a **number** (the live value can be a string via `$(this).val()`,
> `render_service.js:819`).

## Decisions

### 1. Storage mechanism → **localStorage**

- Already the app's persistence layer; synchronous API matches the synchronous
  game loop (no async refactor); ~5 MB ≫ our few-KB blob; survives refresh
  **and** full browser restart.
- Rejected: `sessionStorage` (lost on tab close), `IndexedDB` (async overkill),
  URL hash (fragile/ugly), cookies (4 KB, sent to server), server-side (app is a
  static client bundle — the only backend hook is commented-out PHP at
  `game.js:157`).
- Key: `zpSavedGame`, to match the existing `zp` convention.

### 2. When to save → **Option A+ (resting points + AI-handoff boundary)**

Save the logical state at two kinds of points:

1. **Clean human resting points** — at the end of `renderPlayboard` when
   `activePlayer === identityPlayer && !isGameOver && !isInKnockedState`.
   This covers the initial deal, every mid-turn human sub-move that keeps
   control, reserve-card flips, and the state after the AI hands control back.
   All of these are **fully reconstructable from logical state**.

2. **The AI-handoff boundary** — the instant a human move ends the turn and
   control passes to the AI. `checkForChangeOnActivePlayer` (called inside
   `makeMove`, `playboard_service.js:83`) flips `activePlayer` to the AI
   **before** any render, so the turn-ending discard is otherwise never saved.
   We add an explicit save at the transfer point (after `makeMove` commits,
   before `letArtificialIntelligencePlay()` runs), capturing the committed
   board with `activePlayer === PLAYER_B`. This save is placed at the transfer,
   **not** inside `renderPlayboard`, so it does not fire repeatedly during the
   AI's animated multi-move turn.

**On restore**, if the saved `activePlayer` is the AI, re-run
`game.letArtificialIntelligencePlay()` to play the AI's turn fresh. The AI logic
is stateless w.r.t. animation — it reads the current board + move history and
decides — so re-running from the handoff board is correct. The AI's response is
re-randomized, but it was never shown or committed before the refresh, so
nothing is lost.

**Why not save literally mid-AI-animation?** The AI's turn is async kute.js
tweens whose logical commit happens in the completion callback
(`makeMoveAfterMoveAnimation`); a frozen mid-tween snapshot has no coherent
restore point. Re-running the AI from the handoff board yields the same end
state without reconstructing an in-flight animation/callback chain. (The only
out-of-`Game` state during a turn is `window.cardAnimation`, an in-flight kute
tween — purely visual; its logical commit lives in the animation's `complete`
callback `makeMoveAfterMoveAnimation`. On a fresh page load it does not exist,
so there is no in-flight animation to cancel.)

**Accepted gap — knock prompts.** While a knock prompt is live
(`activePlayer === DEALER`, a noty dialog open via `renderNotyPlayerKnocked` /
`renderNotyAiKnocked`, `render_service.js:1413` / `:1384`, awaiting a
`centerPileForKnockProve` click, `render_service.js:827-842`), we do not save. A refresh there rewinds to just before the
prompt. Reconstructing the live noty dialog + timers is disproportionate work
for a rare moment.

**Clear the save** on game-over (`setGameOver(true)`) and when the player
confirms **New game**.

### 3. Restore UX → **auto-resume silently**

On boot, if a valid unfinished save exists, restore it immediately — most
seamless for accidental refreshes. The existing **New game** button (which
clears the save) is the escape hatch to start fresh. No per-load prompt.

## Implementation plan

### New module: `app/js/services/game_persistence_service.js`

- `serializeGame(game)` → the plain object above. Walks `PilePosition.enumValues`
  to keep pile order stable; maps each enum to `.name`; flattens the two `Map`s.
- `deserializeGame()` → rebuilds a populated `Game`:
  - new `Playboard`, new `playboardMap` `Map` keyed by
    `PilePosition.enumValueOf(name)`, each `Pile` repopulated with `Card2Pile`s
    (reconstruct `Card` via `Suit/CardNumber/DeckColor.enumValueOf`, set
    `isFaceUp`, set `_pile` back-reference).
  - rebuild `moveHistory` `Map` (number → reconstructed `Move`).
  - restore all scalar flags via the `Game` setters.
- `saveGame(game)` / `loadGame()` / `clearSavedGame()` / `hasSavedGame()` —
  wrap `localStorage` with `try/catch` on **both** read and write. `setItem`
  can throw (QuotaExceeded / disabled / private mode); a failed save must be
  swallowed so it never aborts the render path or game loop. On JSON-parse /
  version-mismatch / integrity failure, discard the save and signal "no valid
  save" so boot falls back to a fresh deal.
- `deserializeGame` must preserve the 1-based `moveHistory` keys
  (`map.set(entry.n, move)`), since the AI knock-detection reads `.get(size)`
  and iterates numeric keys (`ai_service.js:132-193`).

### `game.js`

- Factor the post-deal wiring in `initializeGame()` (the
  `RenderService.enable*` / `setGameEventHandlers` / `renderPlayboard` /
  tutorial block, `:70–77`) into a reusable `finishSetup()` so a **restored**
  game runs the identical wiring **without** re-dealing.
- Add `persistRestableState(this)` at the end of `renderPlayboard`'s caller
  path — i.e. a guarded `saveGame` call gated on
  `activePlayer === identityPlayer && !isGameOver && !isInKnockedState`.
  (Implement the guard so it is cheap and runs after each render.)
- Add the explicit AI-handoff save at the transfer points where a human move
  sets `activePlayer` to the AI (in `onDropCardOnPile` before
  `letArtificialIntelligencePlay()`, and the analogous handoff paths in
  `makeMoveAfterMoveAnimation`).
- Call `clearSavedGame()` from `setGameOver(true)` (`:156`).

### `app.js`

**Restore ordering is load-bearing** — `setupLocalStorageFields` unconditionally
overwrites `levelOfDifficulty` from `zpLevel` (`render_service.js:100-102`) and
tutorial mode from `zpTutorialMode` (`:79-89`), and re-disables nothing. A
restored mid-game must keep its **original** level (level is locked at first
move in-game), not the latest `zpLevel`. So:

```js
const game = new Game();
if (GamePersistence.hasSavedGame()) {
    GamePersistence.restoreInto(game);          // rebuild state + finishSetup()
    if (game.getActivePlayer() === aiPlayer) {  // AI to move → resume its turn
        game.letArtificialIntelligencePlay();
    }
} else {
    game.initializeGame();
}
RenderService.setupLocalStorageFields(game);    // clobbers level/tutorial — runs first

// Re-assert restored values AFTER setupLocalStorageFields:
if (restored) {
    game.setLevelOfDifficulty(savedLevel);      // number; also sync the <select> value
    if (game.hasRealPlayerMadeFirstMove()) {    // selects are locked once play started
        RenderService.disableLevelSelect();
        RenderService.disableSortAcesOnCenterPilesChoice();
    }
}
```

### `render_service.js`

- **New game** confirm handler (`:515`/`:538`): call `clearSavedGame()` before
  `new Game()`.
- The "first move already made" UI lock — `disableLevelSelect()` +
  `disableSortAcesOnCenterPilesChoice()` (otherwise only triggered in the live
  first-move path, `game.js:204–205, 526–527`) — is replicated by the boot code
  **after** `setupLocalStorageFields` (see ordering above), because that
  function re-enables nothing and would otherwise leave the selects active.

## Edge cases handled

- **Schema versioning + corruption** — `version` field; any parse/version/
  integrity failure → discard save, deal fresh.
- **Ordering vs. `setupLocalStorageFields`** — that function re-applies
  `zpLevel` and tutorial mode *after* init (`render_service.js:100–102, 79–89`),
  clobbering restored values. Because a game's level is locked at the first move,
  a restored mid-game must keep its **original** level — so re-assert the saved
  `levelOfDifficulty` (and sync the `<select>`) **after**
  `setupLocalStorageFields` runs (see boot snippet above). Do **not** treat
  `zpLevel` as authoritative.
- **Disable selects mid-game** — see render_service note above.
- **Clear on win/loss** — so the next load starts fresh rather than restoring a
  finished game.
- **AI resume on load** — re-run `letArtificialIntelligencePlay()` when the
  saved active player is the AI.

## Evolution of the save model

- **v1 (Option A+):** save at human resting points + the AI-handoff boundary; on
  restore re-run the AI. Knock prompts were not persisted (a refresh rewound
  them); the AI re-ran with `Math.random()` (a refresh could reroll it).
- **v2 (caveats #1 & #2):** the AI's decisions are seeded (`utils/random.js`,
  state persisted) so a re-run replays **identically** — no reroll. Knock prompts
  are persisted (a `pendingPrompt` descriptor) and **re-presented** on restore so
  a refresh can neither undo a knock nor dodge a wrong-knock penalty.
- **Design B (mid-turn resume):** the board is persisted at **each AI decision
  point** (start of `letArtificialIntelligencePlay`'s AI branch), so a refresh
  during the AI's turn resumes from where it had got to instead of replaying the
  whole turn. The continuation stays deterministic via the persisted RNG state.

## Non-goals / accepted limitations

- **In-flight-move re-knock (residual).** With Design B, a refresh during the AI's
  turn settles all of the AI's *already-committed* moves (you cannot re-knock
  those), but the move that was *animating* at refresh time is not committed until
  its animation ends, so it re-animates on restore and its knock window re-opens.
  Net: you can retry a knock only on that single in-flight move. Player-favorable
  (a missed *opportunity*, not a penalty dodge); fully closing it would require
  not re-animating on restore (jump to the settled turn-end). Accepted.
- **Multi-tab** is not synchronized (last writer wins) — fine for a local
  single-player game.
- A schema-version bump **discards in-progress saves** (fresh deal); no migration.

## Performance note

The resting-point guard (`activePlayer === identityPlayer && !isGameOver &&
!isInKnockedState`) excludes every AI-turn render, so saves fire only at human
resting points — a few-KB serialize + one synchronous `localStorage.setItem`,
negligible. The one inefficiency: `moveHistory` grows unbounded over a long
game (hundreds of entries), and the resting-point save re-serializes all of it
on every human sub-move. Not dangerous, but if it matters, serialize the move
history incrementally or persist only the short tail the AI actually reads.

## Files touched

| File | Change |
|---|---|
| `app/js/services/game_persistence_service.js` | **New** — serialize/deserialize + localStorage wrappers |
| `app/js/game.js` | `finishSetup()` refactor; guarded save in render path; AI-handoff save; clear on game-over |
| `app/js/app.js` | Restore-or-init on boot; AI resume |
| `app/js/services/render_service.js` | Clear save on New game; disable selects on restore |
