// Video Player (Student view) — Adaptive Hybrid Player (ADR-001)
//
// Two-tier streaming architecture:
//   WebRTC tier (priority) — LiveKit SFU, sub-second latency
//   HLS tier    (bulk)     — HLS.js via MinIO/CDN, ~2-3s latency
//
// Tier assignment is returned by POST /api/stream/join/:lectureId
// based on current room participant count and WEBRTC_PRIORITY_LIMIT.
//
// If WebRTC disconnects unexpectedly, the player polls /hls-status
// and falls back to HLS automatically.

import React, { useState, useEffect, useRef } from 'react';
import {
  LiveKitRoom,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useTracks,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import '@livekit/components-styles';
import Hls from 'hls.js';
import api from '../../services/api';

// ── HLS Player ──────────────────────────────────────────────────────────────
// Renders an HLS stream using HLS.js (with native fallback for Safari).
function HLSPlayer({ hlsUrl }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hlsUrl) return;

    let hls;
    if (Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: true,   // Enables LL-HLS when the server supports it
        backBufferLength: 30,
      });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {}); // autoplay may be blocked — fine
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari / iOS)
      video.src = hlsUrl;
      video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
    }

    return () => {
      if (hls) hls.destroy();
    };
  }, [hlsUrl]);

  return (
    <video
      ref={videoRef}
      controls
      style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
    />
  );
}

// ── LiveKit inner component ─────────────────────────────────────────────────
function LectureScreenView() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false }
  );
  const remoteTracks = tracks.filter((t) => !t.participant?.isLocal);
  const displayTracks = remoteTracks.length > 0 ? remoteTracks : tracks;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <GridLayout tracks={displayTracks} style={{ flex: 1 }}>
        <ParticipantTile />
      </GridLayout>
      <RoomAudioRenderer />
    </div>
  );
}

