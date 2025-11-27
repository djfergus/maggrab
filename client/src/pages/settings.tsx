import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Save, ShieldAlert, Server, HardDrive, Trash2, RotateCcw } from "lucide-react";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

const defaultSettings = {
  jdEmail: "",
  jdPassword: "",
  jdDevice: "",
  checkInterval: 15,
};

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });

  const [formData, setFormData] = useState(defaultSettings);
  
  // Sync formData with settings when loaded
  useEffect(() => {
    if (settings) {
      setFormData({
        jdEmail: settings.jdEmail ?? "",
        jdPassword: settings.jdPassword ?? "",
        jdDevice: settings.jdDevice ?? "",
        checkInterval: settings.checkInterval ?? 15,
      });
    }
  }, [settings]);

  const updateSettingsMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast({
        title: "Configuration Saved",
        description: "Daemon will reload with new settings automatically.",
      });
    },
  });

  const clearEntriesMutation = useMutation({
    mutationFn: api.clearEntries,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["logs"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      queryClient.invalidateQueries({ queryKey: ["extracted"] });
      queryClient.invalidateQueries({ queryKey: ["grabbed"] });
      toast({
        title: "Entries Cleared",
        description: "Logs, stats, and processed URLs have been reset.",
      });
    },
  });

  const resetAppMutation = useMutation({
    mutationFn: api.resetApp,
    onSuccess: () => {
      queryClient.invalidateQueries();
      toast({
        title: "App Reset",
        description: "All data has been wiped. Refreshing page...",
      });
      setTimeout(() => window.location.reload(), 1000);
    },
  });

  const handleSave = () => {
    updateSettingsMutation.mutate(formData);
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
      <div className="mb-8">
        <h2 className="text-3xl font-display font-bold text-white mb-2">Configuration</h2>
        <p className="text-muted-foreground">Manage global settings and API connections.</p>
      </div>

      <Card className="bg-card/50 border-border rounded-none">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            <CardTitle className="font-display">MyJDownloader</CardTitle>
          </div>
          <CardDescription>
            Connect to your JDownloader via the MyJDownloader cloud service.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-2">
            <Label htmlFor="jdEmail">MyJDownloader Email</Label>
            <Input 
              id="jdEmail" 
              type="email"
              placeholder="your-email@example.com"
              value={formData.jdEmail}
              onChange={(e) => setFormData({ ...formData, jdEmail: e.target.value })}
              className="bg-background/50 rounded-none border-input"
              data-testid="input-jd-email"
            />
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="jdPassword">MyJDownloader Password</Label>
              <Input 
                id="jdPassword" 
                type="password"
                placeholder="••••••••"
                value={formData.jdPassword}
                onChange={(e) => setFormData({ ...formData, jdPassword: e.target.value })}
                className="bg-background/50 rounded-none border-input"
                data-testid="input-jd-password"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="jdDevice">Device Name</Label>
              <Input 
                id="jdDevice" 
                placeholder="My JDownloader"
                value={formData.jdDevice}
                onChange={(e) => setFormData({ ...formData, jdDevice: e.target.value })}
                className="bg-background/50 rounded-none border-input"
                data-testid="input-jd-device"
              />
              <p className="text-[10px] text-muted-foreground">
                Leave empty to use the first available device.
              </p>
            </div>
          </div>

          <div className="bg-yellow-500/10 border border-yellow-500/20 p-4 flex gap-3 items-start">
            <ShieldAlert className="h-5 w-5 text-yellow-500 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h4 className="text-sm font-bold text-yellow-500">Security Notice</h4>
              <p className="text-xs text-yellow-500/80">
                Your MyJDownloader credentials are stored locally in the data directory.
                Make sure to secure access to your server instance.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/50 border-border rounded-none">
        <CardHeader>
          <div className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 text-primary" />
            <CardTitle className="font-display">Storage Configuration</CardTitle>
          </div>
          <CardDescription>
            Local storage settings for the single-container deployment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-2">
            <Label htmlFor="dbPath">Database Path</Label>
            <Input 
              id="dbPath" 
              value="/data/maggrab.db"
              disabled
              className="bg-secondary/30 rounded-none border-input font-mono text-muted-foreground cursor-not-allowed"
            />
            <p className="text-[10px] text-muted-foreground">
              Using lightweight JSON file storage. No external database container required.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/50 border-border rounded-none">
        <CardHeader>
          <CardTitle className="font-display">Grabber Settings</CardTitle>
          <CardDescription>
            Control how often feeds are checked for new content.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-2">
            <Label htmlFor="interval">Global Check Interval (minutes)</Label>
            <div className="flex items-center gap-4">
              <Input 
                id="interval" 
                type="number" 
                min="1"
                value={formData.checkInterval}
                onChange={(e) => setFormData({ ...formData, checkInterval: parseInt(e.target.value) || 15 })}
                className="bg-background/50 rounded-none border-input w-32 font-mono"
                data-testid="input-check-interval"
              />
              <span className="text-sm text-muted-foreground">
                Recommended: 15-60 minutes to avoid rate limiting.
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button 
          onClick={handleSave} 
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-none px-8"
          disabled={updateSettingsMutation.isPending}
          data-testid="button-save-settings"
        >
          <Save className="mr-2 h-4 w-4" />
          {updateSettingsMutation.isPending ? "Saving..." : "Save Configuration"}
        </Button>
      </div>

      <Card className="bg-red-500/5 border-red-500/30 rounded-none">
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-red-500" />
            <CardTitle className="font-display text-red-500">Danger Zone</CardTitle>
          </div>
          <CardDescription>
            These actions cannot be undone. Please be certain.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-4 border border-red-500/20 bg-red-500/5">
            <div>
              <h4 className="font-semibold text-foreground">Clear Entries</h4>
              <p className="text-sm text-muted-foreground">
                Clears all logs, stats, and processed URLs. Your RSS feeds and settings will be preserved.
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button 
                  variant="outline" 
                  className="border-red-500/50 text-red-500 hover:bg-red-500/10 rounded-none"
                  disabled={clearEntriesMutation.isPending}
                  data-testid="button-clear-entries"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {clearEntriesMutation.isPending ? "Clearing..." : "Clear Entries"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="rounded-none border-border bg-card">
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear All Entries?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will delete all logs, reset statistics, and clear the list of processed URLs. 
                    Your RSS feeds and settings will be kept.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="rounded-none">Cancel</AlertDialogCancel>
                  <AlertDialogAction 
                    className="bg-red-500 hover:bg-red-600 rounded-none"
                    onClick={() => clearEntriesMutation.mutate()}
                  >
                    Clear Entries
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <div className="flex items-center justify-between p-4 border border-red-500/20 bg-red-500/5">
            <div>
              <h4 className="font-semibold text-foreground">Reset App</h4>
              <p className="text-sm text-muted-foreground">
                Wipes all data including feeds, logs, stats, settings, and processed URLs. Fresh start.
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button 
                  variant="destructive" 
                  className="rounded-none"
                  disabled={resetAppMutation.isPending}
                  data-testid="button-reset-app"
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {resetAppMutation.isPending ? "Resetting..." : "Reset App"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="rounded-none border-border bg-card">
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset Entire App?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete ALL data: feeds, logs, statistics, settings, and processed URLs. 
                    The app will be restored to its initial state. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="rounded-none">Cancel</AlertDialogCancel>
                  <AlertDialogAction 
                    className="bg-red-500 hover:bg-red-600 rounded-none"
                    onClick={() => resetAppMutation.mutate()}
                  >
                    Reset Everything
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
