import Parser from "rss-parser";
import { load } from "cheerio";
import axios from "axios";
import { storage } from "./storage";
import { log } from "./index";

// @ts-ignore - jdownloader-api doesn't have type definitions
import jdownloaderAPI from "jdownloader-api";

const parser = new Parser();

// Track JDownloader connection state
let jdConnected = false;
let jdDeviceId: string | null = null;

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

      // Filter out already processed items
      const newItems = [];
      for (const item of rssFeed.items) {
        if (item.link && !(await storage.isProcessed(item.link))) {
          newItems.push(item);
        }
      }

      if (newItems.length === 0) {
        await storage.addLog({
          level: "info",
          message: `No new items in ${feed.name} (${rssFeed.items.length} already processed)`,
          source: "grabber",
        });
        await storage.updateFeed(feedId, { status: "idle" });
        return;
      }

      await storage.addLog({
        level: "success",
        message: `Found ${newItems.length} new items in ${feed.name} (${rssFeed.items.length - newItems.length} already processed)`,
        source: "grabber",
      });

      await storage.incrementStat("totalScraped", newItems.length);
      await storage.updateFeed(feedId, { 
        totalFound: feed.totalFound + newItems.length 
      });

      // Process each new item
      for (const item of newItems.slice(0, 10)) {
        if (item.link) {
          try {
            const articleTitle = item.title || item.link;
            const downloadLinks = await this.findDownloadLinks(item.link);
            const hasDownload = downloadLinks.length > 0;
            
            // Store every grabbed item from the RSS feed
            await storage.addGrabbedItem({
              feedId,
              feedName: feed.name,
              title: articleTitle,
              link: item.link,
              pubDate: item.pubDate || null,
              hasDownload,
            });
            
            if (hasDownload) {
              // Prioritize novafile links, then nfile
              const preferredLink = downloadLinks.find(l => l.host.includes('novafile'))
                || downloadLinks.find(l => l.host.includes('nfile'))
                || downloadLinks[0];
              
              await storage.addLog({
                level: "info",
                message: `Extracted ${downloadLinks.length} link(s) from: ${articleTitle} - using ${preferredLink.host}`,
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
              });
              
              await storage.incrementStat("linksFound");
              
              // Only submit the preferred link to JDownloader
              await this.submitToJDownloader(preferredLink.url, articleTitle, extractedItem.id);
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
      const response = await axios.get(url, { timeout: 15000, headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }});
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
        'katfile.com', 'uploadgig.com', 'filefox.cc'
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
      log(`Error finding download link: ${error.message}`, "grabber");
      return [];
    }
  }

  private async disconnectJD(): Promise<void> {
    try {
      if (jdConnected) {
        await jdownloaderAPI.disconnect();
      }
    } catch {
      // Ignore disconnect errors
    } finally {
      jdConnected = false;
      jdDeviceId = null;
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

    // Already connected
    if (jdConnected && jdDeviceId) {
      return true;
    }

    try {
      // Connect to MyJDownloader
      await jdownloaderAPI.connect(credentials.email, credentials.password);
      jdConnected = true;

      await storage.addLog({
        level: "success",
        message: "Connected to MyJDownloader",
        source: "jdownloader",
      });
      log("Connected to MyJDownloader", "jdownloader");

      // Get available devices
      let devices;
      try {
        devices = await jdownloaderAPI.listDevices();
      } catch (deviceError: any) {
        await storage.addLog({
          level: "error",
          message: `Failed to list devices: ${deviceError.message}`,
          source: "jdownloader",
        });
        await this.disconnectJD();
        return false;
      }
      
      if (!devices || devices.length === 0) {
        await storage.addLog({
          level: "error",
          message: "No JDownloader devices found. Make sure JDownloader is running.",
          source: "jdownloader",
        });
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
        } else {
          await storage.addLog({
            level: "warn",
            message: `Device "${credentials.device}" not found, using first available: ${devices[0].name}`,
            source: "jdownloader",
          });
          jdDeviceId = devices[0].id;
        }
      } else {
        jdDeviceId = devices[0].id;
        await storage.addLog({
          level: "info",
          message: `Using JDownloader device: ${devices[0].name}`,
          source: "jdownloader",
        });
      }

      return true;
    } catch (error: any) {
      await this.disconnectJD();
      await storage.addLog({
        level: "error",
        message: `Failed to connect to MyJDownloader: ${error.message}`,
        source: "jdownloader",
      });
      log(`MyJDownloader connection failed: ${error.message}`, "jdownloader");
      return false;
    }
  }

  private async submitToJDownloader(url: string, articleTitle: string, extractedItemId?: string) {
    try {
      const credentials = this.getJDCredentials();
      
      if (!credentials) {
        await storage.addLog({
          level: "warn",
          message: "MyJDownloader not configured (add MYJD_EMAIL and MYJD_PASSWORD secrets)",
          source: "jdownloader",
        });
        return;
      }

      // Ensure we're connected
      const connected = await this.ensureJDConnection();
      if (!connected || !jdDeviceId) {
        await storage.addLog({
          level: "error",
          message: "Cannot submit - not connected to MyJDownloader",
          source: "jdownloader",
        });
        return;
      }

      // Add link to JDownloader with autostart enabled
      await jdownloaderAPI.addLinks(url, jdDeviceId, true);

      await storage.addLog({
        level: "success",
        message: `Submitted to JDownloader: ${articleTitle}`,
        source: "jdownloader",
      });
      
      await storage.incrementStat("submitted");
      
      // Mark the extracted item as submitted
      if (extractedItemId) {
        await storage.markExtractedItemSubmitted(extractedItemId);
      }
      
      log(`Submitted to JDownloader: ${url}`, "grabber");
    } catch (error: any) {
      // Reset connection state on error to force reconnect
      await this.disconnectJD();
      
      await storage.addLog({
        level: "error",
        message: `Failed to submit to JDownloader: ${error.message}`,
        source: "jdownloader",
      });
    }
  }
}

export const scraper = new Scraper();
