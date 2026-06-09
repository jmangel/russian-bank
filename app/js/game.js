import {Player} from "./enums/player";
import {Move} from "./entities/move";
import {PilePosition} from "./enums/pileinformation/pileposition";
import {PileType} from "./enums/pileinformation/piletype";

import * as PlayboardUtils from "./utils/playboard_utils";
import * as PileUtils from "./utils/pile_utils";
import * as PlayerUtils from "./utils/player_utils";
import * as MoveUtils from "./utils/move_utils";
import * as AiUtils from "./utils/ai_utils";

import * as AiConfig from "./config/ai_config";

import * as PlayboardService from "./services/playboard_service";
import * as RenderService from "./services/render_service";
import * as AiService from "./services/ai_service";
import * as TutorialService from "./services/tutorial_service";
import * as LocalStorageService from "./services/localstorage_service";
import * as GamePersistence from "./services/game_persistence_service";
import * as Rng from "./utils/random";

// Knock-prompt descriptor types, persisted so an open prompt is re-presented on
// restore (a refresh must not undo a knock or dodge its penalty). The string
// values are part of the saved-game schema — keep in sync with the validation
// list in game_persistence_service.
const PROMPT_AI_KNOCKED_YOU = "AI_KNOCKED_YOU";
const PROMPT_YOU_KNOCKED_AI = "YOU_KNOCKED_AI";
const PROMPT_KNOCK_JUSTIFIED = "KNOCK_JUSTIFIED";

export class Game {
	
	initializeGame() {
		
		// Describes the identity of the player the playboard is rendered for.
		// Note that this must not necessarily be the activePlayer of the playboard!
		// (activePlayer = whose turn is it?, identityPlayer = who is watching the playboard?)
		this._identityPlayer = Player.PLAYER_A;
		
		// Describes if the player has the obligation to play a card from his reserve pile in the next move.
		// Is used to make all other cards undraggable while this attribute is set to true.
		this._isExpectedToPlayReservePileCard = false;
		
		// When the AI is playing always store it's currently intended move (the move for which the AI decided in
		// letArtificialIntelligencePlay()) in this variable. In this way we are able to check if a knocking of
		// the identity player was justified.
		this._intendedMoveOfArtificialIntelligence = null;
		
		// Counts the number of wrong knocks by the identity player
		this._counterNumberOfWrongKnocks = 0;
		
		// Counts the number of turns the identityPlayer has to miss when he knocked unjustified too many times.
		this._counterNumbersOfTurnsToMiss = 0;
		
		// The value between 0 and 1 representing the difficulty of a game against the AI. 0 = very easy. 1 = very difficult.
		this._levelOfDifficulty = 0.5;
		
		this._isGameOver = false;
		this._winnerPlayer = null;
		this._activePlayer = Player.PLAYER_A;
		this._isInKnockedState = false;

		// Descriptor of an open knock prompt (null when none) so it can be
		// persisted and re-presented on restore. See rerenderPendingPrompt().
		this._pendingPrompt = null;

		this._isTutorialMode = false;
		if (LocalStorageService.getTutorialMode() === "true") {
			this._isTutorialMode = true;
		}
		
		// Fresh deterministic-RNG seed for this game; its state is persisted so a
		// refresh replays the AI's decisions identically (no reroll).
		Rng.seed();

		this._playboard = PlayboardService.initializePlayboard();

		this._realPlayerMadeFirstMove = false;

		this._showAcesOnCenterPilesSorted = false;
		if (LocalStorageService.getShowAcesOnCenterPileSorted() === "true") {
			this._showAcesOnCenterPilesSorted = true;
		}

		LocalStorageService.resetStatisticsPauseTimeInfo();
		// Game should be treated as started only after the real player made his first move:
		LocalStorageService.setGameStarted(0);

		this.finishSetup();
	}

