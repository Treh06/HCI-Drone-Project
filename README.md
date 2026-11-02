# HCI-Drone-Project

A small browser-based, voice-controlled drone navigation demo. The drone moves
around a randomly generated 6×6 grid, avoiding obstacles and the grid edges.

## Run it

Open `index.html` in a recent version of Chrome or Microsoft Edge. For the most
reliable microphone permissions, serve the project from `localhost` (for
example, with VS Code's Live Server extension) and open the local URL.

Select **Start listening** and allow microphone access. Use natural variations
of a direction or destination, such as “go to the southwest corner,” “take the
second spot on top,” or “head over to row three, column two.” You can also say
“keep going right until a block” (or another direction). Destination routes go
around obstacles and visibly move one cell at a time. The history shows only
recognized phrases that contain a command. Arrow buttons move one cell.
**Regenerate grid** creates a connected obstacle layout with varied shapes and
resets the drone.

Voice recognition uses the browser's Web Speech API and requires a supported
browser and microphone permission. The page responds to the browser's
recognized-text updates; the API does not provide it with a raw, unlimited
audio stream or guarantee instant recognition. Recognition speed and
availability depend on the browser's speech service, which may require an
internet connection. The manual controls remain available if voice recognition
isn't supported or its speech service is unavailable.
