import { z } from "zod";

export const feedSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url(),
  interval: z.number().default(15),
  lastChecked: z.number().nullable(),
  status: z.enum(['idle', 'scraping', 'error']).default('idle'),
  totalFound: z.number().default(0),
});

export const insertFeedSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  interval: z.number().optional().default(15),
});
export type InsertFeed = z.infer<typeof insertFeedSchema>;
export type Feed = z.infer<typeof feedSchema>;

export const logSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  level: z.enum(['info', 'success', 'warn', 'error']),
  message: z.string(),
  source: z.enum(['daemon', 'grabber', 'jdownloader']),
});

export const insertLogSchema = logSchema.omit({ id: true, timestamp: true });
export type InsertLog = z.infer<typeof insertLogSchema>;
export type ScrapeLog = z.infer<typeof logSchema>;

export const statsSchema = z.object({
  totalScraped: z.number().default(0),
  linksFound: z.number().default(0),
  submitted: z.number().default(0),
});

export type Stats = z.infer<typeof statsSchema>;

export const settingsSchema = z.object({
  jdUrl: z.string().default("http://localhost:3128"),
  jdUser: z.string().default(""),
  jdDevice: z.string().default(""),
  checkInterval: z.number().default(15),
});

export type Settings = z.infer<typeof settingsSchema>;

export const extractedItemSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  articleTitle: z.string(),
  articleUrl: z.string(),
  downloadUrl: z.string(),
  host: z.string(),
  timestamp: z.number(),
  submitted: z.boolean().default(false),
});

export const insertExtractedItemSchema = extractedItemSchema.omit({ id: true, timestamp: true });
export type InsertExtractedItem = z.infer<typeof insertExtractedItemSchema>;
export type ExtractedItem = z.infer<typeof extractedItemSchema>;

export const grabbedItemSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  feedName: z.string(),
  title: z.string(),
  link: z.string(),
  pubDate: z.string().nullable(),
  hasDownload: z.boolean().default(false),
  timestamp: z.number(),
});

export const insertGrabbedItemSchema = grabbedItemSchema.omit({ id: true, timestamp: true });
export type InsertGrabbedItem = z.infer<typeof insertGrabbedItemSchema>;
export type GrabbedItem = z.infer<typeof grabbedItemSchema>;
