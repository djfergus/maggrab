import { useEffect, useRef } from "react";
import { Terminal, Download, Globe, AlertTriangle, Info } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export default function Logs() {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);

  const { data: logs = [] } = useQuery({
    queryKey: ["logs"],
    queryFn: () => api.getLogs(100),
    refetchInterval: 2000,
  });

  // Only scroll to bottom on initial load, no animation
  useEffect(() => {
    if (containerRef.current && logs.length > 0 && !initialScrollDone.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      initialScrollDone.current = true;
    }
  }, [logs]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-6 border-b border-border bg-card/30 backdrop-blur-sm flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 bg-black border border-border flex items-center justify-center">
            <Terminal className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h2 className="text-2xl font-display font-bold text-white">System Logs</h2>
            <p className="text-sm text-muted-foreground font-mono">Tail -f output from daemon process</p>
          </div>
        </div>
      </div>

      <div className="flex-1 p-6 overflow-hidden">
        <div 
          ref={containerRef}
          className="h-full bg-black border border-border font-mono text-xs overflow-auto p-4 shadow-inner"
        >
          {logs.length === 0 && (
            <div className="text-muted-foreground italic opacity-50 text-center mt-20">
              Waiting for daemon output...
            </div>
          )}
          
          {logs.map((log) => (
            <div key={log.id} className="flex gap-1.5 mb-0.5 hover:bg-white/5 py-0.5 px-1 rounded-sm transition-colors leading-tight" data-testid={`log-${log.id}`}>
              <span className="text-muted-foreground min-w-[140px]">
                {new Date(log.timestamp).toISOString().replace('T', ' ').substr(0, 19)}
              </span>
              
              <span className={`uppercase font-bold min-w-[50px] ${getLevelColor(log.level)}`}>
                [{formatLevel(log.level)}]
              </span>

              <span className="text-muted-foreground min-w-[55px] flex items-center gap-1">
                {getSourceIcon(log.source)}
                {formatSource(log.source)}
              </span>

              <span className="text-foreground whitespace-pre-wrap">{log.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function getLevelColor(level: string) {
  switch (level) {
    case 'info': return 'text-blue-400';
    case 'success': return 'text-emerald-400';
    case 'warn': return 'text-yellow-400';
    case 'error': return 'text-red-500';
    default: return 'text-muted-foreground';
  }
}

function getSourceIcon(source: string) {
  switch (source) {
    case 'daemon': return <Terminal className="h-3 w-3" />;
    case 'grabber': return <Globe className="h-3 w-3" />;
    case 'jdownloader': return <Download className="h-3 w-3" />;
    default: return null;
  }
}

function formatLevel(level: string) {
  if (level === 'success') return 'ok';
  return level;
}

function formatSource(source: string) {
  switch (source) {
    case 'jdownloader': return 'myjd';
    case 'grabber': return 'grab';
    default: return source;
  }
}
