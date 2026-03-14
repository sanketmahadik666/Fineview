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
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

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

  const computeIntegrity = (events, session) => {
    if (!events || events.length === 0 || !session) {
      return {
        score: 100,
        tabSwitches: 0,
        suspicious: 0,
        faceLost: 0,
        multipleFaces: 0,
        label: 'High',
      };
    }

    let tabSwitches = 0;
    let suspicious = 0;
    let faceLost = 0;
    let multipleFaces = 0;

    events.forEach((e) => {
      if (e.type === 'tab_switch' && e.payload?.direction === 'away') {
        tabSwitches += 1;
      } else if (e.type === 'suspicious_action') {
        suspicious += 1;
      } else if (e.type === 'face_lost') {
        faceLost += 1;
      } else if (e.type === 'multiple_faces') {
        multipleFaces += 1;
      }
    });

    let score = 100;
    if (tabSwitches > 1) {
      score -= (tabSwitches - 1) * 5;
    }
    score -= suspicious * 10;
    score -= faceLost * 2;
    score -= multipleFaces * 5;
    if (score < 0) score = 0;

    let label = 'High';
    if (score < 40) label = 'Low';
    else if (score < 70) label = 'Medium';

    return {
      score,
      tabSwitches,
      suspicious,
      faceLost,
      multipleFaces,
      label,
    };
  };

  const filteredSessions = sessions.filter((s) => {
    if (roleFilter !== 'all' && s.jobRole !== roleFilter) return false;
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const haystack = `${s.candidateName || ''} ${s.jobRole || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    if (dateFrom) {
      const fromTime = new Date(dateFrom).getTime();
      const startTime = new Date(s.startTime).getTime();
      if (!Number.isNaN(fromTime) && !Number.isNaN(startTime) && startTime < fromTime) {
        return false;
      }
    }

    if (dateTo) {
      const toTime = new Date(dateTo).getTime();
      const startTime = new Date(s.startTime).getTime();
      if (!Number.isNaN(toTime) && !Number.isNaN(startTime) && startTime > toTime) {
        return false;
      }
    }

    return true;
  });

  const distinctRoles = Array.from(new Set(sessions.map((s) => s.jobRole).filter(Boolean)));

  const totalCount = sessions.length;
  const filteredCount = filteredSessions.length;

  return (
    <div className="dashboard-root">
      <section className="dashboard-list">
        <h2>Interview Sessions</h2>
        {loadingList && <div className="dashboard-status">Loading sessions...</div>}
        {error && <div className="dashboard-error">{error}</div>}
        <div className="dashboard-meta">
          <span>
            Showing {filteredCount} of {totalCount} sessions
          </span>
        </div>
        <div className="dashboard-filters">
          <input
            type="text"
            placeholder="Search candidate or role..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
          >
            <option value="all">All roles</option>
            {distinctRoles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="in-progress">In progress</option>
            <option value="completed">Completed</option>
            <option value="aborted">Aborted</option>
          </select>
          <label className="date-filter">
            From
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>
          <label className="date-filter">
            To
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
        </div>
        <table className="sessions-table">
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Role</th>
              <th>Status</th>
              <th>Overall</th>
              <th>Integrity</th>
              <th>Started</th>
              <th>Ended</th>
            </tr>
          </thead>
          <tbody>
            {filteredSessions.map((s) => {
              const isSelected = selectedId === s._id;
              let integrityClass = '';
              let integrityDisplay = '—';
              if (selectedDetail && selectedDetail.session._id === s._id) {
                const { score, label } = computeIntegrity(
                  selectedDetail.monitoringEvents,
                  selectedDetail.session
                );
                integrityDisplay = `${score}`;
                if (label === 'Low') integrityClass = 'integrity-low';
                else if (label === 'Medium') integrityClass = 'integrity-medium';
                else integrityClass = 'integrity-high';
              }

              return (
                <tr
                  key={s._id}
                  className={`session-row ${isSelected ? 'selected' : ''} ${integrityClass}`}
                  onClick={() => setSelectedId(s._id)}
                >
                  <td>{s.candidateName}</td>
                  <td>{s.jobRole}</td>
                  <td>{s.status}</td>
                  <td>{s.evaluationScores?.overallScore ?? '—'}</td>
                  <td>{integrityDisplay}</td>
                  <td>{formatDate(s.startTime)}</td>
                  <td>{formatDate(s.endTime)}</td>
                </tr>
              );
            })}
            {filteredSessions.length === 0 && !loadingList && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center' }}>
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
              <div>
                {renderScores(selectedDetail.session.evaluationScores)}
                <div className="integrity-summary">
                  {(() => {
                    const integrity = computeIntegrity(
                      selectedDetail.monitoringEvents,
                      selectedDetail.session
                    );
                    return (
                      <>
                        <div>
                          <strong>Integrity</strong>: {integrity.score} ({integrity.label})
                        </div>
                        <div className="integrity-metrics">
                          <span>Tab switches: {integrity.tabSwitches}</span>
                          <span>Suspicious actions: {integrity.suspicious}</span>
                          <span>Face lost: {integrity.faceLost}</span>
                          <span>Multiple faces: {integrity.multipleFaces}</span>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
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

