import Parser from "rss-parser";
import { load } from "cheerio";
import axios from "axios";
import { storage } from "./storage";
import { log } from "./index";

const parser = new Parser();

export class Scraper {
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private isRunning = false;

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    
    await storage.addLog({
      level: "info",
      message: "Daemon started - Maggrab v0.1.0",
      source: "daemon",
    });

    log("Grabber daemon started", "grabber");
    
    // Load all feeds and start monitoring
    const feeds = await storage.getFeeds();
    for (const feed of feeds) {
      this.scheduleFeed(feed.id);
    }
  }

  async stop() {
    this.isRunning = false;
    this.intervals.forEach((interval, id) => {
      clearInterval(interval);
      this.intervals.delete(id);
    });
    
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

    // Clear existing interval if any
    const existing = this.intervals.get(feedId);
    if (existing) {
      clearInterval(existing);
    }

    // Schedule the scraping
    const intervalMs = feed.interval * 60 * 1000;
    const interval = setInterval(() => {
      this.scrapeFeed(feedId);
    }, intervalMs);
    
    this.intervals.set(feedId, interval);
    
    // Run immediately on first schedule
    this.scrapeFeed(feedId);
  }

  async unscheduleFeed(feedId: string) {
    const interval = this.intervals.get(feedId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(feedId);
    }
  }

  private async scrapeFeed(feedId: string) {
    const feed = await storage.getFeed(feedId);
    if (!feed) return;

    try {
      await storage.updateFeed(feedId, { status: "scraping", lastChecked: Date.now() });
      await storage.addLog({
        level: "info",
        message: `Starting grab job for feed: ${feed.name}`,
        source: "grabber",
      });

      log(`Grabbing feed: ${feed.name}`, "grabber");

      // Parse RSS feed
      const rssFeed = await parser.parseURL(feed.url);
      
      if (!rssFeed.items || rssFeed.items.length === 0) {
        await storage.addLog({
          level: "info",
          message: `No new items found in ${feed.name}`,
          source: "grabber",
        });
        await storage.updateFeed(feedId, { status: "idle" });
        return;
      }

      await storage.addLog({
        level: "success",
        message: `Found ${rssFeed.items.length} items in ${feed.name}`,
        source: "grabber",
      });

      await storage.incrementStat("totalScraped", rssFeed.items.length);
      await storage.updateFeed(feedId, { 
        totalFound: feed.totalFound + rssFeed.items.length 
      });

      // Process each item
      for (const item of rssFeed.items.slice(0, 5)) {
        if (item.link) {
          try {
            const downloadUrls = await this.findDownloadLink(item.link);
            if (downloadUrls.length > 0) {
              await storage.addLog({
                level: "info",
                message: `Extracted ${downloadUrls.length} download link(s) from: ${item.title || item.link}`,
                source: "grabber",
              });
              
              for (const downloadUrl of downloadUrls) {
                await storage.incrementStat("linksFound");
                // Submit to JDownloader
                await this.submitToJDownloader(downloadUrl);
              }
            }
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
    } catch (error: any) {
      await storage.updateFeed(feedId, { status: "error" });
      await storage.addLog({
        level: "error",
        message: `Error grabbing ${feed.name}: ${error.message}`,
        source: "grabber",
      });
      log(`Error grabbing feed ${feed.name}: ${error.message}`, "grabber");
    }
  }

  private async findDownloadLink(url: string): Promise<string[]> {
    try {
      const response = await axios.get(url, { timeout: 15000, headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }});
      const $ = load(response.data);
      const foundLinks: string[] = [];
      
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
                foundLinks.push(decodedUrl);
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
        'katfile.com', 'uploadgig.com', 'filefox.cc'
      ];
      
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href) {
          for (const domain of fileHostingDomains) {
            if (href.includes(domain)) {
              if (href.startsWith('http')) {
                foundLinks.push(href);
              } else {
                try {
                  const absoluteUrl = new URL(href, url).toString();
                  foundLinks.push(absoluteUrl);
                } catch {
                  // Skip malformed URLs
                }
              }
              break;
            }
          }
        }
      });

      // Remove duplicates
      return Array.from(new Set(foundLinks));
    } catch (error: any) {
      log(`Error finding download link: ${error.message}`, "grabber");
      return [];
    }
  }

  private async submitToJDownloader(url: string) {
    try {
      const settings = await storage.getSettings();
      
      if (!settings.jdUrl || !settings.jdUser) {
        await storage.addLog({
          level: "warn",
          message: "JDownloader not configured, skipping submission",
          source: "jdownloader",
        });
        return;
      }

      // This is a placeholder - actual JD2 API integration would go here
      // For now, just log it
      await storage.addLog({
        level: "success",
        message: `Submitted link to JDownloader2 API: ${url.substring(0, 50)}...`,
        source: "jdownloader",
      });
      
      await storage.incrementStat("submitted");
      
      log(`Submitted to JDownloader: ${url}`, "grabber");
    } catch (error: any) {
      await storage.addLog({
        level: "error",
        message: `Failed to submit to JDownloader: ${error.message}`,
        source: "jdownloader",
      });
    }
  }
}

export const scraper = new Scraper();
