import "babel-polyfill";

import * as RenderService from "./services/render_service";
import * as i18nService from "./services/i18n_service";
import * as GamePersistence from "./services/game_persistence_service";

import {Game} from "./game";

RenderService.preloadImages();

i18nService.setupApp();
RenderService.setupApp();

const game = new Game();

// Restore an in-progress game saved before an accidental refresh, otherwise deal
// a fresh board. A save that passes structural validation but is still corrupt
// (e.g. an unknown enum name) makes restoreInto throw; fall back to a fresh deal
// rather than letting boot die.
let savedGame = GamePersistence.loadSavedGame();
if (savedGame) {
	try {
		GamePersistence.restoreInto(game, savedGame);
	} catch (e) {
		GamePersistence.clearSavedGame();
		savedGame = null;
		game.initializeGame();
	}
} else {
	game.initializeGame();
}

RenderService.setupLocalStorageFields(game);

// setupLocalStorageFields re-applies zpLevel/tutorial; re-assert the restored
// game's state (and resume the AI if it was its turn) afterwards. The selectors
// are already locked by finishSetup when play had started; sync the level
// dropdown's displayed value to the restored game's level.
if (savedGame) {
	GamePersistence.applyPostSetup(game, savedGame);
	if (savedGame.scalars.realPlayerMadeFirstMove) {
		RenderService.setLevelSelectValue(savedGame.scalars.levelOfDifficulty);
	}
}