	/**
	 * Wire up rendering and event handlers for the current playboard. Shared by
	 * a freshly dealt game (initializeGame) and a game restored from localStorage
	 * (GamePersistence.restoreInto), so a restore runs the identical setup without
	 * re-dealing.
	 */
	finishSetup(enableSelects = true) {
		// A freshly dealt game enables the difficulty/sort selectors; a restored
		// mid-game (play already started) keeps them locked, avoiding an
		// enable-then-disable oscillation on boot.
		if (enableSelects) {
			RenderService.enableLevelSelect();
			RenderService.enableSortAcesOnCenterPilesChoice();
		} else {
			RenderService.disableLevelSelect();
			RenderService.disableSortAcesOnCenterPilesChoice();
		}
		RenderService.setGameEventHandlers(this);
		RenderService.renderPlayboard(this);

		if (this.isInTutorialMode()) {
			this.showBestMoveForTutorialMode();
		}
	}

	isInTutorialMode() {
		return this._isTutorialMode;
	}
	
	setTutorialMode(isTutorial) {
		this._isTutorialMode = isTutorial;
	}

	getShowAcesOnCenterPilesSorted() {
		return this._showAcesOnCenterPilesSorted;
	}

	setShowAcesOnCenterPilesSorted(bFlag) {
		this._showAcesOnCenterPilesSorted = bFlag;
	}

	hasRealPlayerMadeFirstMove() {
		return this._realPlayerMadeFirstMove;
	}

	setRealPlayerMadeFirstMove(bMoveMade) {
		this._realPlayerMadeFirstMove = bMoveMade;
	}

	resetCounterNumbersOfTurnsToMiss() {
		this._counterNumbersOfTurnsToMiss = 0;
	}
	
	incrementCounterNumbersOfTurnsToMiss() {
		this._counterNumbersOfTurnsToMiss++;
	}
	
	decrementCounterNumbersOfTurnsToMiss() {
		this._counterNumbersOfTurnsToMiss--;
	}
	
	getCounterNumbersOfTurnsToMiss() {
		return this._counterNumbersOfTurnsToMiss;
	}
	
	getCounterNumberOfWrongKnocks() {
		return this._counterNumberOfWrongKnocks;
	}
	
	incrementCounterNumberOfWrongKnocks() {
		this._counterNumberOfWrongKnocks++;
	}
	
	getIntendedMoveOfArtificialIntelligence() {
		return this._intendedMoveOfArtificialIntelligence;
	}
	
	setIntendedMoveOfArtificialIntelligence(intendedMove) {
		this._intendedMoveOfArtificialIntelligence = intendedMove;
	}
	
	isExpectedToPlayReservePileCard() {
		return this._isExpectedToPlayReservePileCard;
	}
	
	setIsExpectedToPlayReservePileCard(isExpected) {
		this._isExpectedToPlayReservePileCard = isExpected;
	}
	
	isInKnockedState() {
		return this._isInKnockedState;
	}
	
	setKnockedState(isKnocked) {
		this._isInKnockedState = isKnocked;
		// A knock prompt is only meaningful while knocked; clearing it here covers
		// every knock-resolution path (they all call setKnockedState(false)).
		if (!isKnocked) {
			this._pendingPrompt = null;
		}
	}

	getPendingPrompt() {
		return this._pendingPrompt;
	}

	setPendingPrompt(pendingPrompt) {
		this._pendingPrompt = pendingPrompt;
	}

	/**
	 * Record + persist an open "the AI knocked you" prompt so a refresh re-presents
	 * it (the mistake and its penalty cannot be undone by reloading). Shared by the
	 * three AI-knock entry points (drag, reserve flip, waste/reserve change).
	 */
	_openAiKnockPrompt(move, backwardMove, forgottenMandatoryMoves) {
		// forgottenMandatoryMoves is persisted (not recomputed on restore): it is
		// computed here for the human player, but on restore the active player is
		// DEALER, for whom recomputing would dereference a non-existent pile.
		this.setPendingPrompt({
			type: PROMPT_AI_KNOCKED_YOU,
			move: move,
			backwardMove: backwardMove,
			forgottenMandatoryMoves: forgottenMandatoryMoves
		});
		GamePersistence.saveGame(this);
	}

