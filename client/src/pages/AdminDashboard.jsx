import { useEffect, useState } from 'react';

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api/dashboard';

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

export default function AdminDashboard() {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const loadSessions = async () => {
      setLoadingList(true);
      setError('');
      try {
        const res = await fetch(`${API_BASE}/sessions`, {
          headers: {
            'Content-Type': 'application/json',
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        data.sort((a, b) => {
          const aScore = a.evaluationScores?.overallScore ?? -1;
          const bScore = b.evaluationScores?.overallScore ?? -1;
          return bScore - aScore;
        });
        setSessions(data);
      } catch (err) {
        setError(`Failed to load sessions: ${err.message}`);
      } finally {
        setLoadingList(false);
      }
    };

    loadSessions();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSelectedDetail(null);
      return;
    }

    const loadDetail = async () => {
      setLoadingDetail(true);
      setError('');
      try {
        const res = await fetch(`${API_BASE}/sessions/${selectedId}`, {
          headers: {
            'Content-Type': 'application/json',
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setSelectedDetail(data);
      } catch (err) {
        setError(`Failed to load session detail: ${err.message}`);
      } finally {
        setLoadingDetail(false);
      }
    };

    loadDetail();
  }, [selectedId]);

  const renderScores = (scores) => {
    if (!scores) return '—';
    const {
      conceptualUnderstanding,
      problemSolving,
      communication,
      responseCompleteness,
      overallScore,
    } = scores;

    return (
      <div className="scores-grid">
        <div><strong>Overall</strong>: {overallScore ?? '—'}</div>
        <div><strong>Conceptual</strong>: {conceptualUnderstanding ?? '—'}</div>
        <div><strong>Problem Solving</strong>: {problemSolving ?? '—'}</div>
        <div><strong>Communication</strong>: {communication ?? '—'}</div>
        <div><strong>Completeness</strong>: {responseCompleteness ?? '—'}</div>
      </div>
    );
  };

  return (
    <div className="dashboard-root">
      <section className="dashboard-list">
        <h2>Interview Sessions</h2>
        {loadingList && <div className="dashboard-status">Loading sessions...</div>}
        {error && <div className="dashboard-error">{error}</div>}
        <table className="sessions-table">
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Role</th>
              <th>Status</th>
              <th>Overall</th>
              <th>Started</th>
              <th>Ended</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr
                key={s._id}
                className={selectedId === s._id ? 'session-row selected' : 'session-row'}
                onClick={() => setSelectedId(s._id)}
              >
                <td>{s.candidateName}</td>
                <td>{s.jobRole}</td>
                <td>{s.status}</td>
                <td>{s.evaluationScores?.overallScore ?? '—'}</td>
                <td>{formatDate(s.startTime)}</td>
                <td>{formatDate(s.endTime)}</td>
              </tr>
            ))}
            {sessions.length === 0 && !loadingList && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center' }}>
                  No sessions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="dashboard-detail">
        <h2>Session Detail</h2>
        {loadingDetail && <div className="dashboard-status">Loading session...</div>}
        {!selectedDetail && !loadingDetail && (
          <div className="dashboard-placeholder">Select a session to view details.</div>
        )}
        {selectedDetail && (
          <div className="detail-content">
            <div className="detail-header">
              <div>
                <h3>{selectedDetail.session.candidateName}</h3>
                <p>{selectedDetail.session.jobRole}</p>
              </div>
              <div>{renderScores(selectedDetail.session.evaluationScores)}</div>
            </div>

            {selectedDetail.session.aiFeedback && (
              <div className="detail-card">
                <h4>AI Feedback</h4>
                <p>{selectedDetail.session.aiFeedback}</p>
              </div>
            )}

            <div className="detail-layout">
              <div className="detail-card">
                <h4>Transcript</h4>
                <div className="transcript-scroll">
                  {selectedDetail.transcripts.map((t) => (
                    <div key={t._id} className="transcript-line">
                      <span className="transcript-time">
                        {formatDate(t.timestamp)}
                      </span>
                      <span className="transcript-text">{t.text}</span>
                    </div>
                  ))}
                  {selectedDetail.transcripts.length === 0 && (
                    <div className="transcript-empty">No transcript segments recorded.</div>
                  )}
                </div>
              </div>

              <div className="detail-card">
                <h4>Monitoring Events</h4>
                <div className="events-scroll">
                  {selectedDetail.monitoringEvents.map((e) => (
                    <div key={e._id} className="event-line">
                      <span className="event-time">
                        {e.clientTimestamp
                          ? new Date(e.clientTimestamp).toLocaleTimeString()
                          : formatDate(e.serverTimestamp)}
                      </span>
                      <span className="event-type">{e.type}</span>
                    </div>
                  ))}
                  {selectedDetail.monitoringEvents.length === 0 && (
                    <div className="events-empty">No monitoring events recorded.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

