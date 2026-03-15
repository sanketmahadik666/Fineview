/**
 * BehaviourScorer — Phase 4
 *
 * Computes a candidate integrity / behaviour score from the raw
 * MonitoringEvent stream recorded during an interview session.
 *
 * Scoring model (0 – 100, higher = better integrity):
 *   Base score: 100
 *   Deductions:
 *     - Tab switch (away):    -5 per occurrence (first is free)
 *     - Face lost:            -3 per occurrence
 *     - Multiple faces:       -8 per occurrence
 *     - Looking away:         -2 per occurrence
 *     - Suspicious action:    -10 per occurrence
 *     - Long tab absence:     -1 per second over 10s
 *
 *   Minimum score: 0
 *   Labels: High (≥70), Medium (40–69), Low (<40)
 *
 * Design note (LLD §trade-offs):
 *   This is a deterministic, testable pure function — no DB calls,
 *   no async. The recruiter dashboard calls it at query time rather
 *   than storing the score so it can be re-weighted without a
 *   migration. Store the raw events; derive the score.
 */

const WEIGHTS = {
  tab_switch_away:    -5,
  face_lost:          -3,
  multiple_faces:     -8,
  looking_away:       -2,
  suspicious_action:  -10,
};

const TAB_ABSENCE_FREE_SECONDS = 10;
const TAB_ABSENCE_PENALTY_PER_SECOND = 1;

/**
 * Score a candidate from their monitoring event log.
 *
 * @param {Array<object>} events   MonitoringEvent documents from MongoDB
 * @param {object}        session  InterviewSession document (for duration)
 * @returns {object}               Detailed behaviour report
 */
export function scoreBehaviour(events = [], session = {}) {
  let score = 100;
  const breakdown = {
    tabSwitchCount: 0,
    faceLostCount: 0,
    multipleFacesCount: 0,
    lookingAwayCount: 0,
    suspiciousActionCount: 0,
    totalTabAbsenceSeconds: 0,
    flags: [],
  };

  let tabLeftAt = null;

  for (const evt of events) {
    const type = evt.type || '';
    const payload = evt.payload || {};
    const ts = evt.clientTimestamp || evt.createdAt || Date.now();

    switch (type) {
      case 'tab_switch': {
        const dir = payload.direction || '';
        if (dir === 'away') {
          breakdown.tabSwitchCount++;
          if (breakdown.tabSwitchCount > 1) {
            score += WEIGHTS.tab_switch_away;
            breakdown.flags.push(`Tab switched away (occurrence ${breakdown.tabSwitchCount})`);
          }
          tabLeftAt = ts;
        } else if (dir === 'returned' && tabLeftAt !== null) {
          const absenceMs = ts - tabLeftAt;
          const absenceSec = absenceMs / 1000;
          breakdown.totalTabAbsenceSeconds += absenceSec;
          if (absenceSec > TAB_ABSENCE_FREE_SECONDS) {
            const penalty = Math.floor(absenceSec - TAB_ABSENCE_FREE_SECONDS) * TAB_ABSENCE_PENALTY_PER_SECOND;
            score -= penalty;
            breakdown.flags.push(`Long tab absence: ${absenceSec.toFixed(0)}s`);
          }
          tabLeftAt = null;
        }
        break;
      }

      case 'face_lost':
        breakdown.faceLostCount++;
        score += WEIGHTS.face_lost;
        break;

      case 'multiple_faces':
        breakdown.multipleFacesCount++;
        score += WEIGHTS.multiple_faces;
        breakdown.flags.push(`Multiple faces detected (${payload.count ?? '?'})`);
        break;

      case 'looking_away':
        breakdown.lookingAwayCount++;
        score += WEIGHTS.looking_away;
        break;

      case 'suspicious_action':
        breakdown.suspiciousActionCount++;
        score += WEIGHTS.suspicious_action;
        breakdown.flags.push(`Suspicious action: ${payload.action || 'unknown'}`);
        break;

      default:
        break;
    }
  }

  score = Math.max(0, Math.min(100, score));

  let label = 'High';
  if (score < 40) label = 'Low';
  else if (score < 70) label = 'Medium';

  return {
    score: Math.round(score),
    label,
    breakdown,
    eventCount: events.length,
  };
}

/**
 * Derive session-level behaviour flags for quick display in dashboard.
 * Returns an array of human-readable strings.
 *
 * @param {object} behaviourReport   Output of scoreBehaviour()
 * @returns {string[]}
 */
export function getBehaviourFlags(behaviourReport) {
  const { breakdown, label } = behaviourReport;
  const flags = [...breakdown.flags];

  if (breakdown.multipleFacesCount > 0) {
    flags.unshift(`⚠ Multiple faces detected ${breakdown.multipleFacesCount} time(s)`);
  }
  if (label === 'Low') {
    flags.unshift('🚨 Low integrity score — manual review recommended');
  }

  return flags;
}
