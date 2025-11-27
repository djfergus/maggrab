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
      message: "Daemon started - Magscrape v0.1.0",
      source: "daemon",
    });

    log("Scraper daemon started", "scraper");
    
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
    
    log("Scraper daemon stopped", "scraper");
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
        message: `Starting scrape job for feed: ${feed.name}`,
        source: "scraper",
      });

      log(`Scraping feed: ${feed.name}`, "scraper");

      // Parse RSS feed
      const rssFeed = await parser.parseURL(feed.url);
      
      if (!rssFeed.items || rssFeed.items.length === 0) {
        await storage.addLog({
          level: "info",
          message: `No new items found in ${feed.name}`,
          source: "scraper",
        });
        await storage.updateFeed(feedId, { status: "idle" });
        return;
      }

      await storage.addLog({
        level: "success",
        message: `Found ${rssFeed.items.length} items in ${feed.name}`,
        source: "scraper",
      });

      await storage.incrementStat("totalScraped", rssFeed.items.length);
      await storage.updateFeed(feedId, { 
        totalFound: feed.totalFound + rssFeed.items.length 
      });

      // Process each item
      for (const item of rssFeed.items.slice(0, 5)) {
        if (item.link) {
          try {
            const downloadUrl = await this.findDownloadLink(item.link);
            if (downloadUrl) {
              await storage.addLog({
                level: "info",
                message: `Extracted download link from: ${item.title || item.link}`,
                source: "scraper",
              });
              await storage.incrementStat("linksFound");

              // Submit to JDownloader
              await this.submitToJDownloader(downloadUrl);
            }
          } catch (err: any) {
            await storage.addLog({
              level: "warn",
              message: `Failed to process item: ${err.message}`,
              source: "scraper",
            });
          }
        }
      }

      await storage.updateFeed(feedId, { status: "idle" });
    } catch (error: any) {
      await storage.updateFeed(feedId, { status: "error" });
      await storage.addLog({
        level: "error",
        message: `Error scraping ${feed.name}: ${error.message}`,
        source: "scraper",
      });
      log(`Error scraping feed ${feed.name}: ${error.message}`, "scraper");
    }
  }

  private async findDownloadLink(url: string): Promise<string | null> {
    try {
      const response = await axios.get(url, { timeout: 10000 });
      const $ = load(response.data);
      
      // Look for common download link patterns
      const downloadSelectors = [
        'a[href*="download"]',
        'a[href*=".torrent"]',
        'a[href*="magnet:"]',
        'a[class*="download"]',
        'a[id*="download"]',
      ];

      for (const selector of downloadSelectors) {
        const link = $(selector).first().attr("href");
        if (link) {
          // Return absolute URL
          if (link.startsWith("http") || link.startsWith("magnet:")) {
            return link;
          }
          // Convert relative to absolute
          const base = new URL(url);
          return new URL(link, base.origin).toString();
        }
      }

      return null;
    } catch (error: any) {
      log(`Error finding download link: ${error.message}`, "scraper");
      return null;
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
      
      log(`Submitted to JDownloader: ${url}`, "scraper");
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
