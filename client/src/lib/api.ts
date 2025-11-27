import type { Feed, ScrapeLog, Stats, Settings } from "@shared/schema";

const API_BASE = "/api";

export const api = {
  // Feeds
  async getFeeds(): Promise<Feed[]> {
    const res = await fetch(`${API_BASE}/feeds`);
    if (!res.ok) throw new Error("Failed to fetch feeds");
    return res.json();
  },

  async createFeed(url: string, name: string): Promise<Feed> {
    const res = await fetch(`${API_BASE}/feeds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, name, interval: 15 }),
    });
    if (!res.ok) throw new Error("Failed to create feed");
    return res.json();
  },

  async deleteFeed(id: string): Promise<void> {
    const res = await fetch(`${API_BASE}/feeds/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error("Failed to delete feed");
  },

  async triggerScrape(id: string): Promise<void> {
    const res = await fetch(`${API_BASE}/feeds/${id}/scrape`, {
      method: "POST",
    });
    if (!res.ok) throw new Error("Failed to trigger scrape");
  },

  // Logs
  async getLogs(limit = 100): Promise<ScrapeLog[]> {
    const res = await fetch(`${API_BASE}/logs?limit=${limit}`);
    if (!res.ok) throw new Error("Failed to fetch logs");
    return res.json();
  },

  // Stats
  async getStats(): Promise<Stats> {
    const res = await fetch(`${API_BASE}/stats`);
    if (!res.ok) throw new Error("Failed to fetch stats");
    return res.json();
  },

  // Settings
  async getSettings(): Promise<Settings> {
    const res = await fetch(`${API_BASE}/settings`);
    if (!res.ok) throw new Error("Failed to fetch settings");
    return res.json();
  },

  async updateSettings(updates: Partial<Settings>): Promise<Settings> {
    const res = await fetch(`${API_BASE}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error("Failed to update settings");
    return res.json();
  },
};
