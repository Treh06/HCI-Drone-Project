(() => {
        const SIZE = 7;
        const IS_3D = document.body?.dataset.environment === "3d";
        const LEVELS = IS_3D ? 4 : 1;
        const board = document.querySelector("#board");
        const positionLabel = document.querySelector("#position");
        const moveCountLabel = document.querySelector("#move-count");
        const status = document.querySelector("#status");
        const statusMessage = document.querySelector("#status-message");
        const listenButton = document.querySelector("#listen-button");
        const listenLabel = document.querySelector("#listen-label");
        const historyList = document.querySelector("#history-list");
        const commandInput = document.querySelector("#command-input");
        const voicePreview = document.querySelector("#voice-preview");
        const OFFSETS = { up: [-1, 0], right: [0, 1], down: [1, 0], left: [0, -1] };
        if (IS_3D) Object.assign(OFFSETS, { ascend: [0, 0, 1], descend: [0, 0, -1] });

        let drone = { row: 3, col: 3, level: 0 };
        let obstacles = new Set();
        let knownObstacles = new Set();
        let seenCells = new Set();
        let visibleCells = new Set();
        let moveCount = 0;
        let navigating = false;
        let navigationVersion = 0;
        let commandQueue = [];
        let processingCommands = false;
        let activeJob = null;
        let plannedRoute = new Set();
        let goalKey = null;
        let recognition = null;
        let listening = false;
        let recognitionActive = false;
        let restartTimer = null;
        let stableTimer = null;
        let restartDelay = 300;
        let lastRecognitionError = null;
        let viewLevel = 0;

        function key(row, col, level = drone.level || 0) {
          return IS_3D ? `${row},${col},${level}` : `${row},${col}`;
        }

        function coordinates(location) {
          const [row, col, level = 0] = location.split(",").map(Number);
          return { row, col, level };
        }

        function neighbor(position, direction) {
          const [dr, dc, dl = 0] = OFFSETS[direction];
          return { row: position.row + dr, col: position.col + dc, level: (position.level || 0) + dl };
        }

        function positionKey(position) {
          return key(position.row, position.col, position.level);
        }

        // Traverse every voxel crossed by the ray from cell center to cell center.
        // A wall is visible itself, but occludes cells beyond it on any altitude.
        function hasSpatialLineOfSight(targetRow, targetCol, targetLevel) {
          const start = [drone.row, drone.col, drone.level || 0];
          const target = [targetRow, targetCol, targetLevel];
          const current = [...start];
          const delta = target.map((value, axis) => value - start[axis]);
          const step = delta.map(Math.sign);
          const interval = delta.map((value) => value ? 1 / Math.abs(value) : Infinity);
          const next = interval.map((value) => value / 2);
          while (current.some((value, axis) => value !== target[axis])) {
            const crossing = Math.min(...next);
            for (let axis = 0; axis < 3; axis++) {
              if (Math.abs(next[axis] - crossing) < 1e-9) {
                current[axis] += step[axis];
                next[axis] += interval[axis];
              }
            }
            if (current.every((value, axis) => value === target[axis])) return true;
            if (obstacles.has(key(...current))) return false;
          }
          return true;
        }

        function hasLineOfSight(targetRow, targetCol, targetLevel = 0) {
          if (IS_3D) return hasSpatialLineOfSight(targetRow, targetCol, targetLevel);
          let x = drone.col;
          let y = drone.row;
          const dx = Math.abs(targetCol - x);
          const sx = x < targetCol ? 1 : -1;
          const dy = -Math.abs(targetRow - y);
          const sy = y < targetRow ? 1 : -1;
          let error = dx + dy;

          while (x !== targetCol || y !== targetRow) {
            const doubledError = 2 * error;
            if (doubledError >= dy) {
              error += dy;
              x += sx;
            }
            if (doubledError <= dx) {
              error += dx;
              y += sy;
            }
            if ((x !== targetCol || y !== targetRow) && obstacles.has(key(y, x))) return false;
          }
          return true;
        }

        function updateVision() {
          visibleCells = new Set();
          for (let level = 0; level < LEVELS; level += 1) {
            for (let row = 0; row < SIZE; row += 1) {
              for (let col = 0; col < SIZE; col += 1) {
                if (!hasLineOfSight(row, col, level)) continue;
                const location = key(row, col, level);
                visibleCells.add(location);
                seenCells.add(location);
                if (obstacles.has(location)) knownObstacles.add(location);
              }
            }
          }
        }

        function setStatus(message, state = "idle") {
          statusMessage.textContent = message;
          status.dataset.state = state;
        }

        function parseSpatialCommand(text) {
          // Level numbers are human-facing (1–4); internal altitudes are zero-based.
          const marker = text.match(/\b(?:level|layer|altitude)\s+([a-z0-9]+)\b|\bl\s*(\d+)\b/);
          if (marker) {
            const number = ordinalValue(marker[1] || marker[2]);
            if (!number || number > LEVELS) return [];
            const base = text.replace(marker[0], "").replace(/\b(?:at|on)\s*(?:the\s*)?[.!?]*$/, "").trim();
            if (/\b(?:level|layer|altitude|l\s*\d+)\b/.test(base)) return [];
            if (/^(?:please\s+)?(?:(?:go|move|fly|head|climb|ascend|descend)(?:\s+to)?(?:\s+the)?)?[.!?]*$/.test(base)) {
              return [{ type: "altitude", level: number - 1 }];
            }
            const destination = parseVoiceCommands(base);
            return destination.length === 1 && destination[0].type === "destination"
              ? [{ ...destination[0], level: number - 1 }] : [];
          }
          if (/\b(?:ceiling|highest level)\b/.test(text)) return [{ type: "edge", direction: "ascend" }];
          if (/\b(?:floor|ground|lowest level)\b/.test(text)) return [{ type: "edge", direction: "descend" }];
          // Keep legacy “up” / “down” as north / south. Altitude uses explicit verbs,
          // or “fly up/down N levels”, so old voice commands retain their meaning.
          if (/\blevels?\b/.test(text)) {
            const words = text.match(/\b[a-z0-9]+\b/g) || [];
            const directions = words.map(directionForWord).filter(Boolean);
            const steps = words.map(ordinalValue).find(Boolean);
            if (directions.length !== 1 || !steps || steps >= LEVELS) return [];
            const direction = { up: "ascend", down: "descend", ascend: "ascend", descend: "descend" }[directions[0]];
            return direction ? [{ type: "direction", direction, steps }] : [];
          }
          if (/\b(?:layer|altitude)\b/.test(text)) return [];
          return null;
        }

        function generateSpatialObstacles() {
          const candidate = new Set();
          function connected() {
            const visited = new Set([positionKey(drone)]);
            const queue = [{ ...drone }];
            for (let index = 0; index < queue.length; index++) {
              for (const direction of Object.keys(OFFSETS)) {
                const next = neighbor(queue[index], direction);
                const location = positionKey(next);
                if (!inBounds(next.row, next.col, next.level) || candidate.has(location) || visited.has(location)) continue;
                visited.add(location);
                queue.push(next);
              }
            }
            return visited.size === SIZE * SIZE * LEVELS - candidate.size;
          }
          // Grow clusters in all three axes. Reject placements that seal off open air.
          const targetCount = 35 + Math.floor(Math.random() * 10);
          for (let attempt = 0; attempt < 1200 && candidate.size < targetCount; attempt++) {
            let position;
            if (candidate.size && Math.random() < 0.75) {
              const seed = [...candidate][Math.floor(Math.random() * candidate.size)];
              const directions = Object.keys(OFFSETS);
              position = neighbor(coordinates(seed), directions[Math.floor(Math.random() * directions.length)]);
            } else {
              position = { row: Math.floor(Math.random() * SIZE), col: Math.floor(Math.random() * SIZE), level: Math.floor(Math.random() * LEVELS) };
            }
            const location = positionKey(position);
            if (!inBounds(position.row, position.col, position.level) || location === positionKey(drone) || candidate.has(location)) continue;
            candidate.add(location);
            if (!connected()) candidate.delete(location);
          }
          obstacles = candidate;
        }

        function renderSpatialBoard() {
          board.replaceChildren();
          const layerMap = document.querySelector("#layer-map");
          layerMap.replaceChildren();
          document.querySelector("#view-level").value = String(viewLevel);
          document.querySelector("#layer-title").textContent = `Level ${viewLevel + 1} · ${viewLevel === drone.level ? "drone altitude" : "inspection layer"}`;
          document.querySelector("#altitude").textContent = `L${(drone.level || 0) + 1} / ${LEVELS}`;
          for (let level = 0; level < LEVELS; level++) {
            const slice = document.createElement("div");
            slice.className = `space-level${level === viewLevel ? " active-level" : ""}`;
            slice.style.transform = `translateZ(${level * 74}px)`;
            slice.setAttribute("aria-hidden", "true");
            const label = document.createElement("span");
            label.className = "space-level-label";
            label.textContent = `L${level + 1}`;
            slice.append(label);
            for (let row = 0; row < SIZE; row++) {
              for (let col = 0; col < SIZE; col++) {
                const location = key(row, col, level);
                const visible = visibleCells.has(location);
                const seen = seenCells.has(location);
                const wall = knownObstacles.has(location);
                const occupied = positionKey(drone) === location;
                const route = plannedRoute.has(location);
                const goal = goalKey === location;
                const state = `${visible ? "visible" : seen ? "remembered" : "unknown"}${wall ? " wall" : ""}${route ? " route" : ""}${goal ? " goal" : ""}${occupied ? " occupied" : ""}`;
                const cell = document.createElement("div");
                cell.className = `space-cell ${state}`;
                cell.style.left = `${col * 56}px`;
                cell.style.top = `${row * 56}px`;
                if (wall) {
                  const cube = document.createElement("div");
                  cube.className = "voxel";
                  for (const face of ["top", "front", "back", "left", "right"]) {
                    const surface = document.createElement("span");
                    surface.className = `voxel-face face-${face}`;
                    cube.append(surface);
                  }
                  cell.append(cube);
                }
                if (route || goal) {
                  const marker = document.createElement("span");
                  marker.className = "route-marker";
                  cell.append(marker);
                }
                if (occupied) {
                  const model = document.createElement("div");
                  model.className = "drone drone-model";
                  model.innerHTML = '<span class="drone-arm arm-one"></span><span class="drone-arm arm-two"></span><span class="drone-body"></span><span class="rotor rotor-one"></span><span class="rotor rotor-two"></span><span class="rotor rotor-three"></span><span class="rotor rotor-four"></span>';
                  cell.append(model);
                }
                slice.append(cell);
                if (level === viewLevel) {
                  const button = document.createElement("button");
                  button.type = "button";
                  button.className = `map-cell ${state}`;
                  button.textContent = occupied ? "✥" : wall ? "■" : !seen ? "?" : goal ? "◎" : route ? "·" : "";
                  button.setAttribute("aria-label", `${positionName(location)}: ${occupied ? "drone" : `${visible ? "visible" : seen ? "remembered" : "unknown"} ${wall ? "wall" : "air"}`}. Navigate here.`);
                  button.disabled = wall;
                  button.addEventListener("click", () => submitCommand(`go to ${String.fromCharCode(65 + col)}${row + 1} level ${level + 1}`, "map"));
                  layerMap.append(button);
                }
              }
            }
            board.append(slice);
          }
        }

        function initializeSpatialControls() {
          const scene = document.querySelector("#scene");
          const yaw = document.querySelector("#camera-yaw");
          const tilt = document.querySelector("#camera-tilt");
          const zoom = document.querySelector("#camera-zoom");
          function updateCamera() {
            scene.style.setProperty("--yaw", `${yaw.value}deg`);
            scene.style.setProperty("--tilt", `${tilt.value}deg`);
            scene.style.setProperty("--zoom", String(Number(zoom.value) / 100));
          }
          for (const slider of [yaw, tilt, zoom]) slider.addEventListener("input", updateCamera);
          document.querySelector("#camera-reset").addEventListener("click", () => {
            yaw.value = "-35"; tilt.value = "58"; zoom.value = "85";
            updateCamera();
          });
          document.querySelector("#view-level").addEventListener("change", (event) => {
            viewLevel = Number(event.target.value);
            renderBoard();
          });
          document.querySelector("#follow-drone").addEventListener("click", () => {
            viewLevel = drone.level || 0;
            renderBoard();
          });
          updateCamera();
        }

        function renderBoard() {
          updateVision();
          if (IS_3D) {
            renderSpatialBoard();
          } else {
          board.replaceChildren();
          for (let row = 0; row < SIZE; row += 1) {
            const rowElement = document.createElement("div");
            rowElement.className = "board-row";
            rowElement.setAttribute("role", "row");

            const rowLabel = document.createElement("span");
            rowLabel.className = "row-label";
            rowLabel.setAttribute("aria-hidden", "true");
            rowLabel.textContent = String(row + 1);
            rowElement.append(rowLabel);

            const gridRow = document.createElement("div");
            gridRow.className = "grid";
            for (let col = 0; col < SIZE; col += 1) {
              const cell = document.createElement("div");
              cell.className = "cell";
              cell.setAttribute("role", "gridcell");
              const location = key(row, col);
              const columnName = String.fromCharCode(65 + col);
              const visible = visibleCells.has(location);
              const remembered = seenCells.has(location);
              cell.setAttribute("aria-label", `${visible ? "Visible" : remembered ? "Remembered" : "Unknown"} cell at row ${row + 1}, column ${columnName}`);
              if (!visible && remembered) cell.classList.add("remembered-cell");
              if (!remembered) cell.classList.add("unknown-cell");
              if (plannedRoute.has(location)) cell.classList.add("route-cell");
              if (goalKey === location) cell.classList.add("goal-cell");

              if (drone.row === row && drone.col === col) {
                cell.classList.add("drone-cell");
                cell.setAttribute("aria-label", `Drone at ${columnName}${row + 1}; current vision`);
                cell.innerHTML = '<svg class="drone" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M24 16.5v15M16.5 24h15" stroke="#2563eb" stroke-width="3" stroke-linecap="round"/><path d="M20 20l-5-5m13 13 5 5m0-18-5 5m-8 8-5 5" stroke="#475467" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="5" fill="#fff" stroke="#2563eb" stroke-width="2"/><circle cx="36" cy="12" r="5" fill="#fff" stroke="#2563eb" stroke-width="2"/><circle cx="12" cy="36" r="5" fill="#fff" stroke="#2563eb" stroke-width="2"/><circle cx="36" cy="36" r="5" fill="#fff" stroke="#2563eb" stroke-width="2"/><circle cx="24" cy="24" r="5.5" fill="#2563eb"/><circle cx="24" cy="24" r="2" fill="#fff"/></svg>';
              } else if (knownObstacles.has(location)) {
                cell.classList.add("obstacle-cell");
                cell.setAttribute("aria-label", `${visible ? "Visible" : "Remembered"} wall at ${columnName}${row + 1}`);
                if (!visible) cell.classList.add("remembered-obstacle-cell");
                cell.innerHTML = '<span class="obstacle" aria-hidden="true">✳</span>';
              } else if (remembered) {
                cell.setAttribute("aria-label", `${visible ? "Visible" : "Remembered"} clear cell at ${columnName}${row + 1}`);
              }
              gridRow.append(cell);
            }
            rowElement.append(gridRow);
            board.append(rowElement);
          }
          }

          positionLabel.textContent = positionName(positionKey(drone));
          moveCountLabel.textContent = String(moveCount);
          positionLabel.setAttribute("aria-label", `Position ${positionLabel.textContent}`);
          moveCountLabel.setAttribute("aria-label", `Moves ${moveCount}`);
          const unknownCount = SIZE * SIZE * LEVELS - seenCells.size;
          const rememberedWallCount = [...knownObstacles].filter((location) => !visibleCells.has(location)).length;
          document.querySelector("#vision-status").textContent =
            `Vision: ${visibleCells.size} visible cells · ${rememberedWallCount} remembered wall${rememberedWallCount === 1 ? "" : "s"} · ${unknownCount} unknown cells`;
        }

        function generateObstacles() {
          if (IS_3D) return generateSpatialObstacles();
          const patterns = [
            [[0, 0], [1, 0], [2, 0]],
            [[0, 0], [0, 1], [1, 1]],
            [[0, 0], [1, 0], [1, 1], [2, 1]],
            [[0, 1], [1, 0], [1, 1], [1, 2]],
            [[0, 0], [0, 1], [1, 1], [1, 2]],
            [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]],
            [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]],
            [[0, 0], [0, 1], [0, 2], [1, 1], [2, 1]],
            [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]],
            [[0, 1], [1, 0], [1, 1], [1, 2], [2, 1]],
            [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [2, 1]]
          ];

          function connected(candidate) {
            const start = key(drone.row, drone.col);
            const visited = new Set([start]);
            const queue = [{ row: drone.row, col: drone.col }];
            const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1]];

            for (let index = 0; index < queue.length; index += 1) {
              const { row, col } = queue[index];
              for (const [rowOffset, colOffset] of offsets) {
                const nextRow = row + rowOffset;
                const nextCol = col + colOffset;
                const nextKey = key(nextRow, nextCol);
                if (nextRow < 0 || nextRow >= SIZE || nextCol < 0 || nextCol >= SIZE ||
                    candidate.has(nextKey) || visited.has(nextKey)) continue;
                visited.add(nextKey);
                queue.push({ row: nextRow, col: nextCol });
              }
            }

            return visited.size === SIZE * SIZE - candidate.size;
          }

          function makeCluster(candidate) {
            const pattern = patterns[Math.floor(Math.random() * patterns.length)];
            const rotation = Math.floor(Math.random() * 4);
            const reflect = Math.random() < 0.5;
            const transformed = pattern.map(([originalRow, originalCol]) => {
              let row = originalRow;
              let col = reflect ? -originalCol : originalCol;
              for (let turn = 0; turn < rotation; turn += 1) [row, col] = [col, -row];
              return [row, col];
            });
            const minRow = Math.min(...transformed.map(([row]) => row));
            const maxRow = Math.max(...transformed.map(([row]) => row));
            const minCol = Math.min(...transformed.map(([, col]) => col));
            const maxCol = Math.max(...transformed.map(([, col]) => col));
            const offsetRow = Math.floor(Math.random() * (SIZE - (maxRow - minRow)));
            const offsetCol = Math.floor(Math.random() * (SIZE - (maxCol - minCol)));
            const cluster = new Set(transformed.map(([row, col]) =>
              key(row - minRow + offsetRow, col - minCol + offsetCol)));
            if ([...cluster].some((location) => candidate.has(location) || location === key(drone.row, drone.col))) return null;
            return cluster;
          }

          function growCluster(cluster, candidate, targetSize) {
            while (cluster.size < targetSize) {
              const options = new Set();
              for (const location of cluster) {
                const [row, col] = location.split(",").map(Number);
                for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                  const nextRow = row + dr;
                  const nextCol = col + dc;
                  const nextKey = key(nextRow, nextCol);
                  if (inBounds(nextRow, nextCol) && !candidate.has(nextKey) &&
                      !cluster.has(nextKey) && nextKey !== key(drone.row, drone.col)) options.add(nextKey);
                }
              }
              if (!options.size) return false;
              const optionsList = [...options];
              cluster.add(optionsList[Math.floor(Math.random() * optionsList.length)]);
            }
            return true;
          }

          for (let attempt = 0; attempt < 400; attempt += 1) {
            const targetCount = 9 + Math.floor(Math.random() * 5);
            const clusterCount = targetCount >= 11 && Math.random() < 0.5 ? 3 : 2;
            const sizes = Array.from({ length: clusterCount }, () => Math.floor(targetCount / clusterCount));
            for (let index = 0; index < targetCount % clusterCount; index += 1) sizes[index] += 1;
            const candidate = new Set();
            let valid = true;

            for (const targetSize of sizes) {
              let cluster = null;
              for (let placementAttempt = 0; placementAttempt < 40 && !cluster; placementAttempt += 1) {
                cluster = makeCluster(candidate);
              }
              if (!cluster || cluster.size > targetSize || !growCluster(cluster, candidate, targetSize)) {
                valid = false;
                break;
              }
              for (const location of cluster) candidate.add(location);
            }

            if (valid && connected(candidate)) {
              obstacles = candidate;
              return;
            }
          }

          obstacles = new Set();
        }

        function move(direction) {
          const next = neighbor(drone, direction);

          if (!inBounds(next.row, next.col, next.level)) {
            setStatus("Edge", listening ? "listening" : "error");
            return;
          }
          if (obstacles.has(positionKey(next))) {
            setStatus("Blocked", listening ? "listening" : "error");
            return;
          }

          drone = next;
          viewLevel = drone.level;
          moveCount += 1;
          renderBoard();
          setStatus(positionLabel.textContent, listening ? "listening" : "idle");
          return true;
        }

        async function moveAlong(route, finalStatus = null, targetKey = null) {
          const version = navigationVersion;
          navigating = true;
          setArrowControlsDisabled(true);
          let currentRoute = route;
          let routeIndex = 0;
          goalKey = targetKey;
          try {
            while (targetKey ? positionKey(drone) !== targetKey : routeIndex < currentRoute.length) {
              if (version !== navigationVersion) return false;
              if (targetKey) {
                currentRoute = reconstructRoute(dijkstra(), targetKey);
                if (currentRoute === null) return false;
                routeIndex = 0;
              }
              let routePosition = { ...drone };
              plannedRoute = new Set(currentRoute.slice(routeIndex).map((direction) => {
                routePosition = neighbor(routePosition, direction);
                return positionKey(routePosition);
              }));
              if (!targetKey) goalKey = positionKey(routePosition);
              renderBoard();
              const direction = currentRoute[routeIndex];
              plannedRoute.delete(positionKey(drone));
              if (!move(direction)) return false;
              routeIndex += 1;
              await new Promise((resolve) => window.setTimeout(resolve, 220));
            }
            if (version !== navigationVersion) return false;
            if (finalStatus && version === navigationVersion) {
              setStatus(finalStatus, listening ? "listening" : "idle");
            }
            return true;
          } finally {
            if (version === navigationVersion) {
              navigating = false;
              plannedRoute.clear();
              goalKey = null;
              renderBoard();
              setArrowControlsDisabled(false);
            }
          }
        }

        function setArrowControlsDisabled(disabled) {
          document.querySelectorAll(".arrow").forEach((button) => {
            button.disabled = disabled;
          });
        }

        function addMessage(speaker, message, source = "") {
          const entry = document.createElement("li");
          entry.dataset.speaker = speaker;
          const label = document.createElement("strong");
          label.className = "message-speaker";
          label.textContent = source ? `${speaker} · ${source}` : speaker;
          const body = document.createElement("span");
          body.textContent = message;
          entry.append(label, body);
          historyList.append(entry);
          historyList.scrollTop = historyList.scrollHeight;
          return body;
        }

        function updateReply(entry, message) {
          entry.textContent = message;
          historyList.scrollTop = historyList.scrollHeight;
        }

        function cancelCommands(reason) {
          navigationVersion += 1;
          if (activeJob) updateReply(activeJob.reply, reason);
          for (const job of commandQueue) updateReply(job.reply, reason);
          commandQueue = [];
          navigating = false;
          plannedRoute.clear();
          goalKey = null;
          setArrowControlsDisabled(false);
          renderBoard();
        }

        function submitCommand(transcript, source = "typed") {
          const text = transcript.trim();
          if (!text) return;
          addMessage("You", text, source);
          const commands = parseVoiceCommands(text);
          if (commands.some((command) => command.type === "stop")) {
            cancelCommands("Cancelled by stop command.");
            setStatus("Stopped", listening ? "listening" : "idle");
            addMessage("Drone", `Stopped at ${positionLabel.textContent}. Pending commands cleared.`);
          } else if (!commands.length) {
            addMessage("Drone", "I didn't understand that command. Try “go left”, a destination like G7, “what can you see?”, finding or counting walls, or a barrel roll.");
          } else {
            const reply = addMessage("Drone", processingCommands ? "Queued. Waiting for the current command…" : "Working on it…");
            commandQueue.push({ commands, reply, version: navigationVersion });
            processCommandQueue();
          }
        }

        function updateListenButton() {
          listenButton.setAttribute("aria-pressed", String(listening));
          listenLabel.textContent = listening ? "Stop listening" : "Start listening";
          listenButton.setAttribute("aria-label", listenLabel.textContent);
          listenButton.title = listenLabel.textContent;
        }

        function directionForWord(word) {
          const directions = {
            left: ["left", "west", "westward"],
            right: ["right", "east", "eastward"],
            up: ["up", "north", "northward"],
            down: ["down", "south", "southward"]
          };
          if (IS_3D) Object.assign(directions, {
            ascend: ["ascend", "rise", "climb", "higher"],
            descend: ["descend", "lower", "sink"]
          });

          const match = Object.entries(directions).find(([, alternatives]) => alternatives.includes(word));
          return match ? match[0] : null;
        }

        function ordinalValue(word) {
          const ordinals = {
            first: 1, one: 1, "1": 1, "1st": 1,
            second: 2, two: 2, "2": 2, "2nd": 2,
            third: 3, three: 3, "3": 3, "3rd": 3,
            fourth: 4, four: 4, "4": 4, "4th": 4,
            fifth: 5, five: 5, "5": 5, "5th": 5,
            sixth: 6, six: 6, "6": 6, "6th": 6,
            seventh: 7, seven: 7, "7": 7, "7th": 7
          };
          return ordinals[word] || null;
        }

        function parseDestination(transcript) {
          const text = transcript.toLowerCase()
            .replace(/\b(north|south)(east|west)\b/g, "$1 $2")
            .replace(/[,-]/g, " ");
          const ordinalPattern = "(first|one|1st|1|second|two|2nd|2|third|three|3rd|3|fourth|four|4th|4|fifth|five|5th|5|sixth|six|6th|6|seventh|seven|7th|7)";
          const rowWord = /\b(top|upper|north|bottom|lower|south)\b/;
          const columnWord = /\b(left|west|right|east)\b/;
          const rowMatch = text.match(rowWord);
          const columnMatch = text.match(columnWord);
          const coordinate = text.match(/\b([a-g])\s*([1-7])\b/);
          if (coordinate) return { row: Number(coordinate[2]) - 1, col: coordinate[1].charCodeAt(0) - 97 };
          if (/\b[a-z]\s*\d+\b/.test(text)) return null;

          if (rowMatch && columnMatch) {
            return {
              row: /top|upper|north/.test(rowMatch[1]) ? 0 : SIZE - 1,
              col: /left|west/.test(columnMatch[1]) ? 0 : SIZE - 1
            };
          }
          if (/\b(center|centre|middle)\b/.test(text)) {
            return { row: Math.floor(SIZE / 2), col: Math.floor(SIZE / 2) };
          }

          const rowOrdinal = text.match(new RegExp(`\\b(?:row|line)\\s+(?:number\\s+)?${ordinalPattern}\\b`)) ||
            text.match(new RegExp(`\\b${ordinalPattern}\\s+(?:row|line)\\b`));
          const columnOrdinal = text.match(new RegExp(`\\b(?:column|col)\\s+(?:number\\s+)?${ordinalPattern}\\b`)) ||
            text.match(new RegExp(`\\b${ordinalPattern}\\s+(?:column|col)\\b`));
          if (rowOrdinal && columnOrdinal) {
            const values = rowOrdinal[0].match(new RegExp(ordinalPattern, "g"));
            const columns = columnOrdinal[0].match(new RegExp(ordinalPattern, "g"));
            return { row: ordinalValue(values[0]) - 1, col: ordinalValue(columns[0]) - 1 };
          }
          if (rowMatch && columnOrdinal && /\brow\b/.test(text)) {
            const values = columnOrdinal[0].match(new RegExp(ordinalPattern, "g"));
            return {
              row: /top|upper|north/.test(rowMatch[1]) ? 0 : SIZE - 1,
              col: ordinalValue(values[0]) - 1
            };
          }
          if (columnMatch && rowOrdinal && /\bcolumn\b/.test(text)) {
            const values = rowOrdinal[0].match(new RegExp(ordinalPattern, "g"));
            return {
              row: ordinalValue(values[0]) - 1,
              col: /left|west/.test(columnMatch[1]) ? 0 : SIZE - 1
            };
          }

          const positionMatch = text.match(new RegExp(`\\b${ordinalPattern}\\b`));
          const spacePosition = positionMatch ? ordinalValue(positionMatch[0]) : null;
          const hasSpace = /\b(space|cell|square|spot)\b/.test(text);
          if (spacePosition && hasSpace && rowMatch) {
            return {
              row: /top|upper|north/.test(rowMatch[1]) ? 0 : SIZE - 1,
              col: spacePosition - 1
            };
          }
          if (spacePosition && hasSpace && columnMatch) {
            return {
              row: spacePosition - 1,
              col: /left|west/.test(columnMatch[1]) ? 0 : SIZE - 1
            };
          }

          if (rowMatch && !columnMatch && /\b(row|edge|side|end)\b/.test(text)) {
            return { row: /top|upper|north/.test(rowMatch[1]) ? 0 : SIZE - 1, col: drone.col };
          }
          if (columnMatch && !rowMatch && /\b(column|col|edge|side|end)\b/.test(text)) {
            return { row: drone.row, col: /left|west/.test(columnMatch[1]) ? 0 : SIZE - 1 };
          }
          return null;
        }

        function parseVoiceCommands(transcript) {
          const text = transcript.toLowerCase().replace(/[’]/g, "'").trim();
          if (/\b(?:don't|do not|not|never)\b/.test(text)) return [];
          const clauses = text.split(/\b(?:and\s+then|then|afterwards|followed\s+by)\b|\band\s+(?=(?:go|move|fly|head|do|perform|find|count|turn|look|scan|describe|report|ascend|descend|climb|rise)\b)/).filter((part) => part.trim());
          if (clauses.length > 1) {
            const commands = clauses.map(parseVoiceCommands);
            // Reject an incomplete sequence rather than silently executing only part of it.
            return commands.every((part) => part.length) ? commands.flat() : [];
          }
          if (/^(?:please\s+)?(?:stop|halt|cancel)(?:\s+(?:now|please|moving|everything|all|commands|the drone))*[.!?]*$/.test(text)) return [{ type: "stop" }];
          if (/\b(?:what (?:can|do) you see|what is visible|describe (?:your )?(?:view|surroundings)|look around|scan (?:the )?(?:area|surroundings)|report (?:your )?vision)\b/.test(text)) {
            return [{ type: "vision-report" }];
          }
          if (/\b(?:count|how many|number of)\b/.test(text) && /\b(?:walls?|obstacles?|blocks?)\b/.test(text)) return [{ type: "count-walls" }];
          if (/\b(?:nearest|closest)\b/.test(text) && /\b(?:wall|obstacle|block)\b/.test(text)) return [{ type: "nearest-wall" }];
          if (/\bbarrel\s+roll\b/.test(text)) return [{ type: "barrel-roll" }];
          if (IS_3D) {
            const spatial = parseSpatialCommand(text);
            if (spatial !== null) return spatial;
          }
          const words = text.match(/\b[a-z0-9]+(?:st|nd|rd|th)?\b/g) || [];
          const directions = words.map(directionForWord).filter(Boolean);
          const continueUntilBlocked = /\b(?:until|till|til)\b/.test(text) ||
            /\b(?:to|before)\s+(?:the\s+)?(?:wall|obstacle|block)\b/.test(text);
          if (continueUntilBlocked && directions.length) {
            return directions.length === 1 ? [{ type: "until-blocked", direction: directions[0] }] : [];
          }

          if (directions.length === 1 && /\b(?:all the way|as far as|to the very|to the far|edge|side|end)\b/.test(text) &&
              !/\b(corner|row|column|col|space|cell|square|spot)\b/.test(text)) {
            return [{ type: "edge", direction: directions[0] }];
          }

          const amount = words.map(ordinalValue).find(Boolean);
          if (directions.length === 1 && amount && /\b(one|two|three|four|five|six|seven|[1-7])\b/.test(text) &&
              /\b(steps?|spaces?|cells?|squares?|spots?|times)\b/.test(text) &&
              !/\b(corner|row|column|col|top|bottom|on|at)\b/.test(text)) {
            return [{ type: "direction", direction: directions[0], steps: amount }];
          }
          const destination = parseDestination(text);
          if (destination) {
            return [{ type: "destination", ...destination }];
          }
          if (/\b(corner|row|column|col|space|cell|square|spot|center|centre|middle)\b/.test(text) ||
              (rowMatchForDestination(text) && columnMatchForDestination(text))) return [];

          if (/\b[a-z]\s*\d+\b/.test(text)) return [];
          if (/\b\d+\b/.test(text) && !amount) return [];
          const movementIntent = /\b(?:go|move|fly|head|travel|navigate|proceed|turn|ascend|descend|climb|rise)\b/.test(text);
          const directionOnly = words.length === 1 && directions.length === 1;
          if (!movementIntent && !directionOnly) return [];
          if (directions.length !== 1) return [];
          return [{ type: "direction", direction: directions[0], steps: amount || 1 }];
        }

        function rowMatchForDestination(text) {
          return /\b(top|upper|north|bottom|lower|south)\b/.test(text);
        }

        function columnMatchForDestination(text) {
          return /\b(left|west|right|east)\b/.test(text);
        }

        function inBounds(row, col, level = drone.level || 0) {
          return row >= 0 && row < SIZE && col >= 0 && col < SIZE && level >= 0 && level < LEVELS;
        }

        function positionName(location) {
          const { row, col, level } = coordinates(location);
          return `${String.fromCharCode(65 + col)}${row + 1}${IS_3D ? ` · L${level + 1}` : ""}`;
        }

        // Dijkstra: settle the cheapest frontier cell and relax each traversable edge.
        // Every orthogonal move costs one; walls have no traversable edges.
        function dijkstra() {
          const startKey = positionKey(drone);
          const frontier = [{ location: startKey, distance: 0 }];
          const previous = new Map([[startKey, null]]);
          const distances = new Map([[startKey, 0]]);
          const settled = new Set();
          while (frontier.length) {
            frontier.sort((a, b) => a.distance - b.distance);
            const current = frontier.shift();
            if (settled.has(current.location)) continue;
            settled.add(current.location);
            const position = coordinates(current.location);
            for (const direction of Object.keys(OFFSETS)) {
              const next = neighbor(position, direction);
              const nextKey = positionKey(next);
              if (!inBounds(next.row, next.col, next.level) || knownObstacles.has(nextKey) || settled.has(nextKey)) continue;
              const distance = current.distance + 1;
              if (distance >= (distances.get(nextKey) ?? Infinity)) continue;
              distances.set(nextKey, distance);
              previous.set(nextKey, { key: current.location, direction });
              frontier.push({ location: nextKey, distance });
            }
          }
          return { startKey, previous, distances };
        }

        function reconstructRoute(search, targetKey) {
          if (!search.distances.has(targetKey)) return null;
          const route = [];
          let currentKey = targetKey;
          while (currentKey !== search.startKey) {
            const step = search.previous.get(currentKey);
            route.push(step.direction);
            currentKey = step.key;
          }
          return route.reverse();
        }

        async function navigateTo(targetKey, search = dijkstra(), description = positionName(targetKey)) {
          const route = reconstructRoute(search, targetKey);
          if (route === null) return `I can't reach ${description}. No clear path exists.`;
          const destination = description === positionName(targetKey) ? description : `${description} at ${positionName(targetKey)}`;
          if (!route.length) return `Already at ${destination}.`;
          if (activeJob) updateReply(activeJob.reply, `Navigating to ${description}: shortest path is ${route.length} move${route.length === 1 ? "" : "s"}. Avoiding walls automatically.`);
          const startingMoveCount = moveCount;
          const completed = await moveAlong(route, positionName(targetKey), targetKey);
          if (!completed) {
            if (knownObstacles.has(targetKey)) return `${positionName(targetKey)} is a wall in my current vision. Choose a clear destination.`;
            return `I can't reach ${destination} using the walls currently known to me.`;
          }
          const moves = moveCount - startingMoveCount;
          return `Reached ${destination} in ${moves} move${moves === 1 ? "" : "s"} using the shortest path known from my current vision.`;
        }

        async function moveToDestination(row, col, level = drone.level || 0) {
          if (!inBounds(row, col, level)) return `That destination is outside the grid. Use columns A–G and rows 1–7${IS_3D ? ", levels 1–4" : ""}.`;
          const targetKey = key(row, col, level);
          if (knownObstacles.has(targetKey)) return `${positionName(targetKey)} is a wall in my current vision. Choose a clear destination, or ask me to find the nearest wall.`;
          return navigateTo(targetKey);
        }

        async function moveToEdge(direction) {
          const version = navigationVersion;
          while (version === navigationVersion) {
            const search = dijkstra();
            const candidates = [...search.distances.keys()].filter((location) => {
              const { row, col, level } = coordinates(location);
              if (direction === "ascend") return level === LEVELS - 1;
              if (direction === "descend") return level === 0;
              return direction === "left" ? col === 0 : direction === "right" ? col === SIZE - 1 : direction === "up" ? row === 0 : row === SIZE - 1;
            });
            candidates.sort((a, b) => search.distances.get(a) - search.distances.get(b));
            if (!candidates.length) return `I can't reach the ${direction} edge using the walls currently known to me.`;
            const target = candidates[0];
            const result = await navigateTo(target, search, `the ${direction} edge`);
            if (version !== navigationVersion) return result;
            if (positionKey(drone) === target) return result;
            const updatedSearch = dijkstra();
            if (knownObstacles.has(target) || !updatedSearch.distances.has(target)) continue;
            return result;
          }
          return "Movement cancelled.";
        }

        function countWalls() {
          const remaining = new Set(knownObstacles);
          let count = 0;
          for (const location of knownObstacles) {
            if (!remaining.delete(location)) continue;
            count += 1;
            const stack = [location];
            while (stack.length) {
              const position = coordinates(stack.pop());
              for (const direction of Object.keys(OFFSETS)) {
                const adjacent = positionKey(neighbor(position, direction));
                if (remaining.delete(adjacent)) stack.push(adjacent);
              }
            }
          }
          return count;
        }

        async function findNearestWall() {
          if (!knownObstacles.size) return "I haven't seen any walls yet. Unknown cells may still contain walls.";
          const search = dijkstra();
          let nearest = null;
          let distance = Infinity;
          for (const wall of knownObstacles) {
            const position = coordinates(wall);
            for (const direction of Object.keys(OFFSETS)) {
              const location = positionKey(neighbor(position, direction));
              const cost = search.distances.get(location) ?? Infinity;
              if (cost < distance) {
                nearest = { location, wall };
                distance = cost;
              }
            }
          }
          if (!nearest) return "No wall has a reachable adjacent cell.";
          return navigateTo(nearest.location, search, `the nearest wall (wall cell ${positionName(nearest.wall)})`);
        }

        async function moveUntilBlocked(direction) {
          const route = [];
          let position = { ...drone };
          let stopStatus = "Blocked";

          for (let step = 0; step <= SIZE; step += 1) {
            const next = neighbor(position, direction);
            if (!inBounds(next.row, next.col, next.level)) {
              stopStatus = "Edge";
              break;
            }
            if (knownObstacles.has(positionKey(next))) break;
            route.push(direction);
            position = next;
          }
          const completed = await moveAlong(route, stopStatus);
          return completed ? `Stopped at ${positionLabel.textContent}, before ${stopStatus === "Edge" ? "the grid edge" : "a wall"}. Moved ${route.length} cell${route.length === 1 ? "" : "s"}.` : "Movement cancelled.";
        }

        async function executeVoiceCommand(command) {
          if (command.type === "altitude") {
            return moveToDestination(drone.row, drone.col, command.level);
          } else if (command.type === "destination") {
            return moveToDestination(command.row, command.col, command.level);
          } else if (command.type === "edge") {
            return moveToEdge(command.direction);
          } else if (command.type === "nearest-wall") {
            return findNearestWall();
          } else if (command.type === "count-walls") {
            const count = countWalls();
            return `I know of ${count} connected wall${count === 1 ? "" : "s"}, covering ${knownObstacles.size} seen wall cell${knownObstacles.size === 1 ? "" : "s"}. Cells sharing a side form one wall; unknown areas may contain more.`;
          } else if (command.type === "vision-report") {
            const visibleWallCount = [...visibleCells].filter((location) => knownObstacles.has(location)).length;
            const rememberedWallCount = knownObstacles.size - visibleWallCount;
            const unknownCount = SIZE * SIZE * LEVELS - seenCells.size;
            return `I can currently see ${visibleCells.size} cells, including ${visibleWallCount} wall${visibleWallCount === 1 ? "" : "s"}. I remember ${rememberedWallCount} wall${rememberedWallCount === 1 ? "" : "s"} outside my current view; ${unknownCount} cell${unknownCount === 1 ? " is" : "s are"} still unknown.`;
          } else if (command.type === "barrel-roll") {
            const version = navigationVersion;
            navigating = true;
            setArrowControlsDisabled(true);
            document.querySelector(".drone").classList.add("rolling");
            if (activeJob) updateReply(activeJob.reply, "Doing a barrel roll!");
            await new Promise((resolve) => window.setTimeout(resolve, 850));
            if (version !== navigationVersion) return "Barrel roll cancelled.";
            navigating = false;
            setArrowControlsDisabled(false);
            renderBoard();
            return `Barrel roll complete! Holding position at ${positionLabel.textContent}.`;
          } else if (command.type === "until-blocked") {
            return moveUntilBlocked(command.direction);
          } else {
            if (command.steps > 1) {
              const [dr, dc, dl = 0] = OFFSETS[command.direction];
              return moveToDestination(drone.row + dr * command.steps, drone.col + dc * command.steps, (drone.level || 0) + dl * command.steps);
            }
            const moved = move(command.direction);
            return moved ? `Moved ${command.direction} to ${positionLabel.textContent}.` : `Can't move ${command.direction}: ${statusMessage.textContent === "Edge" ? "the grid edge is here" : "a wall is in the way"}. Ask for a destination to route around walls.`;
          }
        }

        async function processCommandQueue() {
          if (processingCommands) return;
          processingCommands = true;
          try {
            while (commandQueue.length) {
              const job = commandQueue.shift();
              activeJob = job;
              const replies = [];
              try {
                for (const command of job.commands) {
                  if (job.version !== navigationVersion) break;
                  const reply = await executeVoiceCommand(command);
                  if (job.version !== navigationVersion) break;
                  replies.push(reply);
                  updateReply(job.reply, replies.join(" "));
                }
              } catch (error) {
                if (job.version === navigationVersion) {
                  updateReply(job.reply, "I couldn't complete that command. Please try again.");
                  setStatus("Command failed", "error");
                  navigating = false;
                  setArrowControlsDisabled(false);
                  renderBoard();
                }
                console.error(error);
              } finally {
                activeJob = null;
              }
            }
          } finally {
            processingCommands = false;
            if (commandQueue.length) processCommandQueue();
          }
        }

        function scheduleRecognitionRestart(error) {
          if (!listening) return;
          window.clearTimeout(restartTimer);

          if (error === "network") {
            setStatus("Retrying…", "listening");
          } else if (error === "no-speech") {
            setStatus("On", "listening");
          } else {
            setStatus("Reconnecting…", "listening");
          }

          const delay = restartDelay;
          restartTimer = window.setTimeout(() => {
            if (listening) startRecognition();
          }, error === "no-speech" ? 300 : delay);
          if (error !== "no-speech") restartDelay = Math.min(restartDelay * 2, 5000);
        }

        function stopListening() {
          listening = false;
          window.clearTimeout(restartTimer);
          window.clearTimeout(stableTimer);
          voicePreview.textContent = "";
          updateListenButton();
          if (recognition && recognitionActive) recognition.stop();
          setStatus("Off");
        }

        function startRecognition() {
          const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
          if (!SpeechRecognition || !listening || recognitionActive) return;

          const currentRecognition = new SpeechRecognition();
          recognition = currentRecognition;
          currentRecognition.lang = "en-US";
          currentRecognition.continuous = true;
          currentRecognition.interimResults = true;
          const processedResults = new Set();

          currentRecognition.onstart = () => {
            if (recognition !== currentRecognition) return;
            if (!listening) {
              currentRecognition.stop();
              return;
            }
            recognitionActive = true;
            window.clearTimeout(stableTimer);
            stableTimer = window.setTimeout(() => {
              restartDelay = 300;
            }, 10000);
            setStatus("On", "listening");
          };
          currentRecognition.onresult = (event) => {
            if (recognition !== currentRecognition || !listening) return;
            const interim = [];
            for (let index = event.resultIndex; index < event.results.length; index += 1) {
              const result = event.results[index];
              const transcript = result[0].transcript;
              if (!result.isFinal) {
                interim.push(transcript.trim());
              } else if (!processedResults.has(index)) {
                processedResults.add(index);
                submitCommand(transcript, "voice");
              }
            }
            voicePreview.textContent = interim.length ? `Hearing: ${interim.join(" ")}…` : "";
          };
          currentRecognition.onerror = (event) => {
            if (recognition !== currentRecognition) return;
            if (event.error === "aborted") return;
            const messages = {
              "not-allowed": "Mic access denied",
              "service-not-allowed": "Service denied",
              "audio-capture": "No microphone",
            };
            if (event.error === "network" || event.error === "no-speech") {
              lastRecognitionError = event.error;
            } else {
              setStatus(messages[event.error] || `Error: ${event.error}`, "error");
              addMessage("Drone", `${messages[event.error] || "Voice recognition failed"}. You can still type a command below.`);
              voicePreview.textContent = "";
              listening = false;
              updateListenButton();
            }
          };
          currentRecognition.onend = () => {
            if (recognition !== currentRecognition) return;
            recognitionActive = false;
            voicePreview.textContent = "";
            window.clearTimeout(stableTimer);
            if (!listening) return;
            scheduleRecognitionRestart(lastRecognitionError);
            lastRecognitionError = null;
          };

          try {
            currentRecognition.start();
          } catch (error) {
            recognitionActive = false;
            listening = false;
            updateListenButton();
            setStatus("Start failed", "error");
          }
        }

        function startListening() {
          const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
          if (!SpeechRecognition) {
            setStatus("Unsupported", "error");
            addMessage("Drone", "Voice recognition isn't supported in this browser. Type your commands below, or use Chrome or Edge for voice control.");
            return;
          }

          listening = true;
          updateListenButton();
          setStatus("Starting…");
          startRecognition();
        }

        listenButton.addEventListener("click", () => {
          if (listening) stopListening();
          else startListening();
        });
        document.querySelectorAll(".arrow").forEach((button) => {
          button.addEventListener("click", () => {
            if (!navigating) submitCommand(`move ${button.dataset.direction}`, "button");
          });
        });
        document.querySelector("#command-form").addEventListener("submit", (event) => {
          event.preventDefault();
          submitCommand(commandInput.value);
          commandInput.value = "";
          commandInput.focus();
        });
        document.querySelector("#stop-button").addEventListener("click", () => submitCommand("stop", "button"));
        document.querySelector("#reset-button").addEventListener("click", () => {
          cancelCommands("Cancelled because the grid was regenerated.");
          drone = { row: 3, col: 3, level: 0 };
          viewLevel = 0;
          moveCount = 0;
          knownObstacles = new Set();
          seenCells = new Set();
          visibleCells = new Set();
          generateObstacles();
          renderBoard();
          setStatus("Ready");
          addMessage("Drone", `New grid ready. Position reset to ${positionLabel.textContent}, move count reset, and vision memory cleared.`);
        });

        if (IS_3D) initializeSpatialControls();
        generateObstacles();
        renderBoard();
        addMessage("Drone", `Ready at ${positionLabel.textContent}. I only know what I can see or remember; hidden cells stay unknown. Type or say a command such as “go to G7” or “what can you see?”. ${IS_3D ? 'Use “ascend”, “descend”, or “go to G7 level 3” to fly between altitudes. ' : ''}Say “stop” or press Stop to cancel movement.`);
      })();