	/**
	 * Re-show the knock prompt that was open when the game was saved, so an
	 * accidental refresh cannot undo a knock or dodge its penalty. Called from
	 * GamePersistence.applyPostSetup on restore. Returns true if a prompt was
	 * presented (so the caller skips the normal AI-resume path).
	 */
	rerenderPendingPrompt() {
		const prompt = this.getPendingPrompt();
		if (!prompt) {
			return false;
		}
		if (prompt.type === PROMPT_AI_KNOCKED_YOU) {
			RenderService.renderNotyAiKnocked(this, prompt.backwardMove, prompt.forgottenMandatoryMoves || [], prompt.move);
			return true;
		}
		if (prompt.type === PROMPT_KNOCK_JUSTIFIED) {
			RenderService.renderNotyKnockJustified(this, prompt.backwardMove);
			return true;
		}
		if (prompt.type === PROMPT_YOU_KNOCKED_AI) {
			// renderNotyPlayerKnocked dereferences the AI's intended move; if a
			// corrupt save left it null, abandon the knock rather than crash.
			if (!this.getIntendedMoveOfArtificialIntelligence()) {
				this.setKnockedState(false);
				return false;
			}
			RenderService.renderNotyPlayerKnocked(this);
			return true;
		}
		return false;
	}

	isGameOver() {
		return this._isGameOver;
	}
	
	setGameOver(isGameOver) {
		// $.ajax({
		// 	type: "POST",
		// 	url: "../php/cntFinishedGames.php"
		// });
		this._isGameOver = isGameOver;
	}
	
	getWinnerPlayer() {
		return this._winnerPlayer;
	}
	
	setWinnerPlayer(winnerPlayer) {
		this._winnerPlayer = winnerPlayer;
	}
	
	getActivePlayer() {
		return this._activePlayer;
	}
	
	setActivePlayer(activePlayer) {
		this._activePlayer = activePlayer;
	}
	
	getPlayboard() {
		return this._playboard;
	}
	
	setPlayboard(playboard) {
		this._playboard = playboard;
	}

	setStartTime(tsStarttime) {
		this._startTimeTs = tsStarttime;
	}
	
