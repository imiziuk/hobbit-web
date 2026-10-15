# Per-slot skins and name labels in the web port's multiplayer (Oct 15 2026)

`recomp/host/mp_skins.mjs` (installed by `web/game.mjs` after `mp.mjs`, `window.hobbit.mp.ext.skins`). Written by an agent
that was stopped before it could document; this is the coordinator's summary of what is in the file and what was verified.

## Skins
Nothing to do at run time: Synchrony's `FAKE_HOBBITS.EXPORT` (served by `recomp/mp_assets.py`) binds the fake Bilbo of
slot k to `props/bilbofake<k+1>.npcgeom`, whose diffuse material is `bilb<k+1>[D].xbmp`. The v1.0 release ships 8
byte-identical placeholder textures (the retail Bilbo look); in Synchrony a player's own skin file replaces its slot's
placeholder on disk. The module adds a per-slot colour tint to that slot's texture in the D3D8 bridge (`tintTexture`,
`SLOT_COLORS`) so remote players can be told apart without skin files.

## Name labels
Synchrony writes the name into the marker object `0D8AD911_<npc guid lo>` (text at marker+0xC0) and lets the engine draw
it (`marker::RenderCustom` 0x0049A340 -> text-at-3D-point 0x0066AE20 -> xCore debug text queue 0x0067D360, flushed in
`eng_PageFlip`); in the retail exe that text never reaches the screen, so the label is an **HTML overlay** over the
canvas: the fake Bilbo's position + 120 units, projected with the VIEW/PROJECTION matrices captured by wrapping the bridge
device's `SetTransform` (last perspective pass of the frame) and the D3D viewport. Hidden when the player is not on this
level; `localStorage hobbit.mp.labels = '0'` turns labels off.

## Verified (Oct 15, coordinator, `hobbit-single` 5390, tabs Alice / Bob, Dream World)
- Bob's tab: label "Alice" at (353, 228) px; Alice's tab: label "Bob" above the slot-1 fake Bilbo (screenshot checked),
  `stats.projected` growing, `mp.stats.errors` 0 on both tabs.
- Not checked: the tint's look, labels on other levels, more than 2 players.
