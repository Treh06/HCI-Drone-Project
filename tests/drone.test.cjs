const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

// Run the real page script with a small DOM and deterministic animation timers.
// Hooks exist only in this test's VM; the page does not expose test globals.
function createApp(walls = [], position = { row: 2, col: 2 }) {
  class Element {
    children = [];
    dataset = {};
    attributes = {};
    listeners = {};
    value = '';
    _text = '';
    classList = { add() {} };
    append(...elements) { this.children.push(...elements); }
    replaceChildren(...elements) { this.children = elements; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    focus() {}
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  }
  const elements = new Map();
  const arrows = ['up', 'right', 'down', 'left'].map((direction) => {
    const element = new Element();
    element.dataset.direction = direction;
    return element;
  });
  const document = {
    createElement: () => new Element(),
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    },
    querySelectorAll: () => arrows,
  };
  let timerId = 0;
  const timers = new Map();
  const recognitions = [];
  class SpeechRecognition {
    constructor() { recognitions.push(this); }
    start() { this.onstart(); }
    stop() { this.onend(); }
  }
  const window = {
    SpeechRecognition,
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n/g, '\n');
  const hooks = `globalThis.api = {
    parseVoiceCommands, dijkstra, reconstructRoute, countWalls, submitCommand,
    startListening, stopListening,
    setWorld(walls, position) { obstacles = new Set(walls); drone = position; moveCount = 0; renderBoard(); },
    state() { return { ...drone, moveCount, processingCommands, navigating, navigationVersion }; }
  };`;
  const context = vm.createContext({ document, window, console });
  vm.runInContext(script.replace('        generateObstacles();\n        renderBoard();', hooks), context);
  const api = context.api;
  api.setWorld(walls, position);
  return {
    api, elements, recognitions, arrows,
    parse: (text) => JSON.parse(JSON.stringify(api.parseVoiceCommands(text))),
    messages: () => document.querySelector('#history-list').children.map((entry) => entry.textContent),
    async flush() {
      for (let iteration = 0; iteration < 300; iteration++) {
        await new Promise(setImmediate);
        const next = [...timers].find(([, timer]) => timer.delay <= 850);
        if (next) { timers.delete(next[0]); next[1].callback(); }
        else if (!api.state().processingCommands) return;
      }
      assert.fail('Command queue did not finish');
    },
  };
}

test('natural commands distinguish steps, edges, destinations, and stopping at a wall', () => {
  const app = createApp();
  for (const phrase of ['Go all the way left', 'fly as far as possible west', 'go to the left edge']) {
    assert.deepEqual(app.parse(phrase), [{ type: 'edge', direction: 'left' }]);
  }
  assert.deepEqual(app.parse('go left'), [{ type: 'direction', direction: 'left', steps: 1 }]);
  assert.deepEqual(app.parse('move three cells right'), [{ type: 'direction', direction: 'right', steps: 3 }]);
  assert.deepEqual(app.parse('move one cell left'), [{ type: 'direction', direction: 'left', steps: 1 }]);
  assert.deepEqual(app.parse('keep going right until a wall'), [{ type: 'until-blocked', direction: 'right' }]);
  assert.deepEqual(app.parse('go to F6'), [{ type: 'destination', row: 5, col: 5 }]);
  assert.deepEqual(app.parse('go to the southwest corner'), [{ type: 'destination', row: 5, col: 0 }]);
  assert.deepEqual(app.parse('head over to row three, column two'), [{ type: 'destination', row: 2, col: 1 }]);
  assert.deepEqual(app.parse('take the second spot on top'), [{ type: 'destination', row: 0, col: 1 }]);
  assert.equal(app.parse('find the nearest wall')[0].type, 'nearest-wall');
  assert.equal(app.parse('Count how many walls there are')[0].type, 'count-walls');
  assert.equal(app.parse('Do a barrel roll')[0].type, 'barrel-roll');
  assert.deepEqual(app.parse('go left then do a barrel roll').map((command) => command.type), ['direction', 'barrel-roll']);
  for (const phrase of ['hello drone', "don't go right", 'go to G7', 'move 99 left', 'go left then nonsense']) {
    assert.deepEqual(app.parse(phrase), [], phrase);
  }
});

test('Dijkstra finds an eight-step detour and never crosses a wall', () => {
  const walls = ['0,3', '1,3', '2,3', '3,3', '4,3'];
  const { api } = createApp(walls);
  const route = api.reconstructRoute(api.dijkstra(), '2,4');
  assert.equal(route.length, 8);
  let row = 2, col = 2;
  const offsets = { up: [-1, 0], right: [0, 1], down: [1, 0], left: [0, -1] };
  for (const direction of route) {
    const [dr, dc] = offsets[direction]; row += dr; col += dc;
    assert.ok(!walls.includes(`${row},${col}`));
    assert.ok(row >= 0 && row < 6 && col >= 0 && col < 6);
  }
  assert.deepEqual([row, col], [2, 4]);
});

test('Dijkstra distances match an independent breadth-first oracle on varied grids', () => {
  let seed = 57;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let trial = 0; trial < 40; trial++) {
    const walls = new Set();
    for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) {
      if ((row !== 2 || col !== 2) && random() < 0.3) walls.add(`${row},${col}`);
    }
    const expected = new Map([['2,2', 0]]);
    const queue = [[2, 2]];
    for (let i = 0; i < queue.length; i++) {
      const [row, col] = queue[i];
      for (const [r, c] of [[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]]) {
        const location = `${r},${c}`;
        if (r < 0 || r > 5 || c < 0 || c > 5 || walls.has(location) || expected.has(location)) continue;
        expected.set(location, expected.get(`${row},${col}`) + 1);
        queue.push([r, c]);
      }
    }
    const { api } = createApp([...walls]);
    const actual = api.dijkstra();
    assert.equal(actual.distances.size, expected.size);
    for (const [location, distance] of expected) {
      assert.equal(actual.distances.get(location), distance);
      assert.equal(api.reconstructRoute(actual, location).length, distance);
    }
  }
});