	/**
	 * Called when the real player (not the AI) drops a draggable card on a pile.
	 */
	onDropCardOnPile(idSourcePile, idTargetPile) {

		// After the first card drop of the real player the duration of the game is measured and
		// the level selection and the checkbox to choose if aces should be shown on the
		// center piles are disabled.
		if (!this.hasRealPlayerMadeFirstMove())	{
			let tsNow = Math.floor(new Date().getTime() / 1000);
			this.setStartTime(tsNow);
			LocalStorageService.setGameStarted(1);
			RenderService.disableLevelSelect();
			RenderService.disableSortAcesOnCenterPilesChoice();
			this.setRealPlayerMadeFirstMove(true);
		}

		const intendedMove = new Move();
		intendedMove.setPlayer(this.getActivePlayer());
		intendedMove.setSourcePilePosition(PilePosition.enumValueOf(idSourcePile));
		intendedMove.setTargetPilePosition(PilePosition.enumValueOf(idTargetPile));
		
		// Player wants to make a move which is allowed based on the rules of the game:
		if (PlayboardUtils.isMoveAllowed(this, intendedMove, true)) {
			
			// Check if intended move gives the AI the right to knock (must be checked before makeMove() is called!):
			let isMoveKnockableByArtificialIntelligence = false;
			let forgottenMandatoryMoves = [];
			
			isMoveKnockableByArtificialIntelligence = AiUtils.isMoveKnockable(intendedMove, this, true);
			if (isMoveKnockableByArtificialIntelligence) {
				// Catch current mandatory moves to highlight them later in the playingfield with red frame:
				forgottenMandatoryMoves = PlayboardUtils.getForgottenMandatoryMovesToHightlight(this);
			}
			
			// Check if the AI will "forget" to knock:
			let forgetToKnock = true;
			const randomNumberForgetToKnock = Rng.random();
			if (randomNumberForgetToKnock <= AiUtils.getProbability(this.getLevelOfDifficulty(), AiConfig.PROBABILITY_TO_KNOCK)) {
				forgetToKnock = false;
			}

			if (isMoveKnockableByArtificialIntelligence && !forgetToKnock) {
				this.setKnockedState(true);
			}
			
			PlayboardService.makeMove(this, intendedMove, true);
			
			// Free user from obligation of playing the topmost card of the source pile if he did exactly this with the last move:
			if (this.isExpectedToPlayReservePileCard() && PilePosition.enumValueOf(idSourcePile).getPileType() === PileType.RESERVE) {
				this.setIsExpectedToPlayReservePileCard(false);
			}
			
			// AI knocks:
			if (isMoveKnockableByArtificialIntelligence && !forgetToKnock) {
				this.setActivePlayer(Player.DEALER);
				const backwardMove = MoveUtils.createBackwardMove(intendedMove, true);
				RenderService.renderPlayboard(this); // Render playboard before calling renderNotyAiKnocks to avoid optical "jumps" of the card which has to be moved backwards.
				this._openAiKnockPrompt(intendedMove, backwardMove, forgottenMandatoryMoves);
				RenderService.renderNotyAiKnocked(this, backwardMove, forgottenMandatoryMoves, intendedMove);
			}
			// No knocking, go on:
			else {
				// If the active player changed and opponent is the AI, let the AI
				// play. letArtificialIntelligencePlay persists the board at each of
				// its decision points (starting with this handoff), so an accidental
				// refresh resumes the AI's turn where it left off.
				if (!(intendedMove.getPlayer() == this.getActivePlayer())) {
					this.letArtificialIntelligencePlay();
				}
				else {
					RenderService.renderPlayboard(this);
				}
			}
		}
		// Player tried to make a move which is not allowed based on the rules of the game:
		else {
			// Note: Special rule if player moved card from his own reserve pile to his own reserve pile. No warning and highlighting stuff in this case.
			if (!(intendedMove.getSourcePilePosition() == intendedMove.getTargetPilePosition()
					&& intendedMove.getSourcePilePosition() == PileUtils.getReservePilePositionOfPlayer(intendedMove.getPlayer()))) {
				
				this.setActivePlayer(Player.DEALER);
				PlayboardService.makeMove(this, intendedMove, false);
				const backwardMove = MoveUtils.createBackwardMove(intendedMove, false);
				RenderService.renderPlayboard(this); // Render playboard before calling renderNotyMoveNotAllowed to avoid optical "jumps" of the card which has to be moved backwards.
				RenderService.renderNotyMoveNotAllowed(this, backwardMove);
			}
		}
		
		if (this.isInTutorialMode()) {
			this.showBestMoveForTutorialMode();
		}
	}
	
	onClickReservePileCard() {
		
		const intendedMove = new Move();
		intendedMove.setPlayer(this.getIdentityPlayer());
		intendedMove.setSourcePilePosition(PileUtils.getReservePilePositionOfPlayer(this.getIdentityPlayer()));
		intendedMove.setTargetPilePosition(PileUtils.getReservePilePositionOfPlayer(this.getIdentityPlayer()));
		
		// Check if intended move gives the AI the right to knock (must be checked before uncoverTopCardOfReservePile() is called!):
		let isMoveKnockableByArtificialIntelligence = false;
		let forgottenMandatoryMoves = [];
		isMoveKnockableByArtificialIntelligence = AiUtils.isMoveKnockable(intendedMove, this, true);
		if (isMoveKnockableByArtificialIntelligence) {
			// Catch current mandatory moves to highlight them later in frontend with red frame:
			forgottenMandatoryMoves = PlayboardUtils.getForgottenMandatoryMovesToHightlight(this);
		}
		
		PlayboardService.uncoverTopCardOfReservePile(this.getPlayboard(), this.getIdentityPlayer());
		RenderService.renderPlayboard(this);
		
		let forgetToKnock = true;
		const randomNumberForgetToKnock = Rng.random();
		if (randomNumberForgetToKnock <= AiUtils.getProbability(this.getLevelOfDifficulty(), AiConfig.PROBABILITY_TO_KNOCK)) {
			forgetToKnock = false;
		}
		
		if (isMoveKnockableByArtificialIntelligence && !forgetToKnock) {
			this.setActivePlayer(Player.DEALER);
			const backwardMove = MoveUtils.createBackwardMove(intendedMove, true);
			this._openAiKnockPrompt(intendedMove, backwardMove, forgottenMandatoryMoves);
			RenderService.renderNotyAiKnocked(this, backwardMove, forgottenMandatoryMoves, intendedMove);
		}
		else {
			this.setIsExpectedToPlayReservePileCard(true);
			// Re-save now that the reserve-card obligation is set: the render above
			// persisted the flip with the flag still false, which would lose the
			// obligation on restore.
			GamePersistence.saveGameIfRestable(this);
		}

		if (this.isInTutorialMode()) {
			this.showBestMoveForTutorialMode();
		}
	}

