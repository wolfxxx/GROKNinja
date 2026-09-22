import "./style.css";
import { Game } from "./game/Game";

const canvas = document.querySelector("#game-canvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("Missing #game-canvas");
}

const game = new Game(canvas);
game.init();
