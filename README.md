# HCI-Drone-Project

A browser-based drone navigation demo with voice and typed commands. The drone
moves around a randomly generated 7×7 grid, avoiding walls and the grid edges.
Each grid has two or three irregular terrain clusters, with a clear route between
all open cells.

## Run it

Open `index.html` in a recent version of Chrome or Microsoft Edge. For the most
reliable microphone permissions, serve the project from `localhost` (for
example, with VS Code's Live Server extension) and open the local URL.

Type a command in **Command chat** and press Enter or **Send**, or select the
microphone (**Start listening**) and allow microphone access. The chat shows
the original command, whether it was typed or spoken, and the drone's reply.
Unrecognized commands also appear with guidance. While listening, a “Hearing”
preview shows the current transcript; a voice command executes once its
transcript is final, so speech revisions don't trigger duplicate movement.

Examples (the same commands work with text and voice):

| Command | Behavior |
| --- | --- |
| “Go left” | Move one cell; arrow buttons do the same. |
| “Go all the way left” | Route to a reachable cell on the left edge using known walls, adjusting as vision reveals more. Works in all four directions. |
| “Go to G7” | Navigate to a specific cell. Also supports corners, the center, “take the second spot on top,” and “row three, column two.” |
| “Move three cells right” | Set a destination three columns right and route around walls to reach it. |
| “Keep going right until a wall” | Move straight until the next cell is a wall or outside the grid. |
| “Find the nearest wall” | Navigate to a reachable cell beside the nearest wall the drone has seen. |
| “Count how many walls there are” | Report connected groups and wall cells the drone has seen; unknown areas may contain more. |
| “What can you see?” | Report current visible cells, visible and remembered walls, and unknown cells. |
| “Do a barrel roll” | Animate a roll in place without changing position or move count. |
| “Go left then do a barrel roll” | Execute commands in order. New commands wait in the queue. |
| “Stop” | Cancel current movement or a roll and clear pending commands. The **Stop** button also works. |

The drone sees cells with a clear line of sight; walls block its view of cells
behind them. The board distinguishes currently visible cells, remembered cells,
and unknown cells. Seen walls remain in memory when out of view, while a newly
generated grid clears that memory. Navigation uses **Dijkstra's algorithm** on
the drone's remembered map only, with a cost of one per orthogonal move. It
replans as it moves and discovers more of the grid; it never uses hidden
obstacles to choose a route. The planned route appears in blue. Wall finding
and counting also use only walls the drone has seen. **Regenerate grid** creates
two or three irregular clusters of varied terrain, while keeping every open
cell reachable; it cancels pending commands and resets the drone to D4, move
count, and vision memory. Chat replies are displayed as text; the app does not
synthesize spoken replies.

Voice recognition uses the browser's Web Speech API and requires a supported
browser and microphone permission. The page responds to the browser's
recognized-text updates; the API does not provide it with a raw, unlimited
audio stream or guarantee instant recognition. Recognition speed and
availability depend on the browser's speech service, which may require an
internet connection. The manual controls remain available if voice recognition
isn't supported or its speech service is unavailable.

## Verify changes

Run `node --test tests/drone.test.cjs` with Node.js 18 or later. The suite covers
command parsing, terrain generation and connectivity, line-of-sight and
remembered map behavior, shortest routes against an independent search on 40
obstacle layouts, wall detection/counting, chat, final voice transcripts, and
stop/reset cancellation. Speech events are simulated; actual microphone
availability and recognition quality still depend on the browser and its
speech service.
