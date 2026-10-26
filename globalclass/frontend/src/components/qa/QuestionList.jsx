// Q&A — Question List (Student view)
import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { useQAWebSocket } from '../../hooks/useWebSocket';
import QuestionInput from './QuestionInput';
import './qa.css';

export default function QuestionList({ lectureId, token, user }) {
  // Updates are bounded: top-ranked unanswered questions, the most recently
  // answered ones, and counts for the whole lecture.
  const [questions, setQuestions] = useState([]);
  const [answered, setAnswered] = useState([]);
  const [counts, setCounts] = useState(null);
  const [voted, setVoted] = useState(new Set());

  const { send, denied } = useQAWebSocket(lectureId, token, (msg) => {
    if (msg.type === 'QUESTIONS_UPDATE') {
      setQuestions(msg.questions);
      setAnswered(msg.answered || []);
      setCounts(msg.counts || null);
    }
  });
  const hidden = counts ? counts.unanswered - questions.length : 0;

  if (denied) {
    return (
      <div className="qa-panel">
        <div className="qa-empty">Enroll in this lecture to join its Q&amp;A.</div>
      </div>
    );
  }

  function vote(questionId) {
    if (voted.has(questionId)) return;
    send({ type: 'VOTE', questionId });
    setVoted(prev => new Set(prev).add(questionId));
  }

  return (
    <div className="qa-panel">
      <div className="qa-panel-header">
        <h3 className="qa-panel-title">Questions</h3>
        <span className="qa-live-badge">
          <span className="qa-live-dot" />{'Live'}
        </span>
      </div>

      <QuestionInput send={send} />

      <div className="qa-list">
        {questions.length === 0 && answered.length === 0 ? (
          <div className="qa-empty">
            <div className="qa-empty-icon">💬</div>
            No questions yet. Be the first to ask!
          </div>
        ) : (
          [...questions, ...answered].map(q => (
            <div key={q.id} className={`qa-card${q.is_answered ? ' is-answered' : ''}`}>
              <button
                className={`qa-vote-btn${voted.has(q.id) ? ' voted' : ''}`}
                onClick={() => vote(q.id)}
                title={voted.has(q.id) ? 'Already voted' : 'Upvote'}
                disabled={voted.has(q.id)}
              >
                <span className="qa-vote-arrow">▲</span>
                <span className="qa-vote-count">{q.vote_count}</span>
              </button>
              <div className="qa-card-body">
                <p className="qa-card-content">{q.content}</p>
                <div className="qa-card-meta">
                  {q.is_answered && (
                    <span className="qa-answered-badge">✓ Answered</span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
        {hidden > 0 && (
          <div className="qa-empty">Showing the top {questions.length} of {counts.unanswered} open questions</div>
        )}
      </div>
    </div>
  );
}

QuestionList.propTypes = {
  lectureId: PropTypes.string.isRequired,
  token: PropTypes.string.isRequired,
  user: PropTypes.object,
};
