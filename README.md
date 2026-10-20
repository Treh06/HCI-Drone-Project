# HCI-Drone-Project

A small browser-based, voice-controlled drone navigation demo. The drone moves
around a randomly generated 5×5 grid, avoiding obstacles and the grid edges.

## Run it

Open `index.html` in a recent version of Chrome or Microsoft Edge. For the most
reliable microphone permissions, serve the project from `localhost` (for
example, with VS Code's Live Server extension) and open the local URL.

Select **Start listening** and allow microphone access, then say **left**,
**right**, **up**, or **down**. Common speech-recognition near-misses are also
accepted (for example, “lift” for left, “write” or “light” for right, “app”
for up, and “town” for down). A direction moves as soon as it appears in an
interim recognition result; it does not wait for the sentence to finish.
Transient network and no-speech interruptions are retried automatically, with
increasing delays for repeated network interruptions. Movement into obstacles
or beyond the grid is blocked. The arrow buttons also move the drone manually,
and **Regenerate grid** creates a new obstacle layout and resets its position.

Voice recognition uses the browser's Web Speech API and requires a supported
browser and microphone permission. The page responds to the browser's
recognized-text updates; the API does not provide it with a raw, unlimited
audio stream or guarantee instant recognition. Recognition speed and
availability depend on the browser's speech service, which may require an
internet connection. The manual controls remain available if voice recognition
isn't supported or its speech service is unavailable.
