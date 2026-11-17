/**
 * A template's pieces in order, for a line whose values are drawn apart from its words (a chip, a pill): the
 * text between its {names}, and each {name} with its value. Joined, the pieces are fill(template, vars)
 * (strings.js), character for character, so the page's text is the line the strings say; a {name} with no
 * value stays as text, as fill leaves it.
 * @param {string} template
 * @param {Record<string, unknown>} [vars]
 * @returns {({ text: string } | { name: string, value: string })[]}
 */
export function pieces(template, vars = {}) {
  return template
    .split(/(\{\w+\})/)
    .filter((p) => p !== '')
    .map((p) => {
      const name = /^\{(\w+)\}$/.exec(p)?.[1];
      return name && Object.hasOwn(vars, name) ? { name, value: String(vars[name]) } : { text: p };
    });
}

/** The pieces' text, joined: what the page's text holds. */
export const joined = (list) => list.map((p) => p.text ?? p.value).join('');
