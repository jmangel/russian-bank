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
// a fresh board.
const savedGame = GamePersistence.loadSavedGame();
if (savedGame) {
	GamePersistence.restoreInto(game, savedGame);
} else {
	game.initializeGame();
}

RenderService.setupLocalStorageFields(game);

// setupLocalStorageFields re-applies zpLevel/tutorial; re-assert the restored
// game's state (and resume the AI if it was its turn) afterwards.
if (savedGame) {
	GamePersistence.applyPostSetup(game, savedGame);
}
