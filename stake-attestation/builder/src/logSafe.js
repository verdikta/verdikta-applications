// A runner reads every line a step prints as a possible workflow command: a line starting with "::", after any
// leading space, and "##[" anywhere in one. Some of what the builder prints quotes a maker's text (a failed
// step's detail can hold its build's output), and in the build job a command could set that step's outputs. So
// nothing the builder prints can be one. This changes what is printed only where it would have been a command.

/** The text, with no line a runner would take as a workflow command. */
export function neutralize(text) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/##\[/g, '## [')
    .split('\n')
    .map((line) => (/^\s*::/.test(line) ? line.replace('::', ': :') : line))
    .join('\n');
}

/** A stream whose every write goes through neutralize. */
export function guarded(stream) {
  return { write: (text) => stream.write(neutralize(text)) };
}
