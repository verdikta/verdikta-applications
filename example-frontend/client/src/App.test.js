import { render, screen } from '@testing-library/react';
import App from './App';

// A smoke test of the page a visitor lands on with no wallet: the playground's header, the network
// picker and the connect button render (create-react-app's "learn react" starter never matched this app).
test('renders the playground header with a network picker and a connect button, before any wallet', () => {
  render(<App />);
  expect(screen.getByText('Verdikta Playground')).toBeInTheDocument();
  // the header's network picker (the page has other selects further down)
  expect(document.querySelector('header .network-selector')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
});
