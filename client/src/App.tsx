import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import Settings from "@/pages/settings";
import Logs from "@/pages/logs";
import { useEffect } from "react";
import { useStore } from "@/lib/store";

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/logs" component={Logs} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function DaemonSimulator() {
  const { addLog, setFeedStatus, feeds, incrementStats } = useStore();

  useEffect(() => {
    // Simulate daemon activity
    const interval = setInterval(() => {
      const randomAction = Math.random();
      
      if (randomAction > 0.7) {
        // Simulate checking a feed
        const feed = feeds[Math.floor(Math.random() * feeds.length)];
        if (!feed) return;

        addLog(`Starting scrape job for feed: ${feed.name}`, 'info', 'scraper');
        setFeedStatus(feed.id, 'scraping');

        setTimeout(() => {
          const found = Math.floor(Math.random() * 3);
          if (found > 0) {
            addLog(`Found ${found} new items in ${feed.name}`, 'success', 'scraper');
            incrementStats('totalScraped');
            
            // Simulate finding links
            setTimeout(() => {
              addLog(`Extracted download link from item #${Math.floor(Math.random()*1000)}`, 'info', 'scraper');
              incrementStats('linksFound');
              
              // Simulate sending to JD
              setTimeout(() => {
                addLog(`Submitted link to JDownloader2 API`, 'success', 'jdownloader');
                incrementStats('submitted');
              }, 1000);
            }, 1000);
          } else {
            addLog(`No new items found in ${feed.name}`, 'info', 'scraper');
          }
          setFeedStatus(feed.id, 'idle');
        }, 3000);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [feeds, addLog, setFeedStatus, incrementStats]);

  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <DaemonSimulator />
      <Router />
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
