# Magscrape - RSS Feed Scraper & JDownloader Automation

## Overview

Magscrape is a web-based RSS feed scraping and automation dashboard designed to monitor RSS feeds, extract download links, and integrate with JDownloader for automated downloading. The application provides a real-time monitoring interface with live logs, statistics tracking, and configuration management for feed sources and JDownloader integration.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Technology Stack

**Frontend:**
- React 18 with TypeScript for type-safe component development
- Vite as the build tool and development server
- Tailwind CSS v4 with custom design system (dark technical theme)
- shadcn/ui component library (New York variant) with Radix UI primitives
- TanStack Query (React Query) for server state management
- Wouter for lightweight client-side routing
- Custom fonts: Inter (sans), JetBrains Mono (mono), Space Grotesk (display)

**Backend:**
- Express.js REST API server
- Node.js runtime with ES modules
- File-based JSON storage system (feeds.json, logs.json, stats.json, settings.json)
- Background scraper daemon with scheduled interval-based execution

**Build & Deployment:**
- esbuild for server bundling with selective dependency bundling
- Vite for client builds
- Custom build script that bundles both client and server
- Replit-specific plugins for development (cartographer, dev-banner, runtime error overlay)

### Data Architecture

**Storage Strategy:**
The application uses a file-based storage system implemented in `server/storage.ts` with JSON files stored in a configurable data directory (default: `./data`). This approach was chosen for simplicity and portability, avoiding database setup complexity.

**Data Models:**
- **Feeds:** RSS feed sources with URL, name, check interval, status tracking, and total items found
- **Logs:** System events with timestamp, severity level, message, and source (daemon/scraper/jdownloader)
- **Stats:** Aggregate metrics (totalScraped, linksFound, submitted)
- **Settings:** JDownloader connection configuration and global check intervals

**Schemas:**
Zod schemas in `shared/schema.ts` provide runtime validation and TypeScript type inference for all data models, ensuring type safety across client and server boundaries.

### Backend Architecture

**API Layer:**
RESTful API endpoints registered in `server/routes.ts`:
- `GET/POST /api/feeds` - Feed CRUD operations
- `DELETE /api/feeds/:id` - Feed removal
- `POST /api/feeds/:id/scrape` - Manual scrape triggering
- `GET /api/logs` - Log retrieval with optional limit
- `GET /api/stats` - Statistics retrieval
- `GET/PUT /api/settings` - Configuration management

**Scraper Daemon:**
Background service (`server/scraper.ts`) that:
- Maintains scheduled intervals for each feed using Node.js timers
- Parses RSS feeds using the `rss-parser` library
- Extracts HTML content with Cheerio for link extraction
- Updates feed status and statistics in real-time
- Logs all operations for monitoring

**Request Logging:**
Custom middleware in `server/index.ts` logs all API requests with timing information, providing observability for debugging and monitoring.

### Frontend Architecture

**Routing Structure:**
- `/` - Dashboard (feed management, statistics cards)
- `/logs` - Real-time log viewer with auto-scroll
- `/settings` - JDownloader configuration

**State Management:**
- React Query handles all server state with automatic refetching (5s intervals for feeds/stats, 2s for logs)
- Local component state for forms and UI interactions
- No global client state - all data fetched from API

**Component Organization:**
- `components/layout.tsx` - Main application shell with sidebar navigation
- `components/ui/*` - shadcn/ui component library (50+ components)
- `pages/*` - Route-level page components
- Shared utilities in `lib/utils.ts` (cn helper for className merging)

**Design System:**
Custom dark technical theme with cyan accent color, implementing a professional dashboard aesthetic. CSS variables defined in `index.css` provide consistent theming across all components.

### Development vs Production

**Development Mode:**
- Vite dev server with HMR on port 5000
- Replit-specific development plugins enabled
- Source maps and debug logging
- Index.html cache busting with nanoid

**Production Mode:**
- Static client build served by Express
- Server bundled as single CJS file with selective dependency bundling (allowlist approach)
- No Vite middleware - fallback to index.html for SPA routing

### Build Process

Custom build script (`script/build.ts`):
1. Cleans `dist` directory
2. Builds client with Vite → `dist/public`
3. Bundles server with esbuild → `dist/index.cjs`
4. Allowlist approach bundles performance-critical dependencies while externalizing others

This approach optimizes cold start times by reducing file system operations while maintaining reasonable bundle sizes.

## External Dependencies

**Database:**
None - uses file-based JSON storage. The application includes Drizzle ORM configuration (`drizzle.config.ts`) for potential future PostgreSQL migration via Neon serverless driver, but this is not currently active.

**Third-Party Services:**
- **JDownloader:** Remote integration for automated downloading (configured via settings, not yet fully implemented based on codebase)
- **RSS Feeds:** External RSS feed sources specified by users

**Key NPM Packages:**
- `rss-parser` - RSS feed parsing
- `cheerio` - HTML parsing and DOM manipulation for link extraction
- `axios` - HTTP client for feed fetching
- `@neondatabase/serverless` - Prepared for future database migration
- `drizzle-orm` & `drizzle-kit` - ORM layer (configured but not actively used)
- Radix UI component primitives (~30 packages)
- `react-hook-form` with `@hookform/resolvers` for form validation
- `zod` for schema validation

**Development Tools:**
- `@replit/vite-plugin-*` - Replit-specific development enhancements
- `tsx` - TypeScript execution for build scripts and development server
- Custom `vite-plugin-meta-images.ts` for OpenGraph image URL updates in Replit deployments