test('typed destination and edge commands automatically detour and report the result in chat', async () => {
  const app = createApp(['0,1', '1,1', '2,1', '3,1', '4,1']);
  const form = app.elements.get('#command-form');
  app.elements.get('#command-input').value = 'Go all the way left';
  form.listeners.submit({ preventDefault() {} });
  await app.flush();
  assert.equal(app.api.state().col, 0);
  assert.equal(app.api.state().moveCount, 5);
  assert.match(app.messages().at(-1), /Reached the left edge.*5 moves/);
  assert.ok(app.messages().some((message) => message.includes('You · typedGo all the way left')));
  assert.equal(app.elements.get('#command-input').value, '');
});

test('blocked and disconnected destinations stay in place and explain failure', async () => {
  const app = createApp(['1,2', '2,1', '2,3', '3,2']);
  app.api.submitCommand('go to F6');
  await app.flush();
  assert.equal(app.api.state().moveCount, 0);
  assert.match(app.messages().at(-1), /No clear path/);
  app.api.submitCommand('go to D3');
  await app.flush();
  assert.match(app.messages().at(-1), /contains a wall/);
});

test('nearest wall stops beside it by the shortest route and counting groups touching cells', async () => {
  const app = createApp(['0,0', '0,1', '4,4', '5,4', '5,5']);
  assert.equal(app.api.countWalls(), 2);
  app.api.submitCommand('find the nearest wall');
  await app.flush();
  assert.equal(app.api.state().moveCount, 2);
  assert.match(app.messages().at(-1), /nearest wall.*2 moves/);
  app.api.submitCommand('count how many walls there are');
  await app.flush();
  assert.match(app.messages().at(-1), /2 connected walls, covering 5 blocked cells/);
  const empty = createApp();
  empty.api.submitCommand('find the nearest wall');
  await empty.flush();
  assert.match(empty.messages().at(-1), /no walls/);
});

test('until-wall stops immediately before a wall; barrel roll preserves position and move count', async () => {
  const app = createApp(['2,4']);
  app.api.submitCommand('right until a wall then do a barrel roll');
  await app.flush();
  assert.deepEqual([app.api.state().row, app.api.state().col, app.api.state().moveCount], [2, 3, 1]);
  assert.match(app.messages().at(-1), /before a wall.*Barrel roll complete/);
  assert.equal(app.api.state().navigating, false);
  assert.ok(app.arrows.every((arrow) => !arrow.disabled));
});

test('stop cancels active movement and queued commands without stale completion replies', async () => {
  const app = createApp();
  app.api.submitCommand('go to F6');
  app.api.submitCommand('do a barrel roll');
  const stoppedAt = app.api.state().moveCount;
  app.api.submitCommand('stop');
  app.api.submitCommand('count walls');
  await app.flush();
  assert.equal(app.api.state().moveCount, stoppedAt);
  assert.equal(app.messages().filter((message) => message.includes('Cancelled by stop')).length, 2);
  assert.match(app.messages().at(-1), /0 connected walls/);
});

test('regenerate cancels a roll and queued route and resets the board', async () => {
  const app = createApp();
  app.api.submitCommand('do a barrel roll');
  app.api.submitCommand('go to F6');
  app.elements.get('#reset-button').listeners.click();
  await app.flush();
  assert.deepEqual([app.api.state().row, app.api.state().col, app.api.state().moveCount], [2, 2, 0]);
  assert.equal(app.messages().filter((message) => message.includes('Cancelled because')).length, 2);
  assert.match(app.messages().at(-1), /New grid ready/);
});

test('speech revisions show a preview and execute only once when final', async () => {
  const app = createApp();
  app.api.startListening();
  const recognition = app.recognitions[0];
  const result = (text, isFinal) => Object.assign([{ transcript: text }], { isFinal });
  recognition.onresult({ resultIndex: 0, results: [result('go right', false)] });
  recognition.onresult({ resultIndex: 0, results: [result('go all the way right', false)] });
  assert.equal(app.api.state().moveCount, 0);
  assert.match(app.elements.get('#voice-preview').textContent, /go all the way right/);
  const event = { resultIndex: 0, results: [result('go all the way right', true)] };
  recognition.onresult(event);
  recognition.onresult(event);
  await app.flush();
  assert.equal(app.api.state().moveCount, 3);
  assert.equal(app.messages().filter((message) => message.includes('You · voice')).length, 1);
  assert.equal(app.elements.get('#voice-preview').textContent, '');
  recognition.onresult({ resultIndex: 1, results: [event.results[0], result('what is this', true)] });
  assert.match(app.messages().at(-1), /didn't understand/);
  app.api.stopListening();
});

test('chat renders command text as text, including unrecognized input', () => {
  const app = createApp();
  app.api.submitCommand('<img src=x onerror=alert(1)>');
  const user = app.elements.get('#history-list').children.at(-2);
  assert.equal(user.children[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(user.children[1].innerHTML, undefined);
  assert.match(app.messages().at(-1), /didn't understand/);
});
