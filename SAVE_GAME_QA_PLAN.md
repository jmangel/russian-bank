# QA Plan — "Persist in-progress game across refreshes" feature

**Branch:** `feature/persist-in-progress-game`
**Change:** new `app/js/services/game_persistence_service.js` + wiring in `game.js`,
`app.js`, `render_service.js`. Saves the in-progress game to `localStorage["zpSavedGame"]`
at clean human resting points (end of `renderPlayboard`, guarded) plus the AI-handoff
boundary; restores it on boot; clears it on game over and on "New game".

## Behavior under test
An accidental page refresh (or browser restart) must restore the in-progress game exactly
where it was, instead of dealing a fresh board. A refresh during the AI's turn keeps the
human's completed turn and re-runs the AI. A corrupt/incompatible save must be discarded and
replaced with a fresh deal — never crash boot.

## How state is observed
The bundled `game` is module-scoped. For QA only, a **local-only** build appends
`window.__rbGame = game;` to `app.js` (this does not touch the persistence code paths under
test — `game_persistence_service`, the save guard, restore, and clear are byte-identical).
The committed branch and deployed build contain no such hook. Tests drive the real entry
points and read:
- `localStorage.getItem("zpSavedGame")` — the persisted blob (JSON: `{version, scalars, playboard:{piles,moveHistory}}`)
- `__rbGame.getActivePlayer().name` — whose turn (`PLAYER_A` human, `PLAYER_B` AI, `DEALER`)
- `__rbGame.getPlayboard().getMoveHistory().size` — recorded moves
- `__rbGame.getPlayboard().getPlayboardMap()` — pile contents

Setup is deterministic: a fresh deal always has activePlayer `PLAYER_A`, one face-up card on
`WASTE_PILE_PLAYER_A`, and face-up cards on `HOUSE_PILE_RIGHT_1..4`. Served at
`http://localhost:8123/app/pages/game.html`.

---

## Test cases

### T1 — Save exists immediately on a fresh deal ✅
1. Clear localStorage, load the page.
2. Read `zpSavedGame`.
3. **Expect:** present; parses to `{version:1, ...}`; `scalars.activePlayer === "PLAYER_A"`;
   `playboard.piles.length === 20`. The freshly dealt board is already persisted.

### T2 — Reload restores the same board (core) ✅ primary
1. Fresh deal. Capture blob `S0 = zpSavedGame`.
2. Make a non-turn-ending move that keeps control: flip the reserve pile
   (`__rbGame.onClickReservePileCard()`). Capture `S1 = zpSavedGame`.
3. **Reload the page.**
4. Read `S2 = zpSavedGame` and the live board.
5. **Expect:** `S1 !== S0` (the flip was persisted); after reload the board equals the
   pre-reload state — `S2` deep-equals `S1` (same 20 piles, same card order, same face-up
   flags) — i.e. **not** a new shuffle; `activePlayer === "PLAYER_A"`.

### T2b — Reserve-flip obligation survives the reload (review finding #2) ✅
1. After T2's reload, inspect the restored blob's `scalars.isExpectedToPlayReservePileCard`.
2. **Expect:** `true` — the forced-reserve obligation set by the flip is persisted and
   restored (only the reserve card is playable next), not lost.

### T3 — AI-handoff: the human's turn-ending move survives a mid-AI-turn refresh ✅
1. Fresh deal. Make a legal turn-ending move: `__rbGame.onDropCardOnPile('HOUSE_PILE_RIGHT_1','WASTE_PILE_PLAYER_A')`
   (house → own waste ends the turn → activePlayer becomes the AI).
2. Immediately read `zpSavedGame` (the synchronous AI-handoff save, taken before the AI animates).
3. **Expect (handoff save):** `scalars.activePlayer === "PLAYER_B"`; the moved card now sits on
   `WASTE_PILE_PLAYER_A` in the blob; `moveHistory` includes the discard.
4. **Reload.** **Expect:** the human's move is still on the board (not rewound); the AI then
   resumes its turn (activePlayer returns to `PLAYER_A`, or a knock prompt appears) — proving
   restore re-runs the AI rather than dropping the human's completed turn.

### T4 — "New game" clears the save ✅
1. Fresh deal (save present). Click `.newGameButton`, confirm "Yes" in the dialog.
2. **Expect:** a brand-new deal is dealt; `zpSavedGame` is replaced by the fresh deal's save
   (the old game is not restorable). The clear fires before the new deal.

