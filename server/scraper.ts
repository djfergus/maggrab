import Parser from "rss-parser";
import { load } from "cheerio";
import axios, { AxiosError } from "axios";
import { storage, type ScheduleEntry } from "./storage";
import { log, broadcast } from "./index";
import * as cron from "node-cron";
import type { ExtractedItem } from "@shared/schema";

// @ts-ignore - jdownloader-api doesn't have type definitions
import jdownloaderAPI from "jdownloader-api";

const parser = new Parser();

// Configuration constants
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds
const RSS_TIMEOUT = 30000; // 30 seconds for RSS
const PAGE_TIMEOUT = 20000; // 20 seconds for pages
const HEARTBEAT_THRESHOLD = 120000; // 2 minutes
const MAX_CONCURRENT_FEEDS = 5; // Limit concurrent scrapes

// JDownloader submission
const JD_REQUEST_TIMEOUT = 30000; // jdownloader-api has no timeout of its own and can hang
const JD_SESSION_MAX_IDLE = 30 * 60 * 1000; // Reconnect rather than reuse a session idle this long
const SUBMIT_RETRY_CRON = '*/10 * * * *';
const SUBMIT_RETRY_STARTUP_DELAY = 60000; // Give JDownloader time to come up after a host reboot
const SUBMIT_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // Stop retrying items older than this
// Wait before the next retry, indexed by attempts already made (last value repeats)
const SUBMIT_BACKOFF = [0, 10, 30, 60, 360].map(minutes => minutes * 60 * 1000);

// downup via downup-resolver. Off unless DOWNUP_RESOLVER_URL is set, in which
// case downup is tried first and novafile is the fallback.
const DOWNUP_RESOLVER_URL = (process.env.DOWNUP_RESOLVER_URL || "").replace(/\/+$/, "");
// How long to keep waiting for downup (cooldown or resolver failure) before using novafile
const DOWNUP_MAX_DEFER = Number(process.env.DOWNUP_MAX_DEFER_MINUTES || 180) * 60 * 1000;
// How long a resolved direct link is reused if sending it to JDownloader fails
const DOWNUP_LINK_TTL = Number(process.env.DOWNUP_LINK_TTL_MINUTES || 60) * 60 * 1000;
// The resolver serialises requests and each takes ~75s, so allow for a short queue
const DOWNUP_RESOLVE_TIMEOUT = 240000;
const DOWNUP_HOSTS = ['dwp.la', 'downup.me', 'downup.space'];

function isDownupHost(host: string): boolean {
  return DOWNUP_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

type DownupResult =
  | { status: 'ok'; directUrl: string; filename: string; size: number | null }
  | { status: 'cooldown'; waitSeconds: number; message: string }
  | { status: 'not_found' | 'error'; message: string };

type SubmitTarget = { url: string; via: 'novafile' | 'downup' | 'other'; packageName: string | null };

function submitBackoff(attempts: number): number {
  return SUBMIT_BACKOFF[Math.min(attempts, SUBMIT_BACKOFF.length - 1)];
}

// jdownloader-api rejects with whatever MyJDownloader returned, which is often
// a string or plain object rather than an Error
function describeError(error: unknown): string {
  let text: string;
  if (error instanceof Error) {
    text = error.message || error.name;
  } else if (typeof error === 'string') {
    text = error;
  } else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error);
    }
  }
  // MyJDownloader errors arrive as pretty-printed JSON; keep log lines on one line
  return text.replace(/\\n|\s+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 300) || 'Unknown error';
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Track JDownloader connection state
let jdConnected = false;
let jdDeviceId: string | null = null;
let jdDeviceName: string | null = null;
let jdConnectionAttempts = 0;
let lastJdErrorTime = 0;
let lastJdActivity = 0;
let lastJdConnectError: string | null = null;

// Track running feeds with concurrency control
let runningFeedCount = 0;

// Export connection status for API
export function getJDConnectionStatus() {
  const email = process.env.MYJD_EMAIL || "";
  const password = process.env.MYJD_PASSWORD || "";
  const configuredDevice = process.env.MYJD_DEVICE || "";
  
  return {
    configured: !!(email && password),
    connected: jdConnected,
    email: email ? email.replace(/(.{2}).*@/, "$1***@") : undefined,
    deviceName: jdDeviceName || configuredDevice || undefined,
    connectionAttempts: jdConnectionAttempts,
    lastErrorTime: lastJdErrorTime,
  };
}

// downup-resolver status for the settings page
export async function getDownupStatus() {
  const base = { enabled: !!DOWNUP_RESOLVER_URL, maxDeferMinutes: DOWNUP_MAX_DEFER / 60000 };
  if (!DOWNUP_RESOLVER_URL) return base;
  try {
    const res = await axios.get(`${DOWNUP_RESOLVER_URL}/health`, { timeout: 5000 });
    return { ...base, reachable: true, busy: !!res.data.busy, selfTest: res.data.selfTest };
  } catch (error: unknown) {
    return { ...base, reachable: false, error: describeError(error) };
  }
}

