// Q&A WebSocket tickets
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import accessService from '../services/accessService.js';

const router = express.Router();

// POST /api/qa/ticket { lectureId } -> { ticket, expiresIn }
// The JWT travels in the Authorization header here; the WebSocket then
// connects with ?ticket=..., so no long-lived credential ends up in a URL
// (and therefore not in nginx's access log).
router.post('/ticket', authenticate, async (req, res) => {
  const { lectureId } = req.body || {};
  try {
    const access = await accessService.checkAccess(lectureId, req.user);
    if (!access.exists) return res.status(404).json({ error: 'Lecture not found' });
    if (!access.allowed) {
      return res.status(403).json({ error: 'Enroll in this lecture to join its Q&A', code: 'NOT_ENROLLED' });
    }
    res.json(await accessService.issueTicket(lectureId, req.user, access.isOwner));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
