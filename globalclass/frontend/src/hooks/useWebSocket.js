// Q&A WebSocket hook
//
// Connecting is two steps: POST /api/qa/ticket (JWT in the Authorization
// header) returns a one-time ticket valid for 30 s, then the socket opens with
// ?ticket=. The JWT used to go in the WebSocket URL, where nginx logged it.
// Every (re)connect fetches a fresh ticket. A 403/404 from the ticket endpoint
// means this user may not join this lecture's Q&A: stop and report `denied`.
import { useEffect, useRef, useCallback, useState } from 'react';
import api from '../services/api';

// Reconnect with "full jitter": wait random(0, min(cap, base * 2^attempt)).
// When an instance dies, every client it held disconnects at the same moment;
// without jitter they'd all come back in lockstep and hit the survivors
// together. No attempt limit: a lecture is worth rejoining whenever the
// server is back, for as long as the page is open.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30000;

export function useQAWebSocket(lectureId, token, onMessage) {
  const ws = useRef(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef(null);
  const isMounted = useRef(true);
  // Highest QUESTIONS_UPDATE seq seen on the current socket. The snapshot sent
  // on connect can race a broadcast already in flight, so an older update may
  // arrive after a newer one; it is dropped. Reset per socket because seq
  // restarts when a lecture's live buffer is cleared.
  const lastSeq = useRef(-1);
  const [denied, setDenied] = useState(false);
  // Keep a ref to the latest onMessage so connect() never needs it as a dependency.
  // Without this, an inline arrow onMessage would give a new reference every render,
  // causing connect to be recreated, the effect to re-run, and the socket to reconnect
  // in a tight loop — so submitted questions would never appear.
  const onMessageRef = useRef(onMessage);
  useEffect(() => { onMessageRef.current = onMessage; });

  const scheduleReconnect = useCallback((reconnect) => {
    if (!isMounted.current) return;
    const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts.current);
    const delay = Math.round(Math.random() * ceiling);
    reconnectAttempts.current += 1;
    console.log(`Q&A WS: reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);
    reconnectTimer.current = setTimeout(reconnect, delay);
  }, []);

  const connect = useCallback(async () => {
    if (!lectureId || !token || !isMounted.current) return;

    let ticket;
    try {
      ({ data: { ticket } } = await api.post('/qa/ticket', { lectureId }));
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403 || status === 404) {
        if (isMounted.current) setDenied(true);
        return;
      }
      scheduleReconnect(connect);   // network/server error: try again later
      return;
    }
    if (!isMounted.current) return;

    // In development mode, the CRA proxy (setupProxy.js) often fails to proxy
    // WebSocket upgrade events properly. Since we have our Nginx API Gateway 
    // running locally on port 80, we can bypass the dev server and connect 
    // to Nginx directly. In production, we use the current host.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const targetHost = process.env.NODE_ENV === 'development' ? 'localhost:80' : window.location.host;
    const url = `${protocol}//${targetHost}/qaws?lectureId=${lectureId}&ticket=${encodeURIComponent(ticket)}`;
    
    const socket = new WebSocket(url);
    ws.current = socket;

    socket.onopen = () => {
      reconnectAttempts.current = 0;
      lastSeq.current = -1;
    };

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'QUESTIONS_UPDATE' && typeof msg.seq === 'number') {
          if (msg.seq < lastSeq.current) return;
          lastSeq.current = msg.seq;
        }
        onMessageRef.current(msg);
      } catch {
        console.error('Q&A WS: failed to parse message');
      }
    };

    socket.onerror = (e) => console.error('Q&A WS error', e);

    // 4001 = ticket refused (expired or already used). Reconnecting fetches a
    // new one; if the user really has no access, the ticket request says so.
    socket.onclose = () => scheduleReconnect(connect);
  }, [lectureId, token, scheduleReconnect]); // onMessage intentionally excluded — accessed via ref

  useEffect(() => {
    isMounted.current = true;
    connect();

    return () => {
      isMounted.current = false;
      clearTimeout(reconnectTimer.current);
      ws.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    }
  }, []);

  return { send, denied };
}
