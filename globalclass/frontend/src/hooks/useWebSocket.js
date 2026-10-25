// Q&A WebSocket hook
import { useEffect, useRef, useCallback } from 'react';

const RECONNECT_DELAY_MS = 2000;  // initial backoff
const MAX_RECONNECT_DELAY_MS = 16000;  // cap at 16s
const MAX_RECONNECT_ATTEMPTS = 8;

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
  // Keep a ref to the latest onMessage so connect() never needs it as a dependency.
  // Without this, an inline arrow onMessage would give a new reference every render,
  // causing connect to be recreated, the effect to re-run, and the socket to reconnect
  // in a tight loop — so submitted questions would never appear.
  const onMessageRef = useRef(onMessage);
  useEffect(() => { onMessageRef.current = onMessage; });

  const connect = useCallback(() => {
    if (!lectureId || !token || !isMounted.current) return;

    // In development mode, the CRA proxy (setupProxy.js) often fails to proxy
    // WebSocket upgrade events properly. Since we have our Nginx API Gateway 
    // running locally on port 80, we can bypass the dev server and connect 
    // to Nginx directly. In production, we use the current host.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const targetHost = process.env.NODE_ENV === 'development' ? 'localhost:80' : window.location.host;
    const url = `${protocol}//${targetHost}/qaws?lectureId=${lectureId}&token=${token}`;
    
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

    socket.onclose = (e) => {
      // 4001 = unauthorized — do not reconnect
      if (e.code === 4001 || !isMounted.current) return;
      if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) {
        console.warn('Q&A WS: max reconnect attempts reached');
        return;
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 16s, ...
      const delay = Math.min(
        RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts.current),
        MAX_RECONNECT_DELAY_MS
      );
      reconnectAttempts.current += 1;
      console.log(`Q&A WS: reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);
      reconnectTimer.current = setTimeout(connect, delay);
    };
  }, [lectureId, token]); // onMessage intentionally excluded — accessed via ref

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

  return { send };
}
