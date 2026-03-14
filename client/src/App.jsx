import { useState } from 'react';
import InterviewPage from './pages/InterviewPage';
import AdminDashboard from './pages/AdminDashboard';

function App() {
  const [mode, setMode] = useState('candidate'); // 'candidate' | 'recruiter'

  return (
    <div className="app-shell">
      <header className="app-shell-header">
        <div className="app-shell-title">Fineview</div>
        <div className="app-shell-tabs">
          <button
            type="button"
            className={mode === 'candidate' ? 'tab-button active' : 'tab-button'}
            onClick={() => setMode('candidate')}
          >
            Candidate Interview
          </button>
          <button
            type="button"
            className={mode === 'recruiter' ? 'tab-button active' : 'tab-button'}
            onClick={() => setMode('recruiter')}
          >
            Recruiter Dashboard
          </button>
        </div>
      </header>

      <main className="app-shell-main">
        {mode === 'candidate' ? <InterviewPage /> : <AdminDashboard />}
      </main>
    </div>
  );
}

export default App;