	onClickChangeWastePileAndReservePileIcon() {
		const intendedMove = new Move();
		intendedMove.setPlayer(this.getIdentityPlayer());
		intendedMove.setSourcePilePosition(PileUtils.getWastePilePositionOfPlayer(this.getIdentityPlayer()));
		intendedMove.setTargetPilePosition(PileUtils.getReservePilePositionOfPlayer(this.getIdentityPlayer()));
		
		// Check if intended move gives the AI the right to knock (must be checked before moveCardsFromWastePileToReservePile() is called!):
		let isMoveKnockableByArtificialIntelligence = false;
		let forgottenMandatoryMoves = [];
		
		isMoveKnockableByArtificialIntelligence = AiUtils.isMoveKnockable(intendedMove, this, true);
		if (isMoveKnockableByArtificialIntelligence) {
			// Catch current mandatory moves to highlight them later in frontend with red frame:
			forgottenMandatoryMoves = PlayboardUtils.getForgottenMandatoryMovesToHightlight(this);
		}
		
		let forgetToKnock = true;
		const randomNumberForgetToKnock = Rng.random();
		if (randomNumberForgetToKnock <= AiUtils.getProbability(this.getLevelOfDifficulty(), AiConfig.PROBABILITY_TO_KNOCK)) {
			forgetToKnock = false;
		}
		
		if (isMoveKnockableByArtificialIntelligence && !forgetToKnock) {
			
			this.moveCardsFromWastePileToReservePile(this.getIdentityPlayer(), true);
			
			this.setActivePlayer(Player.DEALER);
			const backwardMove = new Move();
			backwardMove.setPlayer(Player.DEALER);
			backwardMove.setSourcePilePosition(PileUtils.getWastePilePositionOfPlayer(this.getIdentityPlayer()));
			backwardMove.setTargetPilePosition(PileUtils.getWastePilePositionOfPlayer(this.getIdentityPlayer()));

			this._openAiKnockPrompt(intendedMove, backwardMove, forgottenMandatoryMoves);
			RenderService.renderNotyAiKnocked(this, backwardMove, forgottenMandatoryMoves, intendedMove);
		}
		else {
			this.moveCardsFromWastePileToReservePile(this.getIdentityPlayer(), false);
			RenderService.renderPlayboard(this);
		}
		
		if (this.isInTutorialMode()) {
			this.showBestMoveForTutorialMode();
		}
	}
	
	onClickOfKnockButton() {
		this.setKnockedState(true);
		// Persist the open "prove your knock" prompt so a refresh re-presents it
		// rather than silently abandoning the knock (which would dodge the
		// wrong-knock penalty).
		this.setPendingPrompt({type: PROMPT_YOU_KNOCKED_AI, move: null, backwardMove: null});
		GamePersistence.saveGame(this);
		RenderService.renderNotyPlayerKnocked(this);
	}
	
	getHighlightedCenterPileToClickInKnockState() {
		const isMoveKnockable = AiUtils.isMoveKnockable(this.getIntendedMoveOfArtificialIntelligence(), this, false);
		if (isMoveKnockable) {
			const mandatoryMoves = PlayboardUtils.getMandatoryMoves(this, false);
			if (mandatoryMoves.length > 0) {
				return mandatoryMoves[0].getTargetPilePosition().name;
			}
		}
		return false;
	}
	
