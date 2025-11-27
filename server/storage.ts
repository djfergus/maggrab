import { type Feed, type InsertFeed, type ScrapeLog, type InsertLog, type Stats, type Settings, type ExtractedItem, type InsertExtractedItem, type GrabbedItem, type InsertGrabbedItem } from "@shared/schema";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const FEEDS_FILE = path.join(DATA_DIR, "feeds.json");
const LOGS_FILE = path.join(DATA_DIR, "logs.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const PROCESSED_FILE = path.join(DATA_DIR, "processed.json");
const EXTRACTED_FILE = path.join(DATA_DIR, "extracted.json");
const GRABBED_FILE = path.join(DATA_DIR, "grabbed.json");

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
  
  // Data management
  clearEntries(): Promise<void>;
  resetAll(): Promise<void>;
}

export class FileStorage implements IStorage {
  private initialized = false;

  private async ensureDataDir() {
    if (!this.initialized) {
      try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        this.initialized = true;
      } catch (err) {
        console.error("Failed to create data directory:", err);
      }
    }
  }

  private async readJSON<T>(file: string, defaultValue: T): Promise<T> {
    await this.ensureDataDir();
    try {
      const data = await fs.readFile(file, "utf-8");
      return JSON.parse(data);
    } catch {
      return defaultValue;
    }
  }

  private async writeJSON<T>(file: string, data: T): Promise<void> {
    await this.ensureDataDir();
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
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
    const logs = await this.getLogs(1000);
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
    const processed = await this.readJSON<string[]>(PROCESSED_FILE, []);
    return processed.includes(url);
  }

  async markProcessed(url: string): Promise<void> {
    const processed = await this.readJSON<string[]>(PROCESSED_FILE, []);
    if (!processed.includes(url)) {
      processed.push(url);
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
    const items = await this.getExtractedItems(1000);
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
    const items = await this.getGrabbedItems(1000);
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
  }
}

export const storage = new FileStorage();
