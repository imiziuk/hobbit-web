// World objects by GUID (chests, pickups, switches, levers, push blocks) for the web port's multiplayer (docs/MULTIPLAYER.md). Installed by web/game.mjs after mp.mjs.
// Hook points: mp.listeners (every relay message), mp.frameHooks (every present; local = null outside a level),
// mp.levelHooks (level change); helpers mp.send / scanObjects / setPos / setAnim / animCtrl / validNpc / rf / wf / isHost.
export function installWorld({ mp, m, W, log, panel }) {
  return {};
}
