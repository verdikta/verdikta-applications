// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// @testing-library/react 13 with React 18.3 prints this deprecation on the first render
// of every test file. It says nothing about the code under test.
const realConsoleError = console.error;
console.error = (...args) => {
  if (String(args[0]).includes('ReactDOMTestUtils.act')) return;
  realConsoleError(...args);
};
