import express from 'express';
import cors from 'cors';
import streamRoutes from './routes/stream.js';
import { metricsHandler } from './metrics.js';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/stream', streamRoutes);

// Health check — useful for Docker and nginx upstream health checks
app.get('/health', (req, res) =>
  res.json({ status: 'ok', service: 'streaming-engine' })
);

// Prometheus scrape target, per instance; nginx does not route /metrics
app.get('/metrics', metricsHandler);

export default app;