// ── Main VideoPlayer ─────────────────────────────────────────────────────────
export default function VideoPlayer({ lectureId, token: _authToken }) {
  const [session, setSession]       = useState(null);
  const [status, setStatus]         = useState('waiting'); // waiting | live | ended | fallback
  const [lectureInfo, setLectureInfo] = useState(null);
  const [fallbackHlsUrl, setFallbackHlsUrl] = useState(null);
  const pollRef    = useRef(null);
  const isMounted  = useRef(true);
  const holdsSlot  = useRef(false); // true while this viewer owns a WebRTC slot

  // Give the WebRTC slot back so the next viewer can have it.
  // keepalive lets the request finish even while the tab is closing.
  function releaseSlot() {
    if (!holdsSlot.current) return;
    holdsSlot.current = false;
    const token = localStorage.getItem('token');
    fetch(`/api/stream/leave/${lectureId}`, {
      method: 'POST',
      keepalive: true,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch(() => {});
  }

  useEffect(() => {
    isMounted.current = true;

    async function tryJoin() {
      try {
        const { data } = await api.post(`/stream/join/${lectureId}`);
        if (!isMounted.current) return;
        holdsSlot.current = data.viewerTier === 'webrtc';
        setSession(data);
        setLectureInfo({ title: data.lectureName, instructor: data.instructorName });
        setStatus('live');
      } catch (err) {
        if (!isMounted.current) return;
        if (err.response?.data?.code === 'NOT_LIVE') {
          setStatus('waiting');
          pollRef.current = setTimeout(tryJoin, 4000);
        } else {
          setStatus('ended');
        }
      }
    }

    tryJoin();
    window.addEventListener('beforeunload', releaseSlot);
    return () => {
      isMounted.current = false;
      clearTimeout(pollRef.current);
      window.removeEventListener('beforeunload', releaseSlot);
      releaseSlot();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lectureId]);

  // WebRTC disconnect handler — attempt HLS fallback
  async function handleWebRTCDisconnect() {
    if (!isMounted.current) return;
    releaseSlot(); // moving to HLS, so free the WebRTC slot
    try {
      const { data } = await api.get(`/stream/hls-status/${lectureId}`);
      if (data.hlsUrl) {
        setFallbackHlsUrl(data.hlsUrl);
        setStatus('fallback');
        return;
      }
    } catch { /* ignore */ }
    setStatus('ended');
  }

  // ── Waiting ────────────────────────────────────────────────────────────────
  if (status === 'waiting') {
    return (
      <div style={styles.container}>
        <div style={styles.statusBar}>
          <span style={{ ...styles.dot, animation: 'pulse 1.5s infinite' }} />
          <span style={{ color: '#f4a261', fontSize: 13 }}>Waiting for instructor to go live...</span>
        </div>
        <div style={styles.videoBox}>
          <div style={styles.overlay}>
            <div style={styles.spinner} />
            <p style={{ fontSize: 15, opacity: 0.8, marginTop: 16 }}>Checking every 4 seconds...</p>
          </div>
        </div>
        <style>{CSS}</style>
      </div>
    );
  }

  // ── Ended ──────────────────────────────────────────────────────────────────
  if (status === 'ended') {
    return (
      <div style={styles.container}>
        <div style={styles.videoBox}>
          <div style={styles.overlay}>
            <div style={{ fontSize: 48 }}>📺</div>
            <p style={{ fontSize: 15, opacity: 0.8, marginTop: 12 }}>
              The lecture stream has ended.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── HLS fallback (WebRTC disconnected mid-session) ─────────────────────────
  if (status === 'fallback') {
    return (
      <div style={styles.container}>
        {renderStatusBar(lectureInfo, 'hls', 'Switched to HLS (WebRTC dropped)')}
        <div style={{ height: 380, borderRadius: 8, overflow: 'hidden' }}>
          <HLSPlayer hlsUrl={fallbackHlsUrl} />
        </div>
        <style>{CSS}</style>
      </div>
    );
  }

  // ── Live — WebRTC priority tier ────────────────────────────────────────────
  if (status === 'live' && session?.viewerTier === 'webrtc') {
    return (
      <div style={styles.container}>
        {renderStatusBar(lectureInfo, 'webrtc')}
        <div style={{ height: 380, borderRadius: 8, overflow: 'hidden' }}>
          <LiveKitRoom
            token={session.livekitToken}
            serverUrl={session.livekitUrl}
            video={false}
            audio={false}
            onDisconnected={handleWebRTCDisconnect}
            style={{ height: '100%' }}
          >
            <LectureScreenView />
          </LiveKitRoom>
        </div>
        <style>{CSS}</style>
      </div>
    );
  }

  // ── Live — HLS bulk tier ───────────────────────────────────────────────────
  if (status === 'live' && session?.viewerTier === 'hls') {
    return (
      <div style={styles.container}>
        {renderStatusBar(lectureInfo, 'hls')}
        <div style={{ height: 380, borderRadius: 8, overflow: 'hidden' }}>
          <HLSPlayer hlsUrl={session.hlsUrl} />
        </div>
        <style>{CSS}</style>
      </div>
    );
  }

  return null;
}

// ── Tier status bar ──────────────────────────────────────────────────────────
function renderStatusBar(lectureInfo, tier, note) {
  const isWebRTC = tier === 'webrtc';
  return (
    <div style={styles.statusBar}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{lectureInfo?.title || 'Live Lecture'}</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* Live badge */}
        <span style={{ ...styles.dot, background: '#e63946' }} />
        <span style={{ color: '#e63946', fontSize: 13, fontWeight: 700 }}>LIVE</span>
        {lectureInfo?.instructor && (
          <span style={{ color: '#888', fontSize: 12 }}>· {lectureInfo.instructor}</span>
        )}
        {/* Tier badge (ADR-001 visual proof) */}
        <span style={{
          ...styles.tierBadge,
          background: isWebRTC ? 'rgba(56,200,120,0.15)' : 'rgba(80,140,240,0.15)',
          color:      isWebRTC ? '#38c878' : '#508cf0',
          border:     `1px solid ${isWebRTC ? '#38c878' : '#508cf0'}`,
        }}>
          {isWebRTC ? '⚡ Priority — WebRTC' : '📺 Standard — HLS'}
        </span>
        {note && <span style={{ color: '#f4a261', fontSize: 11 }}>{note}</span>}
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const CSS = `
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  @keyframes spin  { to{transform:rotate(360deg)} }
`;

const styles = {
  container: { display: 'flex', flexDirection: 'column' },
  statusBar: {
    display: 'flex', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6,
  },
  dot: {
    width: 10, height: 10, borderRadius: '50%',
    background: '#f4a261', display: 'inline-block',
  },
  tierBadge: {
    fontSize: 11, fontWeight: 600, padding: '2px 8px',
    borderRadius: 12, letterSpacing: 0.3,
  },
  videoBox: {
    width: '100%', aspectRatio: '16/9', background: '#000',
    borderRadius: 8, position: 'relative', overflow: 'hidden',
  },
  overlay: {
    position: 'absolute', inset: 0, display: 'flex',
    flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', color: '#fff',
  },
  spinner: {
    width: 40, height: 40, border: '3px solid rgba(255,255,255,0.3)',
    borderTopColor: '#fff', borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
};