// Test JDownloader connection and get package count
export async function testJDConnection(): Promise<{
  success: boolean;
  error?: string;
  deviceName?: string;
  packageCount?: number;
}> {
  const email = process.env.MYJD_EMAIL || "";
  const password = process.env.MYJD_PASSWORD || "";
  const configuredDevice = process.env.MYJD_DEVICE || "";

  if (!email || !password) {
    return { success: false, error: "MyJDownloader credentials not configured" };
  }

  try {
    // Connect to MyJDownloader cloud service
    await jdownloaderAPI.connect(email, password);
    
    // Get available devices
    let devices;
    try {
      devices = await jdownloaderAPI.listDevices();
    } catch (deviceError: any) {
      jdConnected = false;
      jdDeviceId = null;
      jdDeviceName = null;
      return { success: false, error: `Failed to list devices: ${deviceError.message}` };
    }
    
    if (!devices || devices.length === 0) {
      jdConnected = false;
      jdDeviceId = null;
      jdDeviceName = null;
      return { success: false, error: "No JDownloader devices found. Make sure JDownloader is running and connected to MyJDownloader." };
    }

    // Find the target device
    let targetDevice = devices[0];
    if (configuredDevice) {
      const found = devices.find((d: any) => 
        d.name?.toLowerCase() === configuredDevice.toLowerCase() ||
        d.id === configuredDevice
      );
      if (found) targetDevice = found;
    }

    // Update connection state
    jdConnected = true;
    jdDeviceId = targetDevice.id;
    jdDeviceName = targetDevice.name;

    // Try to query packages to verify device is responsive
    let packageCount = 0;
    try {
      const packages = await jdownloaderAPI.queryPackages(targetDevice.id);
      packageCount = Array.isArray(packages) ? packages.length : 0;
    } catch (queryError: any) {
      // If queryPackages fails, the device may not be responding
      // But connection itself succeeded, so we'll return success with 0 packages
      packageCount = 0;
    }

    return {
      success: true,
      deviceName: targetDevice.name,
      packageCount,
    };
  } catch (error: any) {
    jdConnected = false;
    jdDeviceId = null;
    jdDeviceName = null;
    const errorMessage = error.message || "Connection failed";
    return { success: false, error: errorMessage };
  }
}

export class Scraper {
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private runningFeeds: Set<string> = new Set(); // Single-flight guard
  private isRunning = false;
  private heartbeatTask: cron.ScheduledTask | null = null;
  private cleanupTask: cron.ScheduledTask | null = null;
  private submitRetryTask: cron.ScheduledTask | null = null;
  private submitRetryTimer: NodeJS.Timeout | null = null;
  private submitRetryRunning = false;
  private submittingIds: Set<string> = new Set(); // Guards against double-submitting an item
  private lastHeartbeat: number = 0;

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastHeartbeat = Date.now();
    
