import { useStore } from "@/lib/store";
import { Activity, Database, Link as LinkIcon, HardDrive, CheckCircle2, AlertCircle, Clock, ArrowUpRight, Plus } from "lucide-react";
import { useState } from "react";
import { motion } from "framer-motion";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

export default function Dashboard() {
  const { feeds, stats, addFeed } = useStore();
  const { toast } = useToast();
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [newFeedName, setNewFeedName] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const handleAddFeed = () => {
    if (!newFeedUrl) return;
    
    // Auto-generate name if not provided
    const finalName = newFeedName.trim() || `Feed (${new URL(newFeedUrl).hostname})`;
    
    addFeed(newFeedUrl, finalName);
    setIsOpen(false);
    setNewFeedUrl("");
    setNewFeedName("");
    toast({
      title: "Feed Added",
      description: `Successfully added ${finalName} to the scraper queue.`,
    });
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <header className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-display font-bold text-white mb-2">Dashboard</h2>
          <p className="text-muted-foreground">Overview of scraping operations and queue status.</p>
        </div>
        
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-none border border-primary/50 font-medium px-6">
              <Plus className="mr-2 h-4 w-4" />
              Add New Feed
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-border rounded-none">
            <DialogHeader>
              <DialogTitle className="font-display text-xl">Add RSS Feed</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="url">RSS URL</Label>
                <Input 
                  id="url" 
                  placeholder="https://..." 
                  value={newFeedUrl}
                  onChange={(e) => setNewFeedUrl(e.target.value)}
                  className="rounded-none bg-secondary/50 border-input focus:ring-primary"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">Feed Name <span className="text-muted-foreground font-normal text-xs ml-1">(Optional - Auto-detected if empty)</span></Label>
                <Input 
                  id="name" 
                  placeholder="e.g. Tech News Daily" 
                  value={newFeedName}
                  onChange={(e) => setNewFeedName(e.target.value)}
                  className="rounded-none bg-secondary/50 border-input focus:ring-primary"
                />
              </div>
              <Button onClick={handleAddFeed} className="w-full bg-primary text-primary-foreground hover:bg-primary/90 rounded-none mt-4">
                Add Feed
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </header>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard 
          label="Total Feeds" 
          value={feeds.length.toString()} 
          icon={Database} 
          trend="+2 this week" 
        />
        <StatCard 
          label="Items Scraped" 
          value={stats.totalScraped.toLocaleString()} 
          icon={Activity} 
          color="text-blue-400"
        />
        <StatCard 
          label="Links Extracted" 
          value={stats.linksFound.toLocaleString()} 
          icon={LinkIcon} 
          color="text-purple-400"
        />
        <StatCard 
          label="Sent to JD2" 
          value={stats.submitted.toLocaleString()} 
          icon={HardDrive} 
          color="text-emerald-400"
        />
      </div>

      {/* System Status for Single Container Context */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card/30 border border-border p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
             <div className="h-8 w-8 bg-secondary border border-border flex items-center justify-center">
               <Database className="h-4 w-4 text-muted-foreground" />
             </div>
             <div>
               <div className="text-xs font-mono text-muted-foreground uppercase">Storage Mode</div>
               <div className="text-sm font-bold text-white">Local SQLite</div>
             </div>
          </div>
          <div className="text-[10px] bg-emerald-500/10 text-emerald-500 px-2 py-1 border border-emerald-500/20">
            CONTAINER OK
          </div>
        </div>
        
        <div className="bg-card/30 border border-border p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
             <div className="h-8 w-8 bg-secondary border border-border flex items-center justify-center">
               <HardDrive className="h-4 w-4 text-muted-foreground" />
             </div>
             <div>
               <div className="text-xs font-mono text-muted-foreground uppercase">Disk Usage</div>
               <div className="text-sm font-bold text-white">12.4 MB / 512 MB</div>
             </div>
          </div>
          <div className="h-1 w-16 bg-secondary overflow-hidden">
            <div className="h-full bg-primary w-[5%]"></div>
          </div>
        </div>

        <div className="bg-card/30 border border-border p-4 flex items-center justify-between">
           <div className="flex items-center gap-3">
             <div className="h-8 w-8 bg-secondary border border-border flex items-center justify-center">
               <Activity className="h-4 w-4 text-muted-foreground" />
             </div>
             <div>
               <div className="text-xs font-mono text-muted-foreground uppercase">Memory</div>
               <div className="text-sm font-bold text-white">45 MB (Node.js)</div>
             </div>
          </div>
           <div className="h-1 w-16 bg-secondary overflow-hidden">
            <div className="h-full bg-blue-500 w-[15%]"></div>
          </div>
        </div>
      </div>

      {/* Active Feeds Table */}
      <div className="border border-border bg-card/30 backdrop-blur-sm">
        <div className="p-4 border-b border-border flex justify-between items-center">
          <h3 className="font-display font-semibold text-lg">Monitored Feeds</h3>
          <div className="text-xs font-mono text-muted-foreground">AUTO-REFRESH: ON</div>
        </div>
        <div className="divide-y divide-border">
          <div className="grid grid-cols-12 px-4 py-3 text-xs font-mono text-muted-foreground uppercase tracking-wider bg-muted/20">
            <div className="col-span-4">Feed Name</div>
            <div className="col-span-4">URL</div>
            <div className="col-span-2">Last Check</div>
            <div className="col-span-1 text-right">Items</div>
            <div className="col-span-1 text-right">Status</div>
          </div>
          
          {feeds.map((feed) => (
            <div key={feed.id} className="grid grid-cols-12 px-4 py-4 text-sm items-center hover:bg-white/5 transition-colors">
              <div className="col-span-4 font-medium text-white flex items-center gap-2">
                <div className="h-2 w-2 bg-primary/50 rotate-45" />
                {feed.name}
              </div>
              <div className="col-span-4 font-mono text-xs text-muted-foreground truncate pr-4">
                {feed.url}
              </div>
              <div className="col-span-2 text-muted-foreground flex items-center gap-2">
                <Clock className="h-3 w-3" />
                {feed.lastChecked ? new Date(feed.lastChecked).toLocaleTimeString() : 'Never'}
              </div>
              <div className="col-span-1 text-right font-mono">
                {feed.totalFound}
              </div>
              <div className="col-span-1 flex justify-end">
                <StatusBadge status={feed.status} />
              </div>
            </div>
          ))}
          
          {feeds.length === 0 && (
            <div className="p-8 text-center text-muted-foreground">
              No feeds configured. Add one to start scraping.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, trend, color = "text-primary" }: any) {
  return (
    <div className="bg-card/50 border border-border p-6 relative overflow-hidden group">
      <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
        <Icon className="h-16 w-16" />
      </div>
      <div className="relative z-10">
        <div className="flex items-center gap-2 mb-2">
          <Icon className={`h-4 w-4 ${color}`} />
          <span className="text-xs font-mono uppercase text-muted-foreground tracking-wider">{label}</span>
        </div>
        <div className="text-3xl font-bold font-display text-white tracking-tight">{value}</div>
        {trend && (
          <div className="mt-2 text-xs text-emerald-500 flex items-center gap-1">
            <ArrowUpRight className="h-3 w-3" />
            {trend}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'scraping') {
    return (
      <span className="inline-flex items-center px-2 py-1 rounded-none bg-blue-500/10 text-blue-400 text-[10px] font-mono border border-blue-500/20 uppercase">
        <Activity className="h-3 w-3 mr-1 animate-spin" />
        Scraping
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center px-2 py-1 rounded-none bg-red-500/10 text-red-400 text-[10px] font-mono border border-red-500/20 uppercase">
        <AlertCircle className="h-3 w-3 mr-1" />
        Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-1 rounded-none bg-emerald-500/10 text-emerald-400 text-[10px] font-mono border border-emerald-500/20 uppercase">
      <CheckCircle2 className="h-3 w-3 mr-1" />
      Idle
    </span>
  );
}
