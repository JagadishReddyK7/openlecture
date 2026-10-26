// Q&A — Instructor View
import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { useQAWebSocket } from '../../hooks/useWebSocket';
import './qa.css';

const STRATEGY_LABELS = {
  default: 'Votes + Recency',
  votes: 'Most Voted',
  recency: 'Newest First',
};

const TABS = ['all', 'unanswered', 'answered'];

export default function InstructorQAView({ lectureId, token }) {
  // Updates are bounded: top-ranked unanswered, latest answered, and counts
  const [questions, setQuestions] = useState([]);
  const [answered, setAnswered] = useState([]);
  const [counts, setCounts] = useState(null);
  const [strategy, setStrategy] = useState('default');
  const [tab, setTab] = useState('unanswered');

  const { send, denied } = useQAWebSocket(lectureId, token, (msg) => {
    if (msg.type === 'QUESTIONS_UPDATE') {
      setQuestions(msg.questions);
      setAnswered(msg.answered || []);
      setCounts(msg.counts || null);
      if (msg.strategy) setStrategy(msg.strategy);
    }
  });

  if (denied) {
    return (
      <div className="qa-panel">
        <div className="qa-empty">Only this lecture's instructor can moderate its Q&amp;A.</div>
      </div>
    );
  }

  function markAnswered(questionId) {
    send({ type: 'MARK_ANSWERED', questionId });
  }

  function changeStrategy(e) {
    const selected = e.target.value;
    setStrategy(selected);
    send({ type: 'SET_STRATEGY', strategy: selected });
  }

  const filtered =
    tab === 'unanswered' ? questions :
    tab === 'answered'   ? answered :
    [...questions, ...answered];

  const unansweredCount = counts ? counts.unanswered : questions.length;

  return (
    <div className="qa-panel">
      <div className="qa-panel-header">
        <h3 className="qa-panel-title">Q&amp;A</h3>
        <span className="qa-live-badge">
          <span className="qa-live-dot" />{'Live'}
        </span>
      </div>

      <div className="qa-instructor-toolbar">
        <div className="qa-strategy-group">
          <label htmlFor="strategy-select" className="qa-strategy-label">Rank:</label>
          <select
            id="strategy-select"
            value={strategy}
            onChange={changeStrategy}
            className="qa-strategy-select"
          >
            {Object.entries(STRATEGY_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>
        <span className="qa-stats-badge">
          {unansweredCount} unanswered
        </span>
      </div>

      <div className="qa-tabs">
        {TABS.map(t => (
          <button
            key={t}
            className={`qa-tab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="qa-list">
        {filtered.length === 0 ? (
          <div className="qa-empty">
            <div className="qa-empty-icon">{tab === 'answered' ? '✅' : '💬'}</div>
            {tab === 'answered' ? 'No answered questions yet.' : 'No questions yet.'}
          </div>
        ) : (
          filtered.map(q => (
            <div key={q.id} className={`qa-card${q.is_answered ? ' is-answered' : ''}`}>
              <button
                className="qa-vote-btn"
                style={{ cursor: 'default' }}
                title={`${q.vote_count} vote${q.vote_count === 1 ? '' : 's'}`}
              >
                <span className="qa-vote-arrow">▲</span>
                <span className="qa-vote-count">{q.vote_count}</span>
              </button>
              <div className="qa-card-body">
                <p className="qa-card-content">{q.content}</p>
                <div className="qa-card-meta">
                  {q.is_answered ? (
                    <span className="qa-answered-badge">✓ Answered</span>
                  ) : (
                    <button
                      className="qa-mark-btn"
                      onClick={() => markAnswered(q.id)}
                    >
                      ✓ Mark answered
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

InstructorQAView.propTypes = {
  lectureId: PropTypes.string.isRequired,
  token: PropTypes.string.isRequired,
};
