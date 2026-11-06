import { STRINGS } from './strings.js';

export default function App() {
  return (
    <main className="page">
      <h1>{STRINGS.appName}</h1>
      <p className="lead">{STRINGS.home.lead}</p>
      <p>{STRINGS.home.recordNote}</p>
      <p className="status">{STRINGS.home.status}</p>
    </main>
  );
}
