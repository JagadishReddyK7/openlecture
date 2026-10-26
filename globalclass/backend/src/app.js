// Core API — Service 1 of 2
// Owns: User Auth, Course Catalog, Lecture Scheduling, Q&A
// Streaming (Service 2) lives at streaming-engine on port 4001.

import express from 'express';
import cors from 'cors';

import authRoutes from './routes/auth.js';
import lectureRoutes from './routes/lectures.js';
import questionRoutes from './routes/questions.js';
import qaRoutes from './routes/qa.js';
import { metricsHandler } from './metrics.js';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/lectures', lectureRoutes);
app.use('/api/lectures', questionRoutes);  // /api/lectures/:id/questions
app.use('/api/qa', qaRoutes);              // /api/qa/ticket

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'core-api' }));
// Prometheus scrape target, per instance; nginx does not route /metrics
app.get('/metrics', metricsHandler);

export default app;