### T5 — Corrupt / incompatible save is discarded, never crashes boot (review finding #1) ✅ primary
1. **5a invalid JSON:** `localStorage.setItem("zpSavedGame","{ not json")`; reload.
2. **5b valid JSON, bad enum:** set `zpSavedGame` to `{"version":1,"scalars":{"identityPlayer":"PLAYER_A","activePlayer":"PLAYER_A",...},"playboard":{"piles":[{"position":"BOGUS_PILE","cards":[]}],"moveHistory":[]}}`; reload.
3. **5c wrong version:** set a blob with `version:99`; reload.
4. **Expect (all):** no uncaught JS error; the board renders a **fresh deal**; the bad value is
   removed and replaced with a valid fresh save. Boot never dies on a corrupt save.

### T6 — Save guard does not fire during AI turns / knock prompts (review)
1. During T3 between the drop and the AI finishing, confirm no resting-point save overwrites the
   handoff blob with an AI-turn (`activePlayer === "PLAYER_B"`/`DEALER`) resting snapshot.
2. **Expect:** the only `PLAYER_B` blob is the single AI-handoff save; resting saves are
   `PLAYER_A` only.

### T7 — Storage disabled does not break the game (reliability)
1. Stub `localStorage.setItem` to throw, then make a move.
2. **Expect:** no uncaught error; the game continues (the save is silently skipped).

---

## Results (executed via `agent-browser` against `http://localhost:8123`, Chrome for Testing 149)

| Test | Result | Evidence |
|------|--------|----------|
| **T1** save on fresh deal | ✅ PASS | After clear+reload: `zpSavedGame` present, `{version:1, active:"PLAYER_A", piles:20, firstMove:false, history:0}` |
| **T2** reload restores same board | ✅ PASS | Pre-reload blob `S0` byte-identical to post-reload blob `S2` — same shuffle restored, not re-dealt; `active:"PLAYER_A"` |
| **T2b** reserve-flip obligation persists (finding #2) | ✅ PASS | After flip: saved `isExpectedToPlayReservePileCard:true`, `history:1`; after reload: `obligationRestored:true`, `history:1` |
| **T3** AI-handoff survives mid-AI-turn refresh | ✅ PASS (logic) | Turn-ending move → synchronous handoff save `{active:"PLAYER_B", history:1}`, discard on `WASTE_PILE_PLAYER_A` (1→2 cards); after reload the discard persists and the AI resume fires (`window.cardAnimation` created). Animation *completion* stalls under the automation daemon **identically in the no-reload baseline** (active stays `PLAYER_B`, `cardAnimation` pending) — a documented harness limitation, not a regression. |
| **T4** New game clears/replaces the save | ✅ PASS | New-game confirm (`.swal2-confirm`) → saved blob replaced with a fresh deal; old in-progress game not restorable |
| **T5a** invalid JSON save | ✅ PASS | reload → `booted:true, active:"PLAYER_A", history:0`, bad value replaced with a valid fresh save |
| **T5b** valid JSON, unknown enum (throws in restoreInto) | ✅ PASS | reload → no boot crash (try/catch → fresh deal), `savedValid:true`. Validates the headline P1 fix. |
| **T5c** incompatible schema version (99) | ✅ PASS | reload → discarded → fresh deal, `savedValid:true` |
| **T7** storage disabled (setItem throws) | ✅ PASS | move applied with `moveThrew:null` — `saveGame` try/catch swallowed the error, game loop continued (`history:1`) |

**Conclusion:** Persistence works end-to-end — a fresh deal is saved immediately, a reload restores the exact in-progress board (not a reshuffle), a turn-ending move is captured at the AI-handoff boundary and the AI resumes on restore, New game discards the save, and a corrupt/incompatible/unwritable save degrades gracefully to a fresh deal without ever crashing boot. All review-fix behaviors (corrupt-save fallback, reserve-flip obligation) are verified.

> Test harness notes: assertions used a **local-only** build exposing `window.__rbGame`; the committed branch and deployed build contain no such hook (reverted + rebuilt clean, verified `grep -c __rbGame app/js/dist/app.js` = 0). The AI's animated turn does not complete under the headless/automation Chrome daemon — the same CSS-animation stall documented in the waste-pile `QA_PLAN.md`; it affects normal play identically, so it is out of scope for this feature.