	onClickOfKnockHighlightedCenterPile(clickedCenterPile, playerPossiblyClickedTooLate) {
		
		let knockIsJustified = false;

		// Is move knockable based on current mandatory moves of the AI?
		const isMoveKnockable = AiUtils.isMoveKnockable(this.getIntendedMoveOfArtificialIntelligence(), this, false);
		if (isMoveKnockable) {
			const mandatoryMoves = PlayboardUtils.getMandatoryMoves(this, false);

			for (let mandatoryMove of mandatoryMoves) {
				if (mandatoryMove.getTargetPilePosition().name == clickedCenterPile) {
					knockIsJustified = true;
					break;
				}
			}
		}

		// Is move knockable because the AI played a card to the waste pile of the real player
		// in a move before (last move) instead of playing it to a center pile?
		// This situation is not captured by the regular mandatory moves because the card on the waste pile
		// of the real player is now not within the allowed moves of the AI any more - a player
		// can't pull cards from the waste pile of the opponent.
		if (!knockIsJustified) {
			const forgottenMandatoryWastePileMove = PlayboardUtils.getForgottenMandatoryWastePileMoveOfTheAi(this);
			if (forgottenMandatoryWastePileMove) {
				if (forgottenMandatoryWastePileMove.getTargetPilePosition().name == clickedCenterPile) {
					knockIsJustified = true;
				}
			}
		}

		// Must be called AFTER the check if knock was justified:
		PlayboardService.makeMove(this, this.getIntendedMoveOfArtificialIntelligence(), true);
		
		if (knockIsJustified) {
			this.setActivePlayer(Player.DEALER);
			const backwardMove = MoveUtils.createBackwardMove(this.getIntendedMoveOfArtificialIntelligence(), true);
			// The YOU_KNOCKED_AI prompt is consumed (the AI move was applied above).
			// Persist the justified resolution so a refresh re-presents it (and does
			// not re-run the AI move via the stale prompt).
			this.setPendingPrompt({type: PROMPT_KNOCK_JUSTIFIED, move: null, backwardMove: backwardMove});
			GamePersistence.saveGame(this);
			RenderService.renderNotyKnockJustified(this, backwardMove);
		}
		else {
			this.incrementCounterNumberOfWrongKnocks();
			let playerHasTooManyWrongKnocks = false;
			// Every time the player reached a number of wrong knocks that can be divided by 3 he has to miss a turn:
			if (this.getCounterNumberOfWrongKnocks() % 3 == 0) {
				playerHasTooManyWrongKnocks = true;
				this.incrementCounterNumbersOfTurnsToMiss();
			}

			// Persist the committed wrong-knock penalty immediately (clearing the
			// prompt) so a refresh during the "wrong knock" message cannot roll it
			// back for a free retry. The resolved state resumes correctly on load
			// (AI continues, or it is the player's turn).
			this.setKnockedState(false);
			if (!this.isGameOver()) {
				GamePersistence.saveGame(this);
			}

			RenderService.renderNotyKnockNotJustified(this, playerHasTooManyWrongKnocks, playerPossiblyClickedTooLate);
		}
	}
	
	animateMove(move, wasKnockedByArtificialIntelligence, wasKnockedByIdentityPlayer, isDisallowedBackwardMove, forgottenMandatoryMoves, intendedMove) {
		RenderService.renderPlayboard(this);
		RenderService.animateMove(this, move, wasKnockedByArtificialIntelligence, wasKnockedByIdentityPlayer, isDisallowedBackwardMove, forgottenMandatoryMoves, intendedMove);
	}
	
