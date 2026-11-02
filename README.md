# HCI-Drone-Project

A browser-based drone navigation demo with voice and typed commands. The drone
moves around a randomly generated 6×6 grid, avoiding walls and the grid edges.

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
| “Go all the way left” | Find the shortest clear route to a reachable cell on the left edge, detouring around walls. Works in all four directions. |
| “Go to F6” | Navigate to a specific cell. Also supports corners, the center, “take the second spot on top,” and “row three, column two.” |
| “Move three cells right” | Set a destination three columns right and route around walls to reach it. |
| “Keep going right until a wall” | Move straight until the next cell is a wall or outside the grid. |
| “Find the nearest wall” | Navigate to the reachable cell beside a wall that requires the fewest moves. |
| “Count how many walls there are” | Report connected wall groups and total blocked cells. Cells sharing a side form one wall; boundaries are excluded. |
| “Do a barrel roll” | Animate a roll in place without changing position or move count. |
| “Go left then do a barrel roll” | Execute commands in order. New commands wait in the queue. |
| “Stop” | Cancel current movement or a roll and clear pending commands. The **Stop** button also works. |

Navigation uses **Dijkstra's algorithm** with a cost of one per orthogonal move
to choose the shortest route through clear cells. The planned route appears in
blue while the drone moves one cell at a time. A blocked or unreachable specific
destination produces an explanation instead of silently choosing another goal.
**Regenerate grid** creates a connected obstacle layout with varied shapes,
cancels pending commands, and resets the drone and move count. Chat replies are
displayed as text; the app does not synthesize spoken replies.

Voice recognition uses the browser's Web Speech API and requires a supported
browser and microphone permission. The page responds to the browser's
recognized-text updates; the API does not provide it with a raw, unlimited
audio stream or guarantee instant recognition. Recognition speed and
availability depend on the browser's speech service, which may require an
internet connection. The manual controls remain available if voice recognition
isn't supported or its speech service is unavailable.

## Verify changes

Run `node --test tests/drone.test.cjs` with Node.js 18 or later. The suite covers
command parsing, shortest routes against an independent search on 40 obstacle
layouts, wall detection/counting, chat, final voice transcripts, and stop/reset
cancellation. Speech events are simulated; actual microphone availability and
recognition quality still depend on the browser and its speech service.
