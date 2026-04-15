import { useEffect, useState } from 'react';
import { Bot, Sparkles } from 'lucide-react';
import { apiService } from '../services/api';
import './Home.css';

function Home() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiService.getStatus()
      .then(setStatus)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="coming-soon">
      <div className="coming-soon-icon">
        <Bot size={64} />
      </div>
      <h1>Verdikta Agents</h1>
      <p className="tagline">
        <Sparkles size={16} className="inline-icon" /> Coming soon
      </p>
      <p className="description">
        A scaffold for the Verdikta Agents application. This project is just getting started;
        check back as the feature set grows.
      </p>

      {status && (
        <div className="status-card">
          <code>
            {status.project} v{status.version} — {status.status}
          </code>
        </div>
      )}
      {error && (
        <div className="status-card status-error">
          <code>API unreachable: {error}</code>
        </div>
      )}
    </div>
  );
}

export default Home;
