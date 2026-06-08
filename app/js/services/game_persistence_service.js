import { Playboard } from "../entities/playboard";
import { Pile } from "../entities/pile";
import { Card } from "../entities/card";
import { Card2Pile } from "../entities/card2pile";
import { Move } from "../entities/move";

import { Suit } from "../enums/cardinformation/suit";
import { CardNumber } from "../enums/cardinformation/cardnumber";
import { DeckColor } from "../enums/cardinformation/deckcolor";
import { Player } from "../enums/player";
import { PilePosition } from "../enums/pileinformation/pileposition";

import * as PlayerUtils from "../utils/player_utils";
import * as RenderService from "./render_service";
import * as LocalStorageService from "./localstorage_service";

/**
 * Persists the in-progress game to localStorage so an accidental refresh (or a
 * browser restart) restores the match instead of dealing a fresh board.
 *
 * The live game graph cannot be JSON.stringify'd directly: it contains JS Maps
 * (playboardMap, moveHistory), enumify enum instances, and a circular reference
 * (Pile <-> Card2Pile._pile). We map every enum to its .name and reconstruct it
 * via EnumClass.enumValueOf(name); Card2Pile._pictureString is derived on every
 * render (RenderService.renderPlayboardCards) so it is never stored.
 *
 * Save points (Option A+): clean human resting points (saveGameIfRestable, from
 * renderPlayboard) plus the AI-handoff boundary (an explicit saveGame the moment
 * a human move ends the turn). On restore, if it is the AI's turn we re-run the
 * AI fresh — its logic is stateless w.r.t. animation. Knock prompts are the one
 * accepted gap (transient noty UI): a refresh there rewinds to just before them.
 */

const STORAGE_KEY = "zpSavedGame";
const SCHEMA_VERSION = 1;

function nameOf(enumValue) {
	return enumValue == null ? null : enumValue.name;
}

// --- serialization ------------------------------------------------------

export function serializeGame(game) {

	const playboard = game.getPlayboard();
	const playboardMap = playboard.getPlayboardMap();

	const piles = [];
	for (let pilePosition of PilePosition.enumValues) {
		const pile = playboardMap.get(pilePosition);
		const cards = pile.getCard2PileElements().map(function (card2Pile) {
			const card = card2Pile.getCard();
			return {
				suit: nameOf(card.getSuit()),
				cardNumber: nameOf(card.getCardNumber()),
				deckColor: nameOf(card.getDeckcolor()),
				isFaceUp: card2Pile.isFaceUp()
			};
		});
		piles.push({ position: pilePosition.name, cards: cards });
	}

	// moveHistory keys are 1-based, dense and monotonic; store the literal key.
	const moveHistory = [];
	playboard.getMoveHistory().forEach(function (move, n) {
		moveHistory.push({
			n: n,
			player: nameOf(move.getPlayer()),
			source: nameOf(move.getSourcePilePosition()),
			target: nameOf(move.getTargetPilePosition())
		});
	});

	const scalars = {
		identityPlayer: nameOf(game.getIdentityPlayer()),
		activePlayer: nameOf(game.getActivePlayer()),
		levelOfDifficulty: parseFloat(game.getLevelOfDifficulty()),
		isGameOver: game.isGameOver(),
		winnerPlayer: nameOf(game.getWinnerPlayer()),
		isInKnockedState: game.isInKnockedState(),
		isExpectedToPlayReservePileCard: game.isExpectedToPlayReservePileCard(),
		counterNumberOfWrongKnocks: game.getCounterNumberOfWrongKnocks(),
		counterNumbersOfTurnsToMiss: game.getCounterNumbersOfTurnsToMiss(),
		realPlayerMadeFirstMove: game.hasRealPlayerMadeFirstMove(),
		// Only live during a knock prompt, which is never a save point. Persist null.
		intendedMoveOfArtificialIntelligence: null,
		showAcesOnCenterPilesSorted: game.getShowAcesOnCenterPilesSorted(),
		isTutorialMode: game.isInTutorialMode()
	};

	// _startTimeTs has no getter and is undefined until the first real move.
	if (game.hasRealPlayerMadeFirstMove() && game._startTimeTs !== undefined) {
		scalars.startTimeTs = game._startTimeTs;
	}

	return {
		version: SCHEMA_VERSION,
		scalars: scalars,
		playboard: {
			piles: piles,
			moveHistory: moveHistory
		}
	};
}

// --- localStorage wrappers ----------------------------------------------

export function saveGame(game) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeGame(game)));
	} catch (e) {
		// Saving must never break the render path / game loop
		// (QuotaExceeded, disabled storage, private mode, ...).
	}
}

/**
 * Save only at a clean human resting point, where the board is fully
 * reconstructable from logical state. Transient AI-turn renders
 * (activePlayer = opponent / DEALER) and knock-prompt states are skipped.
 */
export function saveGameIfRestable(game) {
	if (game.getActivePlayer() === game.getIdentityPlayer()
		&& !game.isGameOver()
		&& !game.isInKnockedState()) {
		saveGame(game);
	}
}

export function clearSavedGame() {
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch (e) {
		// ignore
	}
}

