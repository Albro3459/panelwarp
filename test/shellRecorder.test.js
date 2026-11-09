const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ShellRecorder } = require('../shellRecorder');

// A Warp hook as the bootstrap prints it (DCS with hex JSON)
function hook(name, value = {}) {
  const json = JSON.stringify({ hook: name, value: { ...value, session_id: 42 } });
  return `\x1bP$d${Buffer.from(json).toString('hex')}\x1b\\`;
}

const BOOTSTRAP = `bootstrap script\r\n${hook('InitShell')}${hook('Bootstrapped')}`;
const TITLE = '\x1b]0;~\x07';
const PROMPT_HOOK = hook('Precmd', { pwd: '/Users/me' });
const PROMPT = '\r\x1b[J\x1b]133;A\x07me@mac:~ % \x1b]133;B\x07\x1b[K\x1b[?2004h';
const INPUT_BUFFER = hook('InputBuffer', { buffer: '' });

// Warp asks for the input buffer once its input is up, then runs a completion in the shell
function inBandCommand(command = "warp_run_generator_command 1 'ls'") {
  return [
    INPUT_BUFFER,
    `\x1b[7m${command}\x1b[27m`,
    hook('Preexec', { command }),
    TITLE,
    hook('CommandFinished', { exit_code: 0 }),
    hook('Precmd', { pwd: '', is_after_in_band_command: true }),
    PROMPT,
    '\x1b]9277;A\x07' + Buffer.from('1;Desktop\nDocuments;0').toString('hex') + '\x1b]9277;B\x07',
  ];
}

function shellOutput(...chunks) {
  const recorder = new ShellRecorder();
  for (const chunk of chunks) recorder.record(Buffer.from(chunk, 'latin1'), true);
  return recorder;
}

function replayed(recorder) {
  return Buffer.concat(recorder.replay()).toString('latin1');
}

test("a reloaded page gets the prompt and title without the old page's completions", () => {
  const recorder = shellOutput(
    BOOTSTRAP,
    `%\r \r${TITLE}`,
    hook('CommandFinished', { exit_code: 0 }),
    PROMPT_HOOK,
    PROMPT,
    ...inBandCommand(),
    ...inBandCommand(),
    INPUT_BUFFER,
  );

  assert.equal(replayed(recorder), BOOTSTRAP + TITLE + PROMPT_HOOK + PROMPT);
  assert.equal(recorder.running, false);
});

test("fish's completions, typed with a leading space, are left out too", () => {
  const recorder = shellOutput(
    BOOTSTRAP,
    PROMPT_HOOK,
    PROMPT,
    ...inBandCommand(" warp_run_generator_command 1 'ls'"),
    INPUT_BUFFER,
  );

  assert.equal(replayed(recorder), BOOTSTRAP + TITLE + PROMPT_HOOK + PROMPT);
  assert.equal(recorder.running, false);
});

test("a reloaded page gets the user's running command with its echo", () => {
  const preexec = hook('Preexec', { command: 'sleep 60' });
  const recorder = shellOutput(
    BOOTSTRAP,
    PROMPT_HOOK,
    PROMPT,
    ...inBandCommand(),
    INPUT_BUFFER,
    '\x1b[?2004l\r\r\n',
    preexec,
    '\x1b]0;sleep\x07',
    'still sleeping',
  );

  assert.equal(
    replayed(recorder),
    BOOTSTRAP + '\x1b]0;sleep\x07' + PROMPT_HOOK + PROMPT + '\x1b[?2004l\r\r\n' + preexec + '\x1b]0;sleep\x07still sleeping',
  );
  assert.equal(recorder.running, true);
});

test('a reloaded page gets the latest prompt after Enter on an empty line', () => {
  const nextPromptHook = hook('Precmd', { pwd: '/Users/me', exit_code: 0 });
  const recorder = shellOutput(
    BOOTSTRAP,
    PROMPT_HOOK,
    PROMPT,
    ...inBandCommand(),
    INPUT_BUFFER,
    '\x1b[?2004l\r\r\n',
    hook('CommandFinished', { exit_code: 0 }),
    nextPromptHook,
    PROMPT,
    ...inBandCommand(),
  );

  assert.equal(replayed(recorder), BOOTSTRAP + TITLE + nextPromptHook + PROMPT);
});
