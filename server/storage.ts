import { type Feed, type InsertFeed, type ScrapeLog, type InsertLog, type Stats, type Settings, type ExtractedItem, type InsertExtractedItem, type GrabbedItem, type InsertGrabbedItem } from "@shared/schema";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { Mutex } from "async-mutex";

const DATA_DIR = process.env.DATA_DIR || "./data";
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const FEEDS_FILE = path.join(DATA_DIR, "feeds.json");
const LOGS_FILE = path.join(DATA_DIR, "logs.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const PROCESSED_FILE = path.join(DATA_DIR, "processed.json");
const EXTRACTED_FILE = path.join(DATA_DIR, "extracted.json");
const GRABBED_FILE = path.join(DATA_DIR, "grabbed.json");
const SCHEDULE_FILE = path.join(DATA_DIR, "schedule.json");

interface ProcessedUrl {
  url: string;
  timestamp: number;
}

interface CleanupResult {
  logs: number;
  extracted: number;
  grabbed: number;
  processed: number;
}

export interface ScheduleEntry {
  feedId: string;
  nextRun: number;
  intervalMinutes: number;
}

export interface IStorage {
  // Feeds
  getFeeds(): Promise<Feed[]>;
  getFeed(id: string): Promise<Feed | undefined>;
  createFeed(feed: InsertFeed): Promise<Feed>;
  updateFeed(id: string, updates: Partial<Feed>): Promise<Feed | undefined>;
  deleteFeed(id: string): Promise<boolean>;
  
  // Logs
  getLogs(limit?: number): Promise<ScrapeLog[]>;
  addLog(log: InsertLog): Promise<ScrapeLog>;
  
  // Stats
  getStats(): Promise<Stats>;
  incrementStat(key: keyof Stats, amount?: number): Promise<Stats>;
  
  // Settings
  getSettings(): Promise<Settings>;
  updateSettings(updates: Partial<Settings>): Promise<Settings>;
  
  // Processed URLs (deduplication)
  isProcessed(url: string): Promise<boolean>;
  markProcessed(url: string): Promise<void>;
  
  // Extracted items
  getExtractedItems(limit?: number): Promise<ExtractedItem[]>;
  addExtractedItem(item: InsertExtractedItem): Promise<ExtractedItem>;
  markExtractedItemSubmitted(id: string): Promise<boolean>;
  
  // Grabbed items (all RSS items processed)
  getGrabbedItems(limit?: number): Promise<GrabbedItem[]>;
  addGrabbedItem(item: InsertGrabbedItem): Promise<GrabbedItem>;
  
  // Schedule persistence
  getSchedule(): Promise<ScheduleEntry[]>;
  setScheduleEntry(entry: ScheduleEntry): Promise<void>;
  removeScheduleEntry(feedId: string): Promise<void>;
  
  // Data management
  clearEntries(): Promise<void>;
  resetAll(): Promise<void>;
  
  // Cleanup (log rotation)
  cleanupOldData(maxAgeMs?: number): Promise<CleanupResult>;
}

// Per-file mutexes to prevent concurrent writes
const fileMutexes: Map<string, Mutex> = new Map();

function getMutex(file: string): Mutex {
  if (!fileMutexes.has(file)) {
    fileMutexes.set(file, new Mutex());
  }
  return fileMutexes.get(file)!;
}

export class FileStorage implements IStorage {
  private initialized = false;

  private async ensureDataDir() {
    if (!this.initialized) {
      try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(BACKUP_DIR, { recursive: true });
        this.initialized = true;
      } catch (err) {
        console.error("Failed to create data directory:", err);
        throw err;
      }
    }
  }

  private async createBackup(file: string): Promise<void> {
    try {
      await fs.access(file);
      const filename = path.basename(file);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(BACKUP_DIR, `${filename}.${timestamp}.bak`);
      await fs.copyFile(file, backupFile);
      
      // Keep only last 5 backups per file
      const backups = await fs.readdir(BACKUP_DIR);
      const thisFileBackups = backups
        .filter(b => b.startsWith(filename + '.') && b.endsWith('.bak'))
        .sort()
        .reverse();
      
      for (const old of thisFileBackups.slice(5)) {
        await fs.unlink(path.join(BACKUP_DIR, old)).catch(() => {});
      }
    } catch {
      // File doesn't exist yet, no backup needed
    }
  }

  private async readJSON<T>(file: string, defaultValue: T, allowEmpty = false): Promise<T> {
    await this.ensureDataDir();
    const mutex = getMutex(file);
    
    return await mutex.runExclusive(async () => {
      try {
        const data = await fs.readFile(file, "utf-8");
        
        // Check for corrupted/empty file
        const trimmed = data.trim();
        if (!trimmed) {
          if (allowEmpty) return defaultValue;
          console.warn(`[Storage] Empty file detected: ${file}, using default`);
          return defaultValue;
        }
        
        try {
          const parsed = JSON.parse(trimmed);
          return parsed;
        } catch (parseError) {
          // JSON parse error - file is corrupted
          console.error(`[Storage] CORRUPTED JSON in ${file}:`, parseError);
          console.error(`[Storage] File content (first 200 chars): ${data.substring(0, 200)}`);
          
          // Try to restore from backup
          const restored = await this.restoreFromBackup(file);
          if (restored !== null) {
            console.log(`[Storage] Restored ${file} from backup`);
            return restored as T;
          }
          
          // If no backup, use default but don't silently continue
          console.error(`[Storage] No backup available for ${file}, using default value`);
          return defaultValue;
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          // File doesn't exist - this is normal for first run
          return defaultValue;
        }
        console.error(`[Storage] Error reading ${file}:`, err);
        throw err;
      }
    });
  }

  private async restoreFromBackup<T>(file: string): Promise<T | null> {
    try {
      const filename = path.basename(file);
      const backups = await fs.readdir(BACKUP_DIR);
      const thisFileBackups = backups
        .filter(b => b.startsWith(filename + '.') && b.endsWith('.bak'))
        .sort()
        .reverse();
      
      for (const backup of thisFileBackups) {
        try {
          const backupPath = path.join(BACKUP_DIR, backup);
          const data = await fs.readFile(backupPath, "utf-8");
          const parsed = JSON.parse(data);
          
          // Backup is valid - restore it
          await fs.copyFile(backupPath, file);
          return parsed;
        } catch {
          // This backup is also corrupted, try the next one
          continue;
        }
      }
    } catch {
      // No backups available
    }
    return null;
  }

  private async writeJSON<T>(file: string, data: T): Promise<void> {
    await this.ensureDataDir();
    const mutex = getMutex(file);
    
    await mutex.runExclusive(async () => {
      // Create backup before write
      await this.createBackup(file);
      
      // Write to temp file first (atomic write)
      const tempFile = `${file}.tmp.${Date.now()}`;
      const content = JSON.stringify(data, null, 2);
      
      try {
        await fs.writeFile(tempFile, content, "utf-8");
        
        // Verify the temp file is valid JSON
        const verification = await fs.readFile(tempFile, "utf-8");
        JSON.parse(verification);
        
        // Atomic rename
        await fs.rename(tempFile, file);
      } catch (err) {
        // Clean up temp file on error
        await fs.unlink(tempFile).catch(() => {});
        console.error(`[Storage] Failed to write ${file}:`, err);
        throw err;
      }
    });
  }

  async getFeeds(): Promise<Feed[]> {
    return this.readJSON<Feed[]>(FEEDS_FILE, []);
  }

  async getFeed(id: string): Promise<Feed | undefined> {
    const feeds = await this.getFeeds();
    return feeds.find(f => f.id === id);
  }

  async createFeed(insertFeed: InsertFeed): Promise<Feed> {
    const feeds = await this.getFeeds();
    const feed: Feed = {
      ...insertFeed,
      id: randomUUID(),
      lastChecked: null,
      status: 'idle',
      totalFound: 0,
    };
    feeds.push(feed);
    await this.writeJSON(FEEDS_FILE, feeds);
    return feed;
  }

  async updateFeed(id: string, updates: Partial<Feed>): Promise<Feed | undefined> {
    const feeds = await this.getFeeds();
    const index = feeds.findIndex(f => f.id === id);
    if (index === -1) return undefined;
    
    feeds[index] = { ...feeds[index], ...updates };
    await this.writeJSON(FEEDS_FILE, feeds);
    return feeds[index];
  }

  async deleteFeed(id: string): Promise<boolean> {
    const feeds = await this.getFeeds();
    const filtered = feeds.filter(f => f.id !== id);
    if (filtered.length === feeds.length) return false;
    await this.writeJSON(FEEDS_FILE, filtered);
    return true;
  }

  async getLogs(limit = 100): Promise<ScrapeLog[]> {
    const logs = await this.readJSON<ScrapeLog[]>(LOGS_FILE, []);
    return logs.slice(0, limit);
  }

  async addLog(insertLog: InsertLog): Promise<ScrapeLog> {
    const logs = await this.readJSON<ScrapeLog[]>(LOGS_FILE, []);
    const log: ScrapeLog = {
      ...insertLog,
      id: randomUUID(),
      timestamp: Date.now(),
    };
    logs.unshift(log);
    await this.writeJSON(LOGS_FILE, logs.slice(0, 100));
    return log;
  }

  async getStats(): Promise<Stats> {
    return this.readJSON<Stats>(STATS_FILE, {
      totalScraped: 0,
      linksFound: 0,
      submitted: 0,
    });
  }

  async incrementStat(key: keyof Stats, amount = 1): Promise<Stats> {
    const stats = await this.getStats();
    stats[key] += amount;
    await this.writeJSON(STATS_FILE, stats);
    return stats;
  }

  async getSettings(): Promise<Settings> {
    const defaults: Settings = {
      checkInterval: 15,
    };
    
    const stored = await this.readJSON<any>(SETTINGS_FILE, {});
    
    // Merge defaults with stored values
    const settings: Settings = {
      ...defaults,
      checkInterval: stored.checkInterval ?? defaults.checkInterval,
    };
    
    // Clean up legacy credential fields if they exist (one-time migration)
    if (stored.jdEmail || stored.jdPassword || stored.jdDevice || stored.jdUrl || stored.jdUser) {
      const cleanSettings = { checkInterval: settings.checkInterval };
      await this.writeJSON(SETTINGS_FILE, cleanSettings);
    }
    
    return settings;
  }

  async updateSettings(updates: Partial<Settings>): Promise<Settings> {
    const settings = await this.getSettings();
    const newSettings = { ...settings, ...updates };
    await this.writeJSON(SETTINGS_FILE, newSettings);
    return newSettings;
  }

  async isProcessed(url: string): Promise<boolean> {
    const processed = await this.readJSON<ProcessedUrl[] | string[]>(PROCESSED_FILE, []);
    // Handle both old format (string[]) and new format (ProcessedUrl[])
    if (processed.length === 0) return false;
    if (typeof processed[0] === 'string') {
      return (processed as string[]).includes(url);
    }
    return (processed as ProcessedUrl[]).some(p => p.url === url);
  }

  async markProcessed(url: string): Promise<void> {
    const raw = await this.readJSON<ProcessedUrl[] | string[]>(PROCESSED_FILE, []);
    
    // Migrate old format (string[]) to new format (ProcessedUrl[])
    let processed: ProcessedUrl[];
    if (raw.length === 0) {
      processed = [];
    } else if (typeof raw[0] === 'string') {
      // Migrate: assign current timestamp to all old entries
      processed = (raw as string[]).map(url => ({ url, timestamp: Date.now() }));
    } else {
      processed = raw as ProcessedUrl[];
    }
    
    if (!processed.some(p => p.url === url)) {
      processed.push({ url, timestamp: Date.now() });
      // Keep only the last 1000 URLs to prevent unlimited growth
      const trimmed = processed.slice(-1000);
      await this.writeJSON(PROCESSED_FILE, trimmed);
    }
  }

  async getExtractedItems(limit = 500): Promise<ExtractedItem[]> {
    const items = await this.readJSON<ExtractedItem[]>(EXTRACTED_FILE, []);
    return items.slice(0, limit);
  }

  async addExtractedItem(insertItem: InsertExtractedItem): Promise<ExtractedItem> {
    const items = await this.readJSON<ExtractedItem[]>(EXTRACTED_FILE, []);
    const item: ExtractedItem = {
      ...insertItem,
      id: randomUUID(),
      timestamp: Date.now(),
    };
    items.unshift(item);
    // Keep only the last 500 items
    await this.writeJSON(EXTRACTED_FILE, items.slice(0, 500));
    return item;
  }

  async markExtractedItemSubmitted(id: string): Promise<boolean> {
    const items = await this.readJSON<ExtractedItem[]>(EXTRACTED_FILE, []);
    const index = items.findIndex(item => item.id === id);
    if (index === -1) return false;
    
    items[index] = { ...items[index], submitted: true };
    await this.writeJSON(EXTRACTED_FILE, items);
    return true;
  }

  async getGrabbedItems(limit = 500): Promise<GrabbedItem[]> {
    const items = await this.readJSON<GrabbedItem[]>(GRABBED_FILE, []);
    return items.slice(0, limit);
  }

  async addGrabbedItem(insertItem: InsertGrabbedItem): Promise<GrabbedItem> {
    const items = await this.readJSON<GrabbedItem[]>(GRABBED_FILE, []);
    const item: GrabbedItem = {
      ...insertItem,
      id: randomUUID(),
      timestamp: Date.now(),
    };
    items.unshift(item);
    // Keep only the last 500 items
    await this.writeJSON(GRABBED_FILE, items.slice(0, 500));
    return item;
  }

  // Schedule persistence methods
  async getSchedule(): Promise<ScheduleEntry[]> {
    return this.readJSON<ScheduleEntry[]>(SCHEDULE_FILE, []);
  }

  async setScheduleEntry(entry: ScheduleEntry): Promise<void> {
    const schedule = await this.getSchedule();
    const index = schedule.findIndex(s => s.feedId === entry.feedId);
    if (index >= 0) {
      schedule[index] = entry;
    } else {
      schedule.push(entry);
    }
    await this.writeJSON(SCHEDULE_FILE, schedule);
  }

  async removeScheduleEntry(feedId: string): Promise<void> {
    const schedule = await this.getSchedule();
    const filtered = schedule.filter(s => s.feedId !== feedId);
    await this.writeJSON(SCHEDULE_FILE, filtered);
  }

  async clearEntries(): Promise<void> {
    // Clear logs, stats, processed URLs, extracted items, and grabbed items but keep feeds and settings
    await this.writeJSON(LOGS_FILE, []);
    await this.writeJSON(STATS_FILE, { totalScraped: 0, linksFound: 0, submitted: 0 });
    await this.writeJSON(PROCESSED_FILE, []);
    await this.writeJSON(EXTRACTED_FILE, []);
    await this.writeJSON(GRABBED_FILE, []);
  }

  async resetAll(): Promise<void> {
    // Wipe everything
    await this.writeJSON(FEEDS_FILE, []);
    await this.writeJSON(LOGS_FILE, []);
    await this.writeJSON(STATS_FILE, { totalScraped: 0, linksFound: 0, submitted: 0 });
    await this.writeJSON(SETTINGS_FILE, { checkInterval: 15 });
    await this.writeJSON(PROCESSED_FILE, []);
    await this.writeJSON(EXTRACTED_FILE, []);
    await this.writeJSON(GRABBED_FILE, []);
    await this.writeJSON(SCHEDULE_FILE, []);
  }

  async cleanupOldData(maxAgeMs: number = 60 * 24 * 60 * 60 * 1000): Promise<CleanupResult> {
    // Default: 60 days (approximately 2 months)
    const cutoffTime = Date.now() - maxAgeMs;
    const result: CleanupResult = { logs: 0, extracted: 0, grabbed: 0, processed: 0 };

    // Clean logs
    const logs = await this.readJSON<ScrapeLog[]>(LOGS_FILE, []);
    const freshLogs = logs.filter(log => log.timestamp > cutoffTime);
    result.logs = logs.length - freshLogs.length;
    if (result.logs > 0) {
      await this.writeJSON(LOGS_FILE, freshLogs);
    }

    // Clean extracted items
    const extracted = await this.readJSON<ExtractedItem[]>(EXTRACTED_FILE, []);
    const freshExtracted = extracted.filter(item => item.timestamp > cutoffTime);
    result.extracted = extracted.length - freshExtracted.length;
    if (result.extracted > 0) {
      await this.writeJSON(EXTRACTED_FILE, freshExtracted);
    }

    // Clean grabbed items
    const grabbed = await this.readJSON<GrabbedItem[]>(GRABBED_FILE, []);
    const freshGrabbed = grabbed.filter(item => item.timestamp > cutoffTime);
    result.grabbed = grabbed.length - freshGrabbed.length;
    if (result.grabbed > 0) {
      await this.writeJSON(GRABBED_FILE, freshGrabbed);
    }

    // Clean processed URLs
    const rawProcessed = await this.readJSON<ProcessedUrl[] | string[]>(PROCESSED_FILE, []);
    if (rawProcessed.length > 0) {
      let processed: ProcessedUrl[];
      
      if (typeof rawProcessed[0] === 'string') {
        // Migrate old format: assign old timestamp so they get cleaned up
        // Use cutoffTime - 1 day so old entries are immediately eligible for cleanup
        const oldTimestamp = cutoffTime - (24 * 60 * 60 * 1000);
        processed = (rawProcessed as string[]).map(url => ({ url, timestamp: oldTimestamp }));
      } else {
        processed = rawProcessed as ProcessedUrl[];
      }
      
      const freshProcessed = processed.filter(p => p.timestamp > cutoffTime);
      result.processed = processed.length - freshProcessed.length;
      
      // Always write if we migrated or removed entries
      if (result.processed > 0 || typeof rawProcessed[0] === 'string') {
        await this.writeJSON(PROCESSED_FILE, freshProcessed);
      }
    }

    return result;
  }
}

export const storage = new FileStorage();
