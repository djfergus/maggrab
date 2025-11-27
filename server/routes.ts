import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { scraper, getJDConnectionStatus } from "./scraper";
import { insertFeedSchema, insertLogSchema, settingsSchema } from "@shared/schema";
import { log } from "./index";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Start the scraper daemon
  await scraper.start();

  // Feeds
  app.get("/api/feeds", async (_req, res) => {
    const feeds = await storage.getFeeds();
    res.json(feeds);
  });

  app.post("/api/feeds", async (req, res) => {
    try {
      const data = insertFeedSchema.parse(req.body);
      const feed = await storage.createFeed(data);
      
      // Schedule the new feed
      await scraper.scheduleFeed(feed.id);
      
      await storage.addLog({
        level: "info",
        message: `New feed added: ${feed.name}`,
        source: "daemon",
      });
      
      res.json(feed);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/feeds/:id", async (req, res) => {
    const { id } = req.params;
    const success = await storage.deleteFeed(id);
    
    if (success) {
      await scraper.unscheduleFeed(id);
      await storage.addLog({
        level: "info",
        message: `Feed removed: ${id}`,
        source: "daemon",
      });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Feed not found" });
    }
  });

  // Logs
  app.get("/api/logs", async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    const logs = await storage.getLogs(limit);
    res.json(logs);
  });

  // Stats
  app.get("/api/stats", async (_req, res) => {
    const stats = await storage.getStats();
    res.json(stats);
  });

  // Extracted items
  app.get("/api/extracted", async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    const items = await storage.getExtractedItems(limit);
    res.json(items);
  });

  // Grabbed items (all RSS items processed)
  app.get("/api/grabbed", async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    const items = await storage.getGrabbedItems(limit);
    res.json(items);
  });

  // Settings
  app.get("/api/settings", async (_req, res) => {
    const settings = await storage.getSettings();
    res.json(settings);
  });

  // JDownloader status (reads from environment secrets and connection state)
  app.get("/api/jd-status", async (_req, res) => {
    const status = getJDConnectionStatus();
    res.json(status);
  });

  app.put("/api/settings", async (req, res) => {
    try {
      const updates = settingsSchema.partial().parse(req.body);
      const settings = await storage.updateSettings(updates);
      
      await storage.addLog({
        level: "info",
        message: "Settings updated",
        source: "daemon",
      });
      
      res.json(settings);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Trigger manual scrape
  app.post("/api/feeds/:id/scrape", async (req, res) => {
    const { id } = req.params;
    const feed = await storage.getFeed(id);
    
    if (!feed) {
      return res.status(404).json({ error: "Feed not found" });
    }

    // Trigger immediate scrape
    scraper.scheduleFeed(id);
    
    res.json({ message: "Scrape triggered" });
  });

  // Clear entries (logs, stats, processed URLs) but keep feeds and settings
  app.post("/api/clear-entries", async (_req, res) => {
    await storage.clearEntries();
    await storage.addLog({
      level: "info",
      message: "Entries cleared - logs, stats, and processed URLs reset",
      source: "daemon",
    });
    log("Entries cleared by user", "daemon");
    res.json({ success: true });
  });

  // Reset everything (full app reset)
  app.post("/api/reset", async (_req, res) => {
    await scraper.stop();
    await storage.resetAll();
    await scraper.start();
    log("App reset - all data wiped", "daemon");
    res.json({ success: true });
  });

  return httpServer;
}