	/**
	 * Update the playboard after the animation of a move was proceeded.
	 */
	makeMoveAfterMoveAnimation(idSourcePile, idTargetPile, wasKnockedByArtificialIntelligence, wasKnockedByIdentityPlayer, isDisallowedBackwardMove) {
		
		const move = new Move();
		move.setSourcePilePosition(PilePosition.enumValueOf(idSourcePile));
		move.setTargetPilePosition(PilePosition.enumValueOf(idTargetPile));
		
		if (wasKnockedByArtificialIntelligence || wasKnockedByIdentityPlayer) {
			move.setPlayer(Player.DEALER);
		} else if (isDisallowedBackwardMove) {
			move.setPlayer(this.getIdentityPlayer());
		} else {
			move.setPlayer(this.getActivePlayer());
		}
		
		// Check if active player has to change...
		// ... from dealer to identity player:
		if (isDisallowedBackwardMove) {
			PlayboardService.makeMove(this, move, false);
			this.setActivePlayer(this.getIdentityPlayer());
		}
		// ... from dealer to AI:
		else if (wasKnockedByArtificialIntelligence) {
			PlayboardService.makeMove(this, move, true);
			this.setActivePlayer(PlayerUtils.getOpponentPlayer(this.getIdentityPlayer()));
		}
		// ... from dealer to identity player:
		else if (wasKnockedByIdentityPlayer) {
			PlayboardService.makeMove(this, move, true);
			this.setActivePlayer(this.getIdentityPlayer());
		}
		// ... normal move (no disallow and no knocking)
		else {
			PlayboardService.makeMove(this, move, true);
		}
		
		// Special rule: If identity player now knocked wrong three times he has
		// to miss a turn and the AI goes on with the game:
		if (this.getActivePlayer() == this.getIdentityPlayer() && this.getCounterNumbersOfTurnsToMiss() > 0) {
			
			this.setActivePlayer(PlayerUtils.getOpponentPlayer(this.getIdentityPlayer()));
			this.decrementCounterNumbersOfTurnsToMiss();
			
			RenderService.renderNotyTurnToMiss(this);
			return;
		}
		
		if (!(this.getIdentityPlayer() == this.getActivePlayer())) {
			// No persistence save here on purpose: this hands control to the AI
			// either mid-multi-move turn (re-run fresh from the last clean save on
			// restore) or out of a resolved knock (the accepted knock-prompt gap).
			// Only the human turn-ending handoff in onDropCardOnPile is persisted.
			this.letArtificialIntelligencePlay();
		}
		else {
			// Playboard must be rendered after the AI finished its turn, so that the real player can start to play:
			RenderService.renderPlayboard(this);
		}
	}

	getIdentityPlayer() {
		return this._identityPlayer;
	}

	setIdentityPlayer(identityPlayer) {
		this._identityPlayer = identityPlayer;
	}

	getStartTime() {
		return this._startTimeTs;
	}

	setCounterNumberOfWrongKnocks(counter) {
		this._counterNumberOfWrongKnocks = counter;
	}

	setCounterNumbersOfTurnsToMiss(counter) {
		this._counterNumbersOfTurnsToMiss = counter;
	}

	getLevelOfDifficulty() {
		return this._levelOfDifficulty;
	}
	
	setLevelOfDifficulty(levelOfDifficulty) {
		this._levelOfDifficulty = levelOfDifficulty;
	}
	
	moveCardsFromWastePileToReservePile(player, isKnockedMove) {
		return PlayboardService.moveCardsFromWastePileToReservePile(this.getPlayboard(), player, isKnockedMove);
	}
	
	uncoverTopCardOfReservePile(player) {
		return PlayboardService.uncoverTopCardOfReservePile(this.getPlayboard(), player);
	}
	
	letArtificialIntelligencePlay() {

		// If the real player did not already drop his first card
		// and the AI starts to play this means the real player
		// was knocked at his first move.
		// Let the game begin then!
		if (!this.hasRealPlayerMadeFirstMove())	{
			let tsNow = Math.floor(new Date().getTime() / 1000);
			this.setStartTime(tsNow);
			LocalStorageService.setGameStarted(1);
			RenderService.disableLevelSelect();
			RenderService.disableSortAcesOnCenterPilesChoice();
			this.setRealPlayerMadeFirstMove(true);
		}

		RenderService.renderPlayboard(this);
		if (!this.isGameOver() && PlayerUtils.getOpponentPlayer(this.getIdentityPlayer()) == this.getActivePlayer()) {
			// Persist the committed board at each AI decision point, so an accidental
			// refresh resumes the AI's turn from where it had got to rather than
			// replaying it from the start. The continuation is deterministic because
			// the RNG state is saved with it. This point is reached from the human
			// handoff and after every committed AI sub-move (an animated move via
			// makeMoveAfterMoveAnimation, a non-animated sub-move via recursion).
			GamePersistence.saveGame(this);
			AiService.letArtificialIntelligencePlay(this);
		}
	}
	