    try {
      await storage.addLog({
        level: "info",
        message: "Daemon started - Maggrab v0.1.0",
        source: "daemon",
      });

      log("Grabber daemon started", "grabber");
      
      // Run cleanup on startup (remove entries older than 2 months)
      await this.runCleanup();
      
      // Schedule daily cleanup at 3 AM
      this.cleanupTask = cron.schedule('0 3 * * *', () => {
        this.runCleanup();
      });
      
      // Start heartbeat - logs every minute to prove daemon is alive
      this.heartbeatTask = cron.schedule('* * * * *', () => {
        this.heartbeat();
      });
      
      // Retry JDownloader submissions that failed earlier
      this.submitRetryTask = cron.schedule(SUBMIT_RETRY_CRON, () => {
        this.retryPendingSubmissions();
      });
      this.submitRetryTimer = setTimeout(() => {
        this.submitRetryTimer = null;
        this.retryPendingSubmissions();
      }, SUBMIT_RETRY_STARTUP_DELAY);
      
      // Load schedule and check for missed runs
      await this.recoverSchedule();
      
      // Load all feeds and start monitoring
      const feeds = await storage.getFeeds();
      for (const feed of feeds) {
        await this.scheduleFeed(feed.id);
      }

      log(`Scheduler initialized with ${feeds.length} feeds`, "daemon");
    } catch (error: any) {
      log(`Failed to start scraper: ${error.message}`, "daemon");
      await this.stop();
      throw error;
    }
  }

  private async heartbeat() {
    this.lastHeartbeat = Date.now();
    const feeds = await storage.getFeeds();
    const schedule = await storage.getSchedule();
    
    // Log heartbeat every 10 minutes (not every minute to reduce noise)
    const now = new Date();
    if (now.getMinutes() % 10 === 0) {
      log(`Heartbeat: ${feeds.length} feeds monitored, ${this.cronJobs.size} jobs scheduled, ${runningFeedCount} running`, "daemon");
    }
    
    // Broadcast status to connected WebSocket clients
    broadcast({
      type: 'heartbeat',
      timestamp: this.lastHeartbeat,
      feedCount: feeds.length,
      jobCount: this.cronJobs.size,
      runningCount: runningFeedCount,
    });
  }

  getHealth() {
    const now = Date.now();
    const timeSinceHeartbeat = now - this.lastHeartbeat;
    const healthy = this.isRunning && timeSinceHeartbeat < HEARTBEAT_THRESHOLD;
    
    return {
      healthy,
      running: this.isRunning,
      lastHeartbeat: this.lastHeartbeat,
      timeSinceHeartbeat,
      scheduledJobs: this.cronJobs.size,
      runningJobs: this.runningFeeds.size,
      runningCount: runningFeedCount,
    };
  }

  private async recoverSchedule() {
    try {
      const schedule = await storage.getSchedule();
      const now = Date.now();
      let missedRuns = 0;
      
      for (const entry of schedule) {
        try {
          // Check if this feed still exists
          const feed = await storage.getFeed(entry.feedId);
          if (!feed) {
            await storage.removeScheduleEntry(entry.feedId);
            continue;
          }
          
          // Check if we missed a run
          if (entry.nextRun < now) {
            missedRuns++;
            log(`Catching up missed run for feed: ${feed.name}`, "daemon");
            
            // Update schedule entry FIRST to prevent repeated triggers
            const intervalMs = feed.interval * 60 * 1000;
            await storage.setScheduleEntry({
              feedId: entry.feedId,
              nextRun: now + intervalMs,
              intervalMinutes: feed.interval,
            });
            
            // Then run the catch-up scrape (don't await to avoid blocking)
            this.scrapeFeed(entry.feedId);
          }
        } catch (error: any) {
          log(`Error recovering schedule for feed ${entry.feedId}: ${error.message}`, "daemon");
        }
      }
      
      if (missedRuns > 0) {
        await storage.addLog({
          level: "info",
          message: `Recovered ${missedRuns} missed grab job(s) from downtime`,
          source: "daemon",
        });
      }
    } catch (error: any) {
      log(`Error in schedule recovery: ${error.message}`, "daemon");
    }
  }

  private async runCleanup() {
    try {
      const result = await storage.cleanupOldData();
      const total = result.logs + result.extracted + result.grabbed + result.processed;
      
      if (total > 0) {
        await storage.addLog({
          level: "info",
          message: `Cleanup complete: removed ${result.logs} logs, ${result.extracted} extracted, ${result.grabbed} grabbed, ${result.processed} processed URLs (${total} total entries older than 2 months)`,
          source: "daemon",
        });
        log(`Cleanup removed ${total} old entries`, "daemon");
      } else {
        log("Cleanup: no old entries to remove", "daemon");
      }
    } catch (err: any) {
      log(`Cleanup error: ${err.message}`, "daemon");
    }
  }

  async stop() {
    this.isRunning = false;
    
    // Stop all cron jobs
    this.cronJobs.forEach((job, id) => {
      try {
        job.stop();
      } catch (error) {
        log(`Error stopping cron job ${id}: ${error}`, "daemon");
      }
    });
    this.cronJobs.clear();
    
    // Stop heartbeat
    if (this.heartbeatTask) {
      this.heartbeatTask.stop();
      this.heartbeatTask = null;
    }
    
    // Stop cleanup task
    if (this.cleanupTask) {
      this.cleanupTask.stop();
      this.cleanupTask = null;
    }
    
    // Stop submission retries
    if (this.submitRetryTask) {
      this.submitRetryTask.stop();
      this.submitRetryTask = null;
    }
    if (this.submitRetryTimer) {
      clearTimeout(this.submitRetryTimer);
      this.submitRetryTimer = null;
    }
    
    // Clear running feeds set
    this.runningFeeds.clear();
    runningFeedCount = 0;
    
    await storage.addLog({
      level: "info",
      message: "Daemon stopped",
      source: "daemon",
    });
    
    log("Grabber daemon stopped", "grabber");
  }

  async scheduleFeed(feedId: string) {
    const feed = await storage.getFeed(feedId);
    if (!feed) return;

    // Clear existing job if any
    const existing = this.cronJobs.get(feedId);
    if (existing) {
      try {
        existing.stop();
      } catch (error) {
        log(`Error stopping existing cron job for ${feedId}: ${error}`, "daemon");
      }
      this.cronJobs.delete(feedId);
    }

    // Calculate next run time
    const now = Date.now();
    const intervalMs = feed.interval * 60 * 1000;
    const nextRun = now + intervalMs;
    
    // Store schedule entry for recovery
    try {
      await storage.setScheduleEntry({
        feedId,
        nextRun,
        intervalMinutes: feed.interval,
      });
    } catch (error: any) {
      log(`Failed to store schedule entry for ${feedId}: ${error.message}`, "daemon");
      return;
    }

    // Create cron expression for interval (run every N minutes)
    // node-cron doesn't directly support "every N minutes", so we use a workaround
    // We'll check every minute and see if it's time to run
    const job = cron.schedule('* * * * *', async () => {
      try {
        const entry = (await storage.getSchedule()).find(s => s.feedId === feedId);
        if (entry && Date.now() >= entry.nextRun) {
          await this.scrapeFeed(feedId);
        }
      } catch (error: any) {
        log(`Error in cron job for ${feedId}: ${error.message}`, "daemon");
      }
    });
    
    this.cronJobs.set(feedId, job);
    
    // Run immediately on first schedule
    await this.scrapeFeed(feedId);
  }

  async unscheduleFeed(feedId: string) {
    const job = this.cronJobs.get(feedId);
    if (job) {
      try {
        job.stop();
      } catch (error) {
        log(`Error stopping cron job ${feedId}: ${error}`, "daemon");
      }
      this.cronJobs.delete(feedId);
    }
    try {
      await storage.removeScheduleEntry(feedId);
    } catch (error: any) {
      log(`Failed to remove schedule entry for ${feedId}: ${error.message}`, "daemon");
    }
  }

  private async scrapeFeed(feedId: string) {
    // Single-flight guard - prevent overlapping runs for same feed
    if (this.runningFeeds.has(feedId)) {
      log(`Skipping ${feedId} - already running`, "grabber");
      return;
    }
    
    // Concurrency control
    if (runningFeedCount >= MAX_CONCURRENT_FEEDS) {
      log(`Skipping ${feedId} - max concurrent feeds reached (${MAX_CONCURRENT_FEEDS})`, "grabber");
      return;
    }
    
    const feed = await storage.getFeed(feedId);
    if (!feed) return;

    this.runningFeeds.add(feedId);
    runningFeedCount++;

    // Update schedule entry at START to prevent cron from re-triggering during scrape
    const intervalMs = feed.interval * 60 * 1000;
    try {
      await storage.setScheduleEntry({
        feedId,
        nextRun: Date.now() + intervalMs,
        intervalMinutes: feed.interval,
      });
    } catch (error: any) {
      log(`Failed to update schedule for ${feedId}: ${error.message}`, "grabber");
      this.runningFeeds.delete(feedId);
      runningFeedCount--;
      return;
    }
    
    try {
      await storage.updateFeed(feedId, { status: "scraping", lastChecked: Date.now() });
      await storage.addLog({
        level: "info",
        message: `Starting grab job for feed: ${feed.name}`,
        source: "grabber",
      });

      log(`Grabbing feed: ${feed.name}`, "grabber");
      
      // Broadcast status update
      broadcast({ type: 'feedStatus', feedId, status: 'scraping' });

      // Parse RSS feed with retry logic
      let rssFeed;
      try {
        rssFeed = await this.parseRSSWithRetry(feed.url);
      } catch (parseErr: any) {
        // Check if this looks like an HTML page instead of RSS
        const errMsg = parseErr.message || '';
        if (errMsg.includes('Attribute without value') || errMsg.includes('Non-whitespace before first tag')) {
          throw new Error(`Invalid RSS feed URL - this appears to be an HTML page, not an RSS feed. Try adding /rss.xml to the URL.`);
        }
        throw parseErr;
      }
      
      if (!rssFeed.items || rssFeed.items.length === 0) {
        await storage.addLog({
          level: "info",
          message: `No new items found in ${feed.name}`,
          source: "grabber",
        });
        await storage.updateFeed(feedId, { status: "idle" });
        broadcast({ type: 'feedStatus', feedId, status: 'idle' });
        return;
      }

      // Filter out already processed items
      const unprocessedItems = [];
      for (const item of rssFeed.items) {
        if (item.link && !(await storage.isProcessed(item.link))) {
          unprocessedItems.push(item);
        }
      }

      // Apply title filter if configured
      let newItems = unprocessedItems;
      let filteredCount = 0;
      if (feed.filter && feed.filter.trim()) {
        const filterLower = feed.filter.toLowerCase();
        newItems = unprocessedItems.filter(item => {
          const title = (item.title || '').toLowerCase();
          return title.includes(filterLower);
        });
        filteredCount = unprocessedItems.length - newItems.length;
      }

      if (newItems.length === 0) {
        const alreadyProcessed = rssFeed.items.length - unprocessedItems.length;
        const filterMsg = filteredCount > 0 ? `, ${filteredCount} filtered out` : '';
        await storage.addLog({
          level: "info",
          message: `No new items in ${feed.name} (${alreadyProcessed} already processed${filterMsg})`,
          source: "grabber",
        });
        await storage.updateFeed(feedId, { status: "idle" });
        broadcast({ type: 'feedStatus', feedId, status: 'idle' });
        return;
      }

      const alreadyProcessed = rssFeed.items.length - unprocessedItems.length;
      const filterMsg = filteredCount > 0 ? `, ${filteredCount} filtered out` : '';
      await storage.addLog({
        level: "success",
        message: `Found ${newItems.length} new items in ${feed.name} (${alreadyProcessed} already processed${filterMsg})`,
        source: "grabber",
      });

      await storage.incrementStat("totalScraped", newItems.length);
      await storage.updateFeed(feedId, { 
        totalFound: feed.totalFound + newItems.length 
      });

      // Broadcast stats update
      const stats = await storage.getStats();
      broadcast({ type: 'stats', data: stats });

      // Process each new item
      for (const item of newItems.slice(0, 10)) {
        if (item.link) {
          try {
            const articleTitle = item.title || item.link;
            const allLinks = await this.findDownloadLinksWithRetry(item.link);
            // downup links only count when the resolver is enabled: JDownloader
            // cannot pass downup's captcha on its own
            const downupLink = allLinks.find(l => isDownupHost(l.host));
            const downloadLinks = allLinks.filter(l => !isDownupHost(l.host));
            const useDownup = !!(DOWNUP_RESOLVER_URL && downupLink);
            const hasDownload = downloadLinks.length > 0 || useDownup;
            
            // Store every grabbed item from the RSS feed
            const grabbedItem = await storage.addGrabbedItem({
              feedId,
              feedName: feed.name,
              title: articleTitle,
              link: item.link,
              pubDate: item.pubDate || null,
              hasDownload,
            });
            
            // Broadcast new grabbed item
            broadcast({ type: 'grabbed', data: grabbedItem });
            
            if (hasDownload) {
              // Prioritize novafile links, then nfile
              const preferredLink = downloadLinks.find(l => l.host.includes('novafile'))
                || downloadLinks.find(l => l.host.includes('nfile'))
                || downloadLinks[0]
                || downupLink!;
              const using = useDownup && preferredLink !== downupLink
                ? `downup, falling back to ${preferredLink.host}`
                : preferredLink.host;
              
              await storage.addLog({
                level: "info",
                message: `Extracted ${allLinks.length} link(s) from: ${articleTitle} - using ${using}`,
                source: "grabber",
              });
              
              // Store the preferred link as an extracted item
              const extractedItem = await storage.addExtractedItem({
                feedId,
                articleTitle,
                articleUrl: item.link,
                downloadUrl: preferredLink.url,
                host: preferredLink.host,
                submitted: false,
                downupUrl: downupLink?.url ?? null,
              });
              
              // Broadcast new extracted item
              broadcast({ type: 'extracted', data: extractedItem });
              
              await storage.incrementStat("linksFound");
              
              // Only submit the preferred link to JDownloader. If this fails the
              // item stays unsubmitted and the retry job picks it up later.
              await this.submitToJDownloader(extractedItem);
            }
            // Mark this item as processed (even if no links found)
            await storage.markProcessed(item.link);
          } catch (err: any) {
            await storage.addLog({
              level: "warn",
              message: `Failed to process item: ${err.message}`,
              source: "grabber",
            });
          }
        }
      }

      await storage.updateFeed(feedId, { status: "idle" });
      broadcast({ type: 'feedStatus', feedId, status: 'idle' });
      
      // Update next run time
      const intervalMs = feed.interval * 60 * 1000;
      try {
        await storage.setScheduleEntry({
          feedId,
          nextRun: Date.now() + intervalMs,
          intervalMinutes: feed.interval,
        });
      } catch (error: any) {
        log(`Failed to update schedule after completion for ${feedId}: ${error.message}`, "grabber");
      }
      
    } catch (error: any) {
      await storage.updateFeed(feedId, { status: "error" });
      await storage.addLog({
        level: "error",
        message: `Error grabbing ${feed.name}: ${error.message}`,
        source: "grabber",
      });
      log(`Error grabbing feed ${feed.name}: ${error.message}`, "grabber");
      broadcast({ type: 'feedStatus', feedId, status: 'error' });
    } finally {
      this.runningFeeds.delete(feedId);
      runningFeedCount = Math.max(0, runningFeedCount - 1);
    }
  }

  private async parseRSSWithRetry(url: string, retries: number = MAX_RETRIES): Promise<any> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await parser.parseURL(url);
      } catch (error: any) {
        if (attempt === retries) {
          throw error;
        }
        
        log(`RSS parse attempt ${attempt} failed for ${url}: ${error.message}`, "grabber");
        
        // Exponential backoff
        const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
        await this.sleep(delay);
      }
    }
  }

  private async findDownloadLinksWithRetry(url: string, retries: number = MAX_RETRIES): Promise<Array<{url: string, host: string}>> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this.findDownloadLinks(url);
      } catch (error: any) {
        if (attempt === retries) {
          throw error;
        }
        
        log(`Download link extraction attempt ${attempt} failed for ${url}: ${error.message}`, "grabber");
        
        // Exponential backoff
        const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
        await this.sleep(delay);
      }
    }
    throw new Error(`Download link extraction failed for ${url}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getHostFromUrl(url: string): string {
    try {
      const hostname = new URL(url).hostname;
      // Extract the main domain part
      const parts = hostname.split('.');
      if (parts.length >= 2) {
        return parts.slice(-2).join('.');
      }
      return hostname;
    } catch {
      return 'unknown';
    }
  }

  private async findDownloadLinks(url: string): Promise<Array<{url: string, host: string}>> {
    try {
      const response = await axios.get(url, { 
        timeout: PAGE_TIMEOUT, 
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        maxRedirects: 5,
        validateStatus: (status) => status < 500, // Accept 4xx as we might get 403/429
      });
      
      // Handle rate limiting
      if (response.status === 429) {
        throw new Error(`Rate limited by ${new URL(url).hostname}`);
      }
      
      const $ = load(response.data);
      const foundLinks: Array<{url: string, host: string}> = [];
      
      // Method 1: Find base64-encoded redirect links (downmagaz.net pattern)
      // These look like: /engine/go.php?url=aHR0cHM6Ly9uZmlsZS5jYy9qQllkVkI2cQ==
      $('a[href*="engine/go.php?url="]').each((_, el) => {
        const href = $(el).attr('href');
        if (href) {
          try {
            const urlObj = new URL(href, url);
            const encodedUrl = urlObj.searchParams.get('url');
            if (encodedUrl) {
              // Decode the base64-encoded URL
              const decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8');
              if (decodedUrl.startsWith('http')) {
                foundLinks.push({ url: decodedUrl, host: this.getHostFromUrl(decodedUrl) });
                log(`Decoded base64 link: ${decodedUrl}`, "grabber");
              }
            }
          } catch (e) {
            // Skip malformed URLs
          }
        }
      });

      // Method 2: Look for direct file hosting links
      const fileHostingDomains = [
        'nfile.cc', 'novafile.org', 'turbobit.net', 'trbt.cc',
        'rapidgator.net', 'nitroflare.com', 'mega.nz', 'mediafire.com',
        'katfile.com', 'uploadgig.com', 'filefox.cc',
        ...DOWNUP_HOSTS,
      ];
      
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href) {
          for (const domain of fileHostingDomains) {
            if (href.includes(domain)) {
              let finalUrl = href;
              if (!href.startsWith('http')) {
                try {
                  finalUrl = new URL(href, url).toString();
                } catch {
                  return; // Skip malformed URLs
                }
              }
              foundLinks.push({ url: finalUrl, host: this.getHostFromUrl(finalUrl) });
              break;
            }
          }
        }
      });

      // Remove duplicates based on URL
      const seen = new Set<string>();
      return foundLinks.filter(link => {
        if (seen.has(link.url)) return false;
        seen.add(link.url);
        return true;
      });
    } catch (error: any) {
      // Handle specific error types
      if (error.code === 'ECONNABORTED') {
        throw new Error(`Timeout fetching ${url}`);
      } else if (error.code === 'ENOTFOUND') {
        throw new Error(`DNS lookup failed for ${url}`);
      } else if (error.response?.status === 403) {
        throw new Error(`Access forbidden for ${url}`);
      } else if (error.response?.status === 429) {
        throw new Error(`Rate limited by ${new URL(url).hostname}`);
      }
      
      throw new Error(`Error finding download link: ${error.message}`);
    }
  }

  private async disconnectJD(): Promise<void> {
    try {
      if (jdConnected) {
        await withTimeout(jdownloaderAPI.disconnect(), JD_REQUEST_TIMEOUT, "MyJDownloader disconnect");
      }
    } catch {
      // Ignore disconnect errors
    } finally {
      jdConnected = false;
      jdDeviceId = null;
      jdDeviceName = null;
    }
  }

  private getJDCredentials(): { email: string; password: string; device: string } | null {
    const email = process.env.MYJD_EMAIL || "";
    const password = process.env.MYJD_PASSWORD || "";
    const device = process.env.MYJD_DEVICE || "";
    
    if (!email || !password) {
      return null;
    }
    
    return { email, password, device };
  }

  private async ensureJDConnection(): Promise<boolean> {
    const credentials = this.getJDCredentials();
    
    if (!credentials) {
      return false;
    }

    // Already connected, unless the session has sat idle long enough to have expired
    if (jdConnected && jdDeviceId) {
      if (Date.now() - lastJdActivity < JD_SESSION_MAX_IDLE) {
        return true;
      }
      log("MyJDownloader session idle, reconnecting", "jdownloader");
      await this.disconnectJD();
    }

    try {
      // Connect to MyJDownloader
      await withTimeout(
        jdownloaderAPI.connect(credentials.email, credentials.password),
        JD_REQUEST_TIMEOUT,
        "MyJDownloader connect",
      );
      jdConnected = true;
      jdConnectionAttempts = 0;
      lastJdActivity = Date.now();

      await storage.addLog({
        level: "success",
        message: "Connected to MyJDownloader",
        source: "jdownloader",
      });
      log("Connected to MyJDownloader", "jdownloader");

      // Get available devices
      let devices: any[];
      try {
        devices = await withTimeout<any[]>(jdownloaderAPI.listDevices(), JD_REQUEST_TIMEOUT, "MyJDownloader listDevices");
      } catch (deviceError: unknown) {
        lastJdConnectError = `Failed to list devices: ${describeError(deviceError)}`;
        await storage.addLog({
          level: "error",
          message: lastJdConnectError,
          source: "jdownloader",
        });
        log(lastJdConnectError, "jdownloader");
        await this.disconnectJD();
        return false;
      }
      
      if (!devices || devices.length === 0) {
        lastJdConnectError = "No JDownloader devices online. Make sure JDownloader is running.";
        await storage.addLog({
          level: "error",
          message: lastJdConnectError,
          source: "jdownloader",
        });
        log(lastJdConnectError, "jdownloader");
        await this.disconnectJD();
        return false;
      }

      // Use specified device or first available
      if (credentials.device) {
        const targetDevice = devices.find((d: any) => 
          d.name?.toLowerCase() === credentials.device.toLowerCase() ||
          d.id === credentials.device
        );
        if (targetDevice) {
          jdDeviceId = targetDevice.id;
          jdDeviceName = targetDevice.name;
        } else {
          // Don't fall back to another device: links sent there would be
          // marked as submitted but never reach the intended JDownloader
          const online = devices.map((d: any) => d.name).join(", ");
          lastJdConnectError = `Device "${credentials.device}" is not online (online: ${online})`;
          await storage.addLog({
            level: "error",
            message: lastJdConnectError,
            source: "jdownloader",
          });
          log(lastJdConnectError, "jdownloader");
          await this.disconnectJD();
          return false;
        }
      } else {
        jdDeviceId = devices[0].id;
        jdDeviceName = devices[0].name;
        await storage.addLog({
          level: "info",
          message: `Using JDownloader device: ${devices[0].name}`,
          source: "jdownloader",
        });
      }

      lastJdConnectError = null;
      return true;
    } catch (error: unknown) {
      jdConnectionAttempts++;
      lastJdErrorTime = Date.now();
      lastJdConnectError = `Failed to connect to MyJDownloader: ${describeError(error)}`;
      
      await this.disconnectJD();
      await storage.addLog({
        level: "error",
        message: lastJdConnectError,
        source: "jdownloader",
      });
      log(lastJdConnectError, "jdownloader");
      return false;
    }
  }

  /**
   * Send an extracted link to JDownloader. Tries twice, reconnecting in
   * between, and records the outcome on the item so failures can be retried.
   * Returns true if the link was accepted.
   */
  private async submitToJDownloader(item: ExtractedItem): Promise<boolean> {
    if (this.submittingIds.has(item.id)) return false;
    this.submittingIds.add(item.id);

    try {
      const attempts = (item.submitAttempts ?? 0) + 1;
      let lastError = "MyJDownloader not configured (add MYJD_EMAIL and MYJD_PASSWORD secrets)";

      let target: SubmitTarget = { url: item.downloadUrl, via: this.viaFor(item.downloadUrl), packageName: null };
      if (DOWNUP_RESOLVER_URL && item.downupUrl) {
        const choice = await this.chooseDownup(item, attempts);
        if (choice === 'deferred') return false;
        if (choice) target = choice;
      }
      if (target.via !== 'downup' && isDownupHost(hostOf(target.url))) {
        // Only a downup page link and it could not be resolved: JDownloader can't use it directly.
        // (A resolved direct link is also on a downup host, e.g. s3.downup.me, hence the via check.)
        lastError = "downup link could not be resolved and there is no other link";
      } else if (this.getJDCredentials()) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const connected = await this.ensureJDConnection();
            if (!connected || !jdDeviceId) {
              throw new Error(lastJdConnectError || "Not connected to MyJDownloader");
            }

            // addLinks expects an array of links, not a single string
            await withTimeout(
              jdownloaderAPI.addLinks([target.url], jdDeviceId, true, target.packageName),
              JD_REQUEST_TIMEOUT,
              "MyJDownloader addLinks",
            );
            lastJdActivity = Date.now();

            await storage.updateExtractedItem(item.id, {
              submitted: true,
              submitAttempts: attempts,
              lastSubmitAttempt: Date.now(),
              lastSubmitError: null,
              nextAttemptAt: null,
              submittedVia: target.via,
            });
            await storage.addLog({
              level: "success",
              message: `Submitted to JDownloader via ${target.via}: ${item.articleTitle}`,
              source: "jdownloader",
            });
            await storage.incrementStat("submitted");

            const stats = await storage.getStats();
            broadcast({ type: 'stats', data: stats });
            broadcast({ type: 'extracted' });

            log(`Submitted to JDownloader via ${target.via}: ${item.articleTitle}`, "grabber");
            return true;
          } catch (error: unknown) {
            lastError = describeError(error);
            // Drop the session so the next attempt starts fresh
            await this.disconnectJD();
            if (attempt === 1) {
              log(`Submit failed for ${item.articleTitle}, reconnecting and retrying: ${lastError}`, "jdownloader");
            }
          }
        }
      }

      await storage.updateExtractedItem(item.id, {
        submitAttempts: attempts,
        lastSubmitAttempt: Date.now(),
        lastSubmitError: lastError,
        nextAttemptAt: null,
      });
      const nextRetryMinutes = Math.round(submitBackoff(attempts) / 60000);
      const message = `Failed to submit to JDownloader via ${target.via} (attempt ${attempts}, will retry in ~${nextRetryMinutes}m): ${item.articleTitle}: ${lastError}`;
      await storage.addLog({
        level: "error",
        message,
        source: "jdownloader",
      });
      log(message, "jdownloader");
      broadcast({ type: 'extracted' });
      return false;
    } finally {
      this.submittingIds.delete(item.id);
    }
  }

  private viaFor(url: string): SubmitTarget['via'] {
    const host = hostOf(url);
    if (isDownupHost(host)) return 'downup';
    if (host.includes('novafile') || host.includes('nfile')) return 'novafile';
    return 'other';
  }

  private async resolveDownup(url: string): Promise<DownupResult> {
    try {
      const res = await axios.post(`${DOWNUP_RESOLVER_URL}/resolve`, { url }, { timeout: DOWNUP_RESOLVE_TIMEOUT });
      return res.data as DownupResult;
    } catch (error: unknown) {
      return { status: 'error', message: `downup-resolver unreachable: ${describeError(error)}` };
    }
  }

  /**
   * Get a downup direct link for an item. Returns the target to send, null to
   * fall back to the item's other link, or 'deferred' when the item should wait
   * for downup (cooldown or resolver failure, within DOWNUP_MAX_DEFER).
   */
  private async chooseDownup(item: ExtractedItem, attempts: number): Promise<SubmitTarget | null | 'deferred'> {
    const now = Date.now();
    const target = (url: string): SubmitTarget => ({ url, via: 'downup', packageName: item.articleTitle });

    // Reuse a recent link, e.g. when JDownloader was unreachable last time
    if (item.resolvedUrl && item.resolvedAt && now - item.resolvedAt < DOWNUP_LINK_TTL) {
      return target(item.resolvedUrl);
    }

    const result = await this.resolveDownup(item.downupUrl!);
    if (result.status === 'ok') {
      await storage.updateExtractedItem(item.id, { resolvedUrl: result.directUrl, resolvedAt: Date.now() });
      const size = result.size ? ` (${Math.round(result.size / 1048576)} MB)` : "";
      await storage.addLog({ level: "info", message: `downup link ready${size}: ${item.articleTitle}`, source: "grabber" });
      return target(result.directUrl);
    }

    const hasFallback = !isDownupHost(item.host);
    const deferUntil = item.timestamp + DOWNUP_MAX_DEFER;
    if (result.status === 'not_found' || (hasFallback && now >= deferUntil)) {
      const message = hasFallback
        ? `downup not used (${result.message}), falling back to ${item.host}: ${item.articleTitle}`
        : `downup not used (${result.message}): ${item.articleTitle}`;
      await storage.addLog({ level: "warn", message, source: "grabber" });
      log(message, "grabber");
      return null;
    }

    // Wait for downup: until the cooldown ends, or on the normal backoff after an
    // error, but never past the point where novafile should take over
    const waitMs = result.status === 'cooldown'
      ? result.waitSeconds * 1000 + 60000
      : Math.max(submitBackoff(attempts), 10 * 60 * 1000);
    const nextAttemptAt = hasFallback ? Math.min(now + waitMs, deferUntil) : now + waitMs;
    await storage.updateExtractedItem(item.id, {
      submitAttempts: attempts,
      lastSubmitAttempt: now,
      lastSubmitError: result.message,
      nextAttemptAt,
    });
    const minutes = Math.round((nextAttemptAt - now) / 60000);
    const message = `Waiting for downup (${result.message}), retry in ~${minutes}m: ${item.articleTitle}`;
    await storage.addLog({ level: result.status === 'cooldown' ? "info" : "warn", message, source: "grabber" });
    log(message, "grabber");
    broadcast({ type: 'extracted' });
    return 'deferred';
  }

  /**
   * Resend extracted links that never reached JDownloader, with backoff.
   * Gives up on items older than SUBMIT_MAX_AGE.
   */
  async retryPendingSubmissions() {
    if (this.submitRetryRunning) return;
    this.submitRetryRunning = true;

    try {
      const pending = await storage.getPendingSubmissions();
      const now = Date.now();

      for (const item of pending) {
        if (this.submittingIds.has(item.id)) continue;

        if (now - item.timestamp > SUBMIT_MAX_AGE) {
          await storage.updateExtractedItem(item.id, { abandoned: true });
          const reason = item.lastSubmitError ? ` (last error: ${item.lastSubmitError})` : "";
          const message = `Gave up submitting to JDownloader, item older than ${SUBMIT_MAX_AGE / 86400000} days: ${item.articleTitle}${reason}`;
          await storage.addLog({ level: "warn", message, source: "jdownloader" });
          log(message, "jdownloader");
          broadcast({ type: 'extracted' });
          continue;
        }

        const attempts = item.submitAttempts ?? 0;
        if (item.nextAttemptAt) {
          if (now < item.nextAttemptAt) continue;
        } else if (attempts > 0 && now - (item.lastSubmitAttempt ?? 0) < submitBackoff(attempts)) {
          continue;
        }

        await storage.addLog({
          level: "info",
          message: `Retrying JDownloader submission (attempt ${attempts + 1}): ${item.articleTitle}`,
          source: "jdownloader",
        });
        await this.submitToJDownloader(item);
      }
    } catch (error: unknown) {
      log(`Submission retry job failed: ${describeError(error)}`, "jdownloader");
    } finally {
      this.submitRetryRunning = false;
    }
  }

  /**
   * Manually resend one extracted item now, including one that was given up on.
   */
  async retrySubmission(id: string): Promise<{ found: boolean; submitted: boolean; error?: string | null }> {
    const item = await storage.updateExtractedItem(id, { abandoned: false, nextAttemptAt: null });
    if (!item) return { found: false, submitted: false };
    if (item.submitted) return { found: true, submitted: true };

    const submitted = await this.submitToJDownloader(item);
    const updated = (await storage.getExtractedItems()).find(i => i.id === id);
    return { found: true, submitted, error: updated?.lastSubmitError ?? null };
  }
}

export const scraper = new Scraper();
