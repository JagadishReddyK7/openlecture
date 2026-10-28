// Q&A — Question Input (Student)
import React, { useState } from 'react';
import './qa.css';

const MAX_CHARS = 280;

export default function QuestionInput({ send }) {
  const [content, setContent] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    if (!content.trim()) return;
    send({ type: 'SUBMIT_QUESTION', content: content.trim() });
    setContent('');
  }

  const remaining = MAX_CHARS - content.length;
  const nearLimit = remaining <= 40;

  return (
    <form onSubmit={handleSubmit} className="qa-input-form">
      <textarea
        maxLength={1000}
        className="qa-textarea"
        value={content}
        onChange={e => setContent(e.target.value.slice(0, MAX_CHARS))}
        placeholder="Ask a question..."
        rows={3}
      />
      <div className="qa-input-footer">
        <span className={`qa-char-count${nearLimit ? ' qa-char-warn' : ''}`}>
          {remaining} chars left
        </span>
        <button
          type="submit"
          className="qa-submit-btn"
          disabled={!content.trim()}
        >
          &#8593; Ask
        </button>
      </div>
    </form>
  );
}