	showBestMoveForTutorialMode() {
		if (this.getActivePlayer() == Player.PLAYER_A) {
			const bestMove = TutorialService.getBestMove(this);
			RenderService.highlightBestMoveForTutorialMode(this, bestMove);
		}
	}
	
	getPercentOfCardsLeft(player) {
		
		const wastePileOfPlayer = this.getPlayboard().getPlayboardMap().get(PileUtils.getWastePilePositionOfPlayer(player));
		const numberOfCardsOnWastePile = wastePileOfPlayer.getCard2PileElements().length;
		
		const reservePileOfPlayer = this.getPlayboard().getPlayboardMap().get(PileUtils.getReservePilePositionOfPlayer(player));
		const numberOfCardsOnReservePile = reservePileOfPlayer.getCard2PileElements().length;
		
		const numberOfCardsOverall = numberOfCardsOnWastePile + numberOfCardsOnReservePile;
		
		const numberOfCardsThePlayersStartWith = 48;
		
		const percentOfCards = numberOfCardsOverall * 100 / numberOfCardsThePlayersStartWith;
		
		return Math.min(100, percentOfCards);
	}
	
	/**
	 * Change active player if active player has finished his turn by pushing a
	 * card on his own waste pile.
	 * @param move the last move that was made.
	 */
	checkForChangeOnActivePlayer(move) {
		if (move.getTargetPilePosition() == PileUtils.getWastePilePositionOfPlayer(move.getPlayer())) {
			this.setActivePlayer(PlayerUtils.getOpponentPlayer(move.getPlayer()));
		}
	}
	
	/**
	 * Check if the game is over now.
	 */
	checkForEndOfGame() {
		
		if (!this.isInKnockedState()) {
			
			const playboard = this.getPlayboard();
			
			const reservePilePlayerA = playboard.getPlayboardMap().get(PileUtils.getReservePilePositionOfPlayer(Player.PLAYER_A));
			const wastePilePlayerA = playboard.getPlayboardMap().get(PileUtils.getWastePilePositionOfPlayer(Player.PLAYER_A));
			
			const reservePilePlayerB = playboard.getPlayboardMap().get(PileUtils.getReservePilePositionOfPlayer(Player.PLAYER_B));
			const wastePilePlayerB = playboard.getPlayboardMap().get(PileUtils.getWastePilePositionOfPlayer(Player.PLAYER_B));

			// If real player won:
			if (PileUtils.isPileEmpty(reservePilePlayerA) && PileUtils.isPileEmpty(wastePilePlayerA)) {
				this.setGameOver(true);
				this.setWinnerPlayer(Player.PLAYER_A);
				this.setActivePlayer(Player.DEALER);

				LocalStorageService.increaseStatisticsNumberOfGames();
				LocalStorageService.increaseStatisticsNumberOfGamesWon();
				LocalStorageService.updateStatisticsAverageDurationOfGame(this._startTimeTs);

				RenderService.renderPlayboard(this);
				RenderService.renderGameOverDialog(this);
				RenderService.enableLevelSelect();
				RenderService.enableSortAcesOnCenterPilesChoice();
				
			}
			// If computer opponent won:
			else if (PileUtils.isPileEmpty(reservePilePlayerB) && PileUtils.isPileEmpty(wastePilePlayerB)) {
				this.setGameOver(true);
				this.setWinnerPlayer(Player.PLAYER_B);
				this.setActivePlayer(Player.DEALER);

				LocalStorageService.increaseStatisticsNumberOfGames();
				LocalStorageService.increaseStatisticsNumberOfGamesLost();
				LocalStorageService.updateStatisticsAverageDurationOfGame(this._startTimeTs);

				RenderService.renderPlayboard(this);
				RenderService.renderGameOverDialog(this);
				RenderService.enableLevelSelect();
				RenderService.enableSortAcesOnCenterPilesChoice();
			}

			// The match is finished: discard the saved game so the next load
			// starts fresh rather than restoring a completed board.
			if (this.isGameOver()) {
				GamePersistence.clearSavedGame();
			}
		}
	}

	hideKnockButton() {
		RenderService.hideKnockButton();
	}
	
	isMoveKnockable(move) {
		const isKnockable = AiUtils.isMoveKnockable(move, this, true);
		return isKnockable;
	}
}