import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  source: 'scraper' | 'daemon' | 'jdownloader';
}

export interface Feed {
  id: string;
  name: string;
  url: string;
  interval: number; // minutes
  lastChecked: number | null;
  status: 'idle' | 'scraping' | 'error';
  totalFound: number;
}

export interface AppState {
  feeds: Feed[];
  logs: LogEntry[];
  stats: {
    totalScraped: number;
    linksFound: number;
    submitted: number;
  };
  settings: {
    jdUrl: string;
    jdUser: string;
    jdDevice: string;
    checkInterval: number;
  };
  
  addFeed: (url: string, name: string) => void;
  removeFeed: (id: string) => void;
  addLog: (message: string, level: LogLevel, source: LogEntry['source']) => void;
  updateSettings: (settings: Partial<AppState['settings']>) => void;
  setFeedStatus: (id: string, status: Feed['status']) => void;
  incrementStats: (key: keyof AppState['stats']) => void;
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      feeds: [
        {
          id: '1',
          name: 'Tech News Daily',
          url: 'https://example.com/rss',
          interval: 15,
          lastChecked: Date.now() - 1000 * 60 * 5,
          status: 'idle',
          totalFound: 124
        },
        {
          id: '2',
          name: 'Linux ISOs',
          url: 'https://linux-distros.org/feed',
          interval: 60,
          lastChecked: Date.now() - 1000 * 60 * 45,
          status: 'idle',
          totalFound: 45
        }
      ],
      logs: [
        { id: '1', timestamp: Date.now() - 10000, level: 'info', message: 'Daemon started v0.1.0', source: 'daemon' },
        { id: '2', timestamp: Date.now() - 5000, level: 'info', message: 'Connected to JDownloader2 API', source: 'jdownloader' }
      ],
      stats: {
        totalScraped: 1245,
        linksFound: 169,
        submitted: 169
      },
      settings: {
        jdUrl: 'http://localhost:3128',
        jdUser: 'admin@email.com',
        jdDevice: 'MyServer01',
        checkInterval: 15
      },

      addFeed: (url, name) => set((state) => ({
        feeds: [...state.feeds, {
          id: Math.random().toString(36).substr(2, 9),
          name,
          url,
          interval: 15,
          lastChecked: null,
          status: 'idle',
          totalFound: 0
        }]
      })),

      removeFeed: (id) => set((state) => ({
        feeds: state.feeds.filter(f => f.id !== id)
      })),

      addLog: (message, level, source) => set((state) => ({
        logs: [{
          id: Math.random().toString(36).substr(2, 9),
          timestamp: Date.now(),
          level,
          message,
          source
        }, ...state.logs].slice(0, 100)
      })),

      updateSettings: (newSettings) => set((state) => ({
        settings: { ...state.settings, ...newSettings }
      })),

      setFeedStatus: (id, status) => set((state) => ({
        feeds: state.feeds.map(f => f.id === id ? { ...f, status } : f)
      })),

      incrementStats: (key) => set((state) => ({
        stats: { ...state.stats, [key]: state.stats[key] + 1 }
      }))
    }),
    {
      name: 'magscrape-storage',
    }
  )
);
