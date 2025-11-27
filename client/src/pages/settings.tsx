import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Save, Server, Trash2, RotateCcw, CheckCircle2, XCircle, ChevronDown, Info } from "lucide-react";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

const defaultSettings = {
  checkInterval: 15,
};

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showSecurityInfo, setShowSecurityInfo] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });

  const { data: jdStatus } = useQuery({
    queryKey: ["jdStatus"],
    queryFn: api.getJDStatus,
    refetchInterval: 10000,
  });

  const [formData, setFormData] = useState(defaultSettings);
  
  useEffect(() => {
    if (settings) {
      setFormData({
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
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <div className="mb-4">
        <h2 className="text-2xl font-display font-bold text-white">Configuration</h2>
      </div>

      <Card className="bg-card/50 border-border rounded-none">
        <CardHeader className="py-3 px-4">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" />
            <CardTitle className="font-display text-base">MyJDownloader</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4 pt-0 space-y-3">
          <div className="flex items-center gap-3 p-3 border border-border bg-background/30">
            {jdStatus?.configured ? (
              jdStatus.connected ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium text-green-500 text-sm">Connected</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {jdStatus.email}
                      {jdStatus.deviceName && <> • <span className="text-primary font-mono">{jdStatus.deviceName}</span></>}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 text-cyan-500 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium text-cyan-500 text-sm">Configured</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {jdStatus.email} • Will connect on next grab
                    </p>
                  </div>
                </>
              )
            ) : (
              <>
                <XCircle className="h-4 w-4 text-yellow-500 shrink-0" />
                <div>
                  <p className="font-medium text-yellow-500 text-sm">Not Configured</p>
                  <p className="text-xs text-muted-foreground">
                    Add credentials in Replit Secrets
                  </p>
                </div>
              </>
            )}
          </div>

          <Collapsible open={showSecurityInfo} onOpenChange={setShowSecurityInfo}>
            <CollapsibleTrigger className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors w-full">
              <Info className="h-3 w-3" />
              <span>Credential setup & security info</span>
              <ChevronDown className={`h-3 w-3 ml-auto transition-transform ${showSecurityInfo ? 'rotate-180' : ''}`} />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-2">
              <div className="bg-primary/10 border border-primary/20 p-3 text-xs">
                <p className="text-muted-foreground mb-2">Add these secrets in the Secrets tab:</p>
                <ul className="text-muted-foreground space-y-0.5 font-mono text-[10px]">
                  <li><span className="text-primary">MYJD_EMAIL</span> - MyJDownloader email</li>
                  <li><span className="text-primary">MYJD_PASSWORD</span> - MyJDownloader password</li>
                  <li><span className="text-primary">MYJD_DEVICE</span> - (Optional) Device name</li>
                </ul>
              </div>
              <div className="bg-green-500/10 border border-green-500/20 p-3 text-xs text-green-500/80">
                Credentials are encrypted via Replit Secrets and safe in public projects.
              </div>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      <Card className="bg-card/50 border-border rounded-none">
        <CardHeader className="py-3 px-4">
          <CardTitle className="font-display text-base">Grabber Settings</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 pt-0">
          <div className="flex items-center gap-4">
            <Label htmlFor="interval" className="text-sm whitespace-nowrap">Check Interval</Label>
            <Input 
              id="interval" 
              type="number" 
              min="1"
              value={formData.checkInterval}
              onChange={(e) => setFormData({ ...formData, checkInterval: parseInt(e.target.value) || 15 })}
              className="bg-background/50 rounded-none border-input w-20 font-mono h-8 text-sm"
              data-testid="input-check-interval"
            />
            <span className="text-xs text-muted-foreground">minutes</span>
            <Button 
              onClick={handleSave} 
              size="sm"
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-none ml-auto h-8"
              disabled={updateSettingsMutation.isPending}
              data-testid="button-save-settings"
            >
              <Save className="mr-1.5 h-3 w-3" />
              {updateSettingsMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-red-500/5 border-red-500/30 rounded-none">
        <CardHeader className="py-3 px-4">
          <CardTitle className="font-display text-base text-red-500">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 pt-0 space-y-2">
          <div className="flex items-center justify-between p-3 border border-red-500/20 bg-red-500/5">
            <div>
              <h4 className="font-semibold text-foreground text-sm">Clear Entries</h4>
              <p className="text-xs text-muted-foreground">Reset logs, stats, and processed URLs</p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button 
                  variant="outline" 
                  size="sm"
                  className="border-red-500/50 text-red-500 hover:bg-red-500/10 rounded-none h-8"
                  disabled={clearEntriesMutation.isPending}
                  data-testid="button-clear-entries"
                >
                  <Trash2 className="mr-1.5 h-3 w-3" />
                  {clearEntriesMutation.isPending ? "Clearing..." : "Clear"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="rounded-none border-border bg-card">
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear All Entries?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will delete all logs, reset statistics, and clear processed URLs. Feeds and settings are kept.
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

          <div className="flex items-center justify-between p-3 border border-red-500/20 bg-red-500/5">
            <div>
              <h4 className="font-semibold text-foreground text-sm">Reset App</h4>
              <p className="text-xs text-muted-foreground">Wipe all data and start fresh</p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button 
                  variant="destructive" 
                  size="sm"
                  className="rounded-none h-8"
                  disabled={resetAppMutation.isPending}
                  data-testid="button-reset-app"
                >
                  <RotateCcw className="mr-1.5 h-3 w-3" />
                  {resetAppMutation.isPending ? "Resetting..." : "Reset"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="rounded-none border-border bg-card">
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset Entire App?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete ALL data including feeds, logs, and settings. This cannot be undone.
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
