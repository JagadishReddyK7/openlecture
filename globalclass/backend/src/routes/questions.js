// Q&A Routes
// Same access rules as the WebSocket: the lecture's instructor or an enrolled
// student. Mutations go through the same broadcaster as WebSocket ones, so
// connected clients see them (they used to be written silently).
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import qaService from '../services/qaService.js';
import accessService from '../services/accessService.js';
import { notifyMutation } from '../websocket/qaHandler.js';

const router = express.Router({ mergeParams: true });

// Loads req.access for /:id/...; ownerOnly limits the route to the lecture's instructor
function lectureAccess({ ownerOnly = false } = {}) {
  return async (req, res, next) => {
    try {
      const access = await accessService.checkAccess(req.params.id, req.user);
      if (!access.exists) return res.status(404).json({ error: 'Lecture not found' });
      if (!access.allowed || (ownerOnly && !access.isOwner)) {
        return res.status(403).json({
          error: ownerOnly ? "Only this lecture's instructor can do that" : 'Enroll in this lecture first',
        });
      }
      req.access = access;
      next();
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  };
}

// GET /api/lectures/:id/questions — full ranked list (live clients get a bounded view)
router.get('/:id/questions', authenticate, lectureAccess(), async (req, res) => {
  try {
    const strategy = await qaService.getStrategy(req.params.id);
    res.json(await qaService.getRankedQuestions(req.params.id, strategy));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/lectures/:id/questions — submit a question
router.post('/:id/questions', authenticate, lectureAccess(), async (req, res) => {
  try {
    const question = await qaService.submitQuestion(req.params.id, req.user.id, req.body.content);
    await notifyMutation(req.params.id);
    res.status(201).json(question);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/lectures/:id/questions/:qid/vote — upvote a question
router.post('/:id/questions/:qid/vote', authenticate, lectureAccess(), async (req, res) => {
  try {
    const result = await qaService.voteQuestion(req.params.qid, req.user.id, req.params.id);
    await notifyMutation(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// PATCH /api/lectures/:id/questions/:qid/answer — mark as answered (this lecture's instructor)
router.patch('/:id/questions/:qid/answer', authenticate, lectureAccess({ ownerOnly: true }), async (req, res) => {
  try {
    const result = await qaService.markAnswered(req.params.qid, req.params.id);
    await notifyMutation(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
