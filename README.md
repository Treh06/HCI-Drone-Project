# HCI-Drone-Project

This is a proof of concept, since we cannot get a physical drone to put this on. We are instead showing that the technologies required individually will work, and therefore if one were to get an actual drone, they would be able to get the same results in 3d space. 

Note: Most of the current code is AI generated, but the ideas themselves come from us.

## Environments

Open `index.html` for the original 2D grid or `3d.html` for the separate 3D airspace. The navigation links switch between them. Each page starts its own environment, with its own terrain, drone position, vision memory, move count, and command chat. Reloading or switching pages starts a new session.

The 3D airspace has 7 columns, 7 rows, and 4 altitude levels. It renders with native CSS 3D transforms and requires no downloaded libraries or build step. Orbit, tilt, and zoom controls adjust the camera; the altitude map lets you inspect a level and select a destination. Camera and map inspection do not reveal terrain the drone has not observed.

Both environments use `drone-app.js` for the existing voice and typed commands, command queue, cancellation, wall detection/counting, vision memory, barrel rolls, and Dijkstra routing. In 3D, vision traces rays through the volume and routing searches six neighboring cells, replanning after each move when newly observed walls change the route. Generated terrain keeps all open cells reachable.

### 3D commands

All existing 2D commands still work. For example, “go to G7”, “go all the way left”, “find the nearest wall”, “count walls”, “what can you see?”, “do a barrel roll”, and “stop”. A destination without a level uses the drone's current altitude; routing may change altitude to avoid walls and return to the requested level.

- “Ascend” / “descend”: move one altitude level.
- “Ascend two levels” / “fly down one level”: move by a level count.
- “Go to level 4”: route to that altitude above the current horizontal position.
- “Go to G7 level 3” / “go to D4 L2”: route to a full 3D coordinate.
- “Go to the ceiling” / “go to the ground”: route to the nearest reachable cell on the top or bottom level.
- “Ascend until a wall”: stop before the first wall or altitude boundary.
- “Go right then go to level 4”: execute a command sequence.

“Up” and “down” preserve their existing north/south meaning unless accompanied by a level count. Use “ascend” and “descend” for unambiguous altitude movement. Levels run from 1 (ground) to 4 (ceiling).

Microphone commands use the existing browser speech-recognition integration. Use Chrome or Edge, allow microphone access, and serve the project on localhost or HTTPS if your browser restricts microphone access for local files. Typed commands and manual controls work without a microphone.

### Verification

Run `node --test tests/drone.test.cjs` (Node.js 18 or newer). The suite covers the original 2D behavior and 3D routing against an independent breadth-first oracle, vertical occlusion, discovery and replanning, command compatibility, altitude controls, map selection, speech result deduplication, cancellation, and generated-terrain connectivity.