/**
 * Returns the validated saved-game object, or null when there is no save or it
 * is unreadable / from an incompatible schema (in which case it is discarded so
 * boot falls back to a fresh deal).
 */
export function loadSavedGame() {
	let raw;
	try {
		raw = localStorage.getItem(STORAGE_KEY);
	} catch (e) {
		return null;
	}
	if (!raw) {
		return null;
	}
	let data;
	try {
		data = JSON.parse(raw);
	} catch (e) {
		clearSavedGame();
		return null;
	}
	if (!data || data.version !== SCHEMA_VERSION || !data.scalars || !data.playboard) {
		clearSavedGame();
		return null;
	}
	return data;
}

export function hasSavedGame() {
	return loadSavedGame() !== null;
}

// --- deserialization ----------------------------------------------------

function deserializePlayboard(data) {

	const playboard = new Playboard();
	const playboardMap = new Map();

	for (let pileData of data.piles) {
		const pilePosition = PilePosition.enumValueOf(pileData.position);
		const pile = new Pile(pilePosition, []);
		const card2PileElements = pile.getCard2PileElements();
		for (let cardData of pileData.cards) {
			const card = new Card(
				Suit.enumValueOf(cardData.suit),
				CardNumber.enumValueOf(cardData.cardNumber),
				DeckColor.enumValueOf(cardData.deckColor)
			);
			const card2Pile = new Card2Pile(card, pile);
			card2Pile.setFaceUp(cardData.isFaceUp);
			card2PileElements.push(card2Pile);
		}
		playboardMap.set(pilePosition, pile);
	}

	const moveHistory = new Map();
	for (let moveData of data.moveHistory) {
		const move = new Move();
		move.setPlayer(Player.enumValueOf(moveData.player));
		move.setSourcePilePosition(PilePosition.enumValueOf(moveData.source));
		move.setTargetPilePosition(PilePosition.enumValueOf(moveData.target));
		// Preserve the literal 1-based key: the AI's knock-detection reads
		// moveHistory.get(size) and iterates by numeric key.
		moveHistory.set(moveData.n, move);
	}

	playboard.setPlayboardMap(playboardMap);
	playboard.setMoveHistory(moveHistory);
	return playboard;
}

/**
 * Rebuild a populated Game from a saved-game object (no fresh deal) and wire up
 * rendering + event handlers via game.finishSetup().
 */
export function restoreInto(game, data) {

	const s = data.scalars;

	// _identityPlayer and the wrong-knock counter have no setters; assign directly.
	game._identityPlayer = Player.enumValueOf(s.identityPlayer);
	game._counterNumberOfWrongKnocks = s.counterNumberOfWrongKnocks;
	game._counterNumbersOfTurnsToMiss = s.counterNumbersOfTurnsToMiss;

	game.setPlayboard(deserializePlayboard(data.playboard));
	game.setActivePlayer(Player.enumValueOf(s.activePlayer));
	game.setLevelOfDifficulty(s.levelOfDifficulty);
	game.setGameOver(s.isGameOver);
	game.setWinnerPlayer(s.winnerPlayer == null ? null : Player.enumValueOf(s.winnerPlayer));
	game.setKnockedState(s.isInKnockedState);
	game.setIsExpectedToPlayReservePileCard(s.isExpectedToPlayReservePileCard);
	game.setRealPlayerMadeFirstMove(s.realPlayerMadeFirstMove);
	game.setIntendedMoveOfArtificialIntelligence(null);
	game.setShowAcesOnCenterPilesSorted(s.showAcesOnCenterPilesSorted);
	game.setTutorialMode(s.isTutorialMode);
	if (s.startTimeTs !== undefined) {
		game.setStartTime(s.startTimeTs);
	}

	// Statistics bookkeeping: a refresh resets pause tracking; game-started
	// reflects whether the first move has already been made.
	LocalStorageService.resetStatisticsPauseTimeInfo();
	LocalStorageService.setGameStarted(s.realPlayerMadeFirstMove ? 1 : 0);

	game.finishSetup();
}

/**
 * Applied AFTER RenderService.setupLocalStorageFields (which re-applies zpLevel
 * and would otherwise clobber the restored difficulty). Re-asserts the saved
 * game's level, locks the now-disabled selectors if play has started, and
 * resumes the AI's turn if it was the AI's move when the game was saved.
 */
export function applyPostSetup(game, data) {

	const s = data.scalars;

	// A game's difficulty is locked at the first move; keep the saved value
	// rather than the latest zpLevel that setupLocalStorageFields applied.
	game.setLevelOfDifficulty(s.levelOfDifficulty);

	if (s.realPlayerMadeFirstMove) {
		RenderService.disableLevelSelect();
		RenderService.disableSortAcesOnCenterPilesChoice();
	}

	// If the AI was to move when saved, resume its (re-randomized) turn.
	const aiPlayer = PlayerUtils.getOpponentPlayer(game.getIdentityPlayer());
	if (game.getActivePlayer() === aiPlayer && !game.isGameOver() && !game.isInKnockedState()) {
		game.letArtificialIntelligencePlay();
	}
}
