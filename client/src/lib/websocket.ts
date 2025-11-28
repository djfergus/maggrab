import { useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

type WebSocketMessage = {
  type: string;
  data?: any;
  feedId?: string;
  status?: string;
  timestamp?: number;
  feedCount?: number;
  jobCount?: number;
};

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const queryClient = useQueryClient();
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WebSocket] Connected');
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          
          switch (message.type) {
            case 'heartbeat':
              break;
              
            case 'feedStatus':
              queryClient.invalidateQueries({ queryKey: ['feeds'] });
              break;
              
            case 'stats':
              queryClient.setQueryData(['stats'], message.data);
              break;
              
            case 'grabbed':
              queryClient.invalidateQueries({ queryKey: ['grabbed'] });
              break;
              
            case 'extracted':
              queryClient.invalidateQueries({ queryKey: ['extracted'] });
              break;
              
            case 'log':
              queryClient.invalidateQueries({ queryKey: ['logs'] });
              break;
              
            default:
              queryClient.invalidateQueries();
          }
        } catch (err) {
          console.error('[WebSocket] Failed to parse message:', err);
        }
      };

      ws.onclose = () => {
        console.log('[WebSocket] Disconnected, reconnecting in 3s...');
        wsRef.current = null;
        
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
        reconnectTimeoutRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = (err) => {
        console.error('[WebSocket] Error:', err);
      };
    } catch (err) {
      console.error('[WebSocket] Failed to connect:', err);
      reconnectTimeoutRef.current = setTimeout(connect, 3000);
    }
  }, [queryClient]);

  useEffect(() => {
    connect();
    
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return wsRef;
}
