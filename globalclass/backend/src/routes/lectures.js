import express from 'express';
import pool from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import accessService from '../services/accessService.js';

const router = express.Router();

// GET /api/lectures — browse all lectures (course catalog)
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, u.name AS instructor_name, u.institution,
       EXISTS(SELECT 1 FROM enrollments e WHERE e.lecture_id = l.id AND e.student_id = $1) AS is_enrolled
       FROM lectures l JOIN users u ON l.instructor_id = u.id
       ORDER BY l.scheduled_at DESC`,
       [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/lectures/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, u.name AS instructor_name FROM lectures l
       JOIN users u ON l.instructor_id = u.id WHERE l.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/lectures — create lecture (instructor only)
router.post('/', authenticate, requireRole('instructor'), async (req, res) => {
  const { title, description, scheduled_at } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO lectures (title, description, instructor_id, scheduled_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, description, req.user.id, scheduled_at]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/lectures/:id/status — go live / end lecture (instructor only)
router.patch('/:id/status', authenticate, requireRole('instructor'), async (req, res) => {
  const { status } = req.body;
  try {
    const result = await pool.query(
      `UPDATE lectures SET status = $1 WHERE id = $2 AND instructor_id = $3 RETURNING *`,
      [status, req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/lectures/:id/enroll
router.post('/:id/enroll', authenticate, requireRole('student'), async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO enrollments (student_id, lecture_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.id, req.params.id]
    );
    // Warm the access cache so the student's first Q&A ticket needs no DB query
    await accessService.rememberEnrollment(req.params.id, req.user.id);
    res.json({ message: 'Enrolled successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